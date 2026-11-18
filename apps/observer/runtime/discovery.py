"""Global DSH metadata-only index. Never traverses a discovered project's tree.

Only successful native skill calls are usage. Product mapping is explicit, not
role inference. Cache contains no messages, tool arguments, commands or results.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import selectors
import stat
import subprocess
import time

from events import MAX_BYTES, arguments, timestamp
from registry import atomic_write
from tool_activity import call_metadata, summarize, attach, valid_id, native_call_id

SHIPBOSS = {'shipboss', 'shipboss'}
# Package installation/name alone is not an observed independent skill call.
# Other successful skill names need no product-alias verification to count.
UNVERIFIED = {'shipboss-dsh-plugin'}
MAX_LINE = 4 * 1024 * 1024


def canonical(name):
    return 'shipboss' if name in SHIPBOSS else name


def cwd_key(value):
    # Lexical only: do not resolve symlinks or stat another project's tree.
    return os.path.normpath(value) if isinstance(value, str) and os.path.isabs(value) else None


def lines(path, timeout=5):
    """Bounded streaming, including a wall deadline while zstd produces output."""
    if path.stat().st_size > MAX_BYTES:
        raise ValueError('compressed/file-size-limit')
    process = None
    if path.suffix == '.zstd':
        process = subprocess.Popen(['zstd', '-dc', str(path)], stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL)
        stream = process.stdout
    else:
        stream = path.open('rb')
    selector = selectors.DefaultSelector()
    total, buffer = 0, b''
    deadline = time.monotonic() + timeout
    try:
        if process:
            selector.register(stream, selectors.EVENT_READ)
        while True:
            remaining = deadline-time.monotonic()
            if remaining <= 0 or (process and not selector.select(remaining)):
                raise ValueError('decode-timeout')
            chunk = os.read(stream.fileno(), 65536)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_BYTES:
                raise ValueError('decoded-size-limit')
            buffer += chunk
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                if len(line) > MAX_LINE:
                    raise ValueError('line-size-limit')
                yield line
            if len(buffer) > MAX_LINE:
                raise ValueError('line-size-limit')
        if buffer:
            yield buffer
        if process and process.wait(timeout=max(.01, deadline-time.monotonic())):
            raise ValueError('decode-failed')
    finally:
        selector.close()
        stream.close()
        if process and process.poll() is None:
            process.kill()
            process.wait()


def extract(path, identity, *, raw_lines=None, parser_state=None, finalize=True):
    header, calls, usages, activity, jobs, questions = None, {}, [], [], {}, {}
    boundary = identity.get('inheritedEventCount')
    events, last_marker, dense, has_marker = [], None, True, False
    event_count = 0
    if parser_state:
        import copy
        state=copy.deepcopy(parser_state)
        header,events,last_marker,dense,has_marker,event_count=(state[k] for k in ('header','events','last_marker','dense','has_marker','event_count'))
    for raw in (lines(path) if raw_lines is None else raw_lines):
        e = json.loads(raw)
        if not isinstance(e, dict):
            raise ValueError('malformed-event')
        kind = e.get('type')
        if not isinstance(kind, str):
            raise ValueError('invalid-native-event-type')
        if kind == 'session':
            if header is not None or event_count:
                raise ValueError('duplicate/late-header')
            cwd = cwd_key(e.get('cwd'))
            if not cwd or not isinstance(e.get('id'), str):
                raise ValueError('invalid-header')
            if identity.get('cwd') and cwd != cwd_key(identity['cwd']):
                raise ValueError('identity-header-mismatch')
            if identity.get('isSeeded') is not None and identity['isSeeded'] is not (e.get('isSeeded') is True):
                raise ValueError('seed-boundary:identity-header-mismatch')
            header = dict(id=e['id'], cwd=cwd, parent=e.get('parentSession'), seeded=e.get('isSeeded') is True,
                          depth=e.get('delegationDepth') if type(e.get('delegationDepth')) is int and e['delegationDepth'] >= 0 else None,
                          subagent=False)
            continue
        if header is None:
            raise ValueError('missing-header')
        seq, d = e.get('seq'), e.get('data')
        dense &= type(seq) is int and seq == event_count
        event_count += 1
        if not isinstance(d, dict):
            if kind in ('tool/call', 'tool/result', 'user/message', 'turn/start', 'turn/end',
                        'step/start', 'step/end', 'job/registered', 'job/started', 'job/settled', 'subagent/descriptor'):
                raise ValueError('malformed-native-event-data')
            continue
        if kind == 'session/end-seed' and d.get('inherited') is True:
            last_marker = seq
            has_marker = True
        # Retain only fields needed below, never user content or result bodies.
        if kind == 'subagent/descriptor' and (not d or d.get('inherited') is True):
            continue
        if kind in ('tool/call', 'tool/result', 'user/message', 'turn/start', 'turn/end',
                    'step/start', 'step/end', 'job/registered', 'job/started', 'job/settled', 'subagent/descriptor'):
            clean = {k: d[k] for k in ('source', 'role', 'turn', 'step', 'jobId', 'owner') if k in d}
            if isinstance(clean.get('source'),dict):
                clean['source']={k:(v if v is None or isinstance(v,(int,bool)) or isinstance(v,str) and len(v)<=160 else None) for k,v in clean['source'].items() if k in ('sessionId','kind','form','name')}
            if 'source' in clean and not isinstance(clean['source'],dict): clean['source']=False
            for key in ('owner','jobId','role'):
                if key in clean and clean[key] is not None and not (isinstance(clean[key],str) and len(clean[key])<=160): clean[key]=False
            for key in ('turn', 'step'):
                value = clean.get(key)
                if value is not None and not (valid_id(value) or (type(value) is int and 0 <= value <= 9007199254740991)):
                    raise ValueError('invalid-native-activity-key')
            if kind == 'tool/call':
                clean['tool'] = call_metadata(d, arguments(d.get('arguments')), header['id'])
            if kind == 'tool/call' and d.get('name') in ('skill', 'ask_user_question'):
                clean.update(name=d['name'], callId=native_call_id(d.get('callId'), header['id']))
                args = arguments(d.get('arguments'))
                clean['arguments'] = ({'name': args.get('name')} if d['name'] == 'skill' else
                                      {'questions': []} if isinstance(args.get('questions'), list) else {})
            if kind == 'tool/result' and isinstance(d.get('message'), dict):
                clean['message'] = dict(toolCallId=native_call_id(d['message'].get('toolCallId'), header['id']),
                                        isError=d['message'].get('isError'))
            events.append(dict(type=kind, seq=seq, time=e.get('time'), data=clean))
            if len(events) > 100000:
                raise ValueError('metadata-count-limit')
    if not finalize:
        return dict(header=header,events=events,last_marker=last_marker,dense=dense,has_marker=has_marker,event_count=event_count)
    # Only EOF certifies the final true marker. Empty restore markers do not cut.
    if header is None:
        raise ValueError('missing-header')
    if boundary is not None and (type(boundary) is not int or boundary < 0):
        raise ValueError('seed-boundary:invalid-index-cut')
    if header['seeded']:
        if not dense or type(last_marker) is not int or (boundary is not None and boundary != last_marker):
            raise ValueError('seed-boundary:missing/conflicting-final-marker')
        cut = last_marker
    else:
        if boundary not in (None, 0) or has_marker:
            raise ValueError('seed-boundary:unseeded-inherited-events')
        cut = -1
    tool_events, activity_source_invalid = [], False
    for e in events:
        seq, kind, d = e['seq'], e['type'], e['data']
        if cut >= 0 and (type(seq) is not int or seq <= cut):
            continue
        d = e['data']
        # Identity descriptors need a valid local event boundary, not a turn clock.
        source = d.get('source')
        # Missing source is the native local envelope. Explicit source must be
        # an object; an explicit sessionId must identify this exact session.
        source_valid = ('source' not in d or (isinstance(source, dict) and
                        ('sessionId' not in source or (valid_id(source['sessionId']) and source['sessionId'] == header['id']))))
        if not source_valid:
            if kind in ('tool/call', 'tool/result', 'turn/start', 'turn/end', 'step/start', 'step/end'):
                activity_source_invalid = True
            continue
        if kind in ('tool/call', 'tool/result') and d.get('owner') not in (None, header['id']):
            continue
        if kind == 'subagent/descriptor':
            header['subagent'] = True
            continue
        at = timestamp(e.get('time'), milliseconds=True)
        if at is None or not 0 <= at <= 253402300799:
            raise ValueError('invalid-native-event-time')
        if kind in ('tool/call', 'tool/result'):
            tool_events.append(e)
        if (kind == 'user/message' and isinstance(source, dict)
                and source.get('kind') == 'skill-invocation' and source.get('form') == 'instructions'):
            name = source.get('name')
            if isinstance(name, str) and 0 < len(name) <= 160 and name not in UNVERIFIED:
                usages.append(dict(name=canonical(name), seq=seq, at=at))
        elif kind == 'tool/call' and d.get('name') == 'skill':
            name = arguments(d.get('arguments')).get('name')
            if isinstance(name, str) and 0 < len(name) <= 160 and isinstance(d.get('callId'), str):
                calls[d['callId']] = dict(name=canonical(name), seq=seq, at=at)
        elif kind == 'tool/call' and d.get('name') == 'ask_user_question' and isinstance(d.get('callId'), str):
            if isinstance(arguments(d.get('arguments')).get('questions'), list):
                questions[d['callId']] = dict(id=d['callId'], at=at)
                activity.append(dict(type='question', at=at, turn=d.get('turn')))
        elif kind == 'user/message' and d.get('role') == 'user' and isinstance(source, dict) and source.get('kind') == 'user':
            questions.clear()
            activity.append(dict(type='human', at=at, turn=None))
        elif kind == 'tool/result':
            msg = d.get('message')
            if isinstance(msg, dict):
                questions.pop(msg.get('toolCallId'), None)
                call = calls.pop(msg.get('toolCallId'), None)
                if call and msg.get('isError') is False and call['name'] not in UNVERIFIED:
                    usages.append(call)
        if kind in ('turn/start', 'turn/end', 'step/start', 'step/end'):
            activity.append(dict(type=kind, at=at, turn=d.get('turn'), step=d.get('step')))
        elif kind in ('job/registered', 'job/started', 'job/settled') and isinstance(d.get('jobId'), str):
            if d.get('owner') in (None, header['id']):
                jobs[d['jobId']] = dict(type=kind, at=at, ownerVerified=d.get('owner') == header['id'])
    if header is None:
        raise ValueError('missing-header')
    # Bound persisted metadata even for extreme inputs. No silent truncation.
    if len(usages) + len(activity) + len(jobs) > 100000:
        raise ValueError('metadata-count-limit')
    tools, overflow = summarize(tool_events)
    return dict(header=header, usages=usages, activity=activity, tools=[] if activity_source_invalid else tools,
                toolOverflow=overflow, activitySourceInvalid=activity_source_invalid,
                jobs=list(jobs.values()), questions=list(questions.values()))


def discovered_registry(cwd, owners, now, sessions=()):
    """Read only this activated cwd's exact registry, never a session_file/tree.

    Directory-relative no-follow opens also reject symlink redirection. No lock,
    mkdir, update or event replay is performed on an observed external project.
    """
    from observer_state import build_project
    descriptors = []
    try:
        directory = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        descriptors.append(os.open(cwd, directory))
        for component in ('.delegate', 'observer'):
            descriptors.append(os.open(component, directory, dir_fd=descriptors[-1]))
        fd = os.open('runtime.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptors[-1])
        descriptors.append(fd)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('registry-not-regular')
        limit = 4 * 1024 * 1024
        with os.fdopen(os.dup(fd), 'rb') as stream:
            raw = stream.read(limit+1)
        if len(raw) > limit:
            raise ValueError('registry-size-limit')
        data = json.loads(raw)
        if not isinstance(data, dict) or data.get('version') != 1 or data.get('project') != cwd:
            raise ValueError('registry-project/version-mismatch')
        if data.get('active') is not True:
            return None
        if data.get('owner_session') not in {s['header']['id'] for s in owners
                if any(u['name'] == 'shipboss' and u['at'] <= now for u in s['usages'])}:
            raise ValueError('registry-owner-without-same-project-activation')
        from registry import ROLES, STATES, PHASES
        if not isinstance(data.get('assignments'), dict):
            raise ValueError('registry-assignments-invalid')
        for key, record in data['assignments'].items():
            if (not isinstance(record, dict) or key != record.get('assignment')
                    or record.get('slot') not in ROLES or ROLES[record['slot']] != record.get('role')
                    or record.get('state') not in STATES or record.get('phase') not in PHASES):
                raise ValueError('registry-role/lifecycle-invalid')
        return build_project(cwd, now=now, registry_data=data, native_sessions=sessions)
    except FileNotFoundError:
        return None
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


MAX_CONTINUATION_DEPTH = 64


def continuation_activations(sessions, now):
    """Certify native main parent chains without copying any ancestor events.

    extract already certifies seeded EOF boundaries. Failed/pending cache entries
    and external receipts cannot supply a native identity or activation anchor.
    """
    by_id = {}
    for s in sessions:
        by_id.setdefault(s['header']['id'], []).append(s)

    def trusted(s):
        h = s['header']
        return (not s.get('sourceKey') and not h.get('source') and
                not s.get('activationUntrusted') and h.get('depth') == 0 and
                h.get('subagent') is False)

    inherited = {}
    for s in sessions:
        h = s['header']
        # The successor itself must be unique, just like every ancestor.
        # Never select a same-ID source by file order, cwd or receipt kind.
        if (len(by_id[h['id']]) != 1 or not trusted(s) or
                h.get('seeded') is not True or not h.get('parent')):
            continue
        current, chain, seen = s, [], {h['id']}
        for _ in range(MAX_CONTINUATION_DEPTH):
            ch = current['header']
            if ch.get('seeded') is not True or not valid_id(ch.get('parent')):
                break
            parents = by_id.get(ch['parent'], [])
            if len(parents) != 1:
                break
            parent = parents[0]
            ph = parent['header']
            if ph['id'] in seen or ph['cwd'] != h['cwd'] or not trusted(parent):
                break
            seen.add(ph['id'])
            chain.append(ph['id'])
            if not ph.get('parent'):
                if (ph.get('seeded') is False and
                        any(u['name'] == 'shipboss' and u['at'] <= now for u in parent['usages'])):
                    inherited[h['id']] = dict(inheritedActivationFrom=h['parent'],
                        rootActivationSession=ph['id'], ancestorSessionIds=chain)
                break
            current = parent
    return inherited


class DiscoveryIndex:
    def __init__(self, dsh_home, index_path, *, budget_seconds=8, max_files=32,
                 exclude=('ExcludedProject',), activation_receipts=None):
        self.activation_receipts = activation_receipts
        self.exclude = set(exclude)
        self.excluded_count = 0
        self.home, self.path = Path(dsh_home).expanduser(), Path(index_path)
        self.budget, self.max_files, self.loads = budget_seconds, max_files, 0
        from events import EventReader
        self.reader = EventReader()
        self.identity_cache = {}
        from incremental import IncrementalNative
        self.incremental = IncrementalNative()
        try:
            self.data = json.loads(self.path.read_text())
            if self.data.get('version') != 2 or self.data.get('home') != str(self.home):
                raise ValueError('index-version/home')
        except (OSError, ValueError):
            self.data = dict(version=2, home=str(self.home), files={}, order=[])

    def scan(self):
        self.excluded_count = 0
        start, decoded, seen, warnings = time.monotonic(), 0, set(), []
        # Inventory is DSH-owned identity metadata, not project files.
        identities = {}
        dirty = False
        for p in sorted((self.home/'storages/session_projcache/sessions').glob('*.json')):
            try:
                if p.is_symlink() or p.stat().st_size > 256*1024:
                    raise ValueError('identity-size/symlink')
                st = p.stat()
                sig = (st.st_dev, st.st_ino, st.st_mtime_ns, st.st_size)
                cached = self.identity_cache.get(str(p))
                if cached and cached[0] == sig:
                    identity = cached[1]
                else:
                    identity = json.loads(p.read_text()).get('record', {}).get('identity', {})
                    if not isinstance(identity, dict):
                        raise ValueError('invalid-identity')
                    self.identity_cache[str(p)] = (sig, identity)
                identities[p.stem] = identity
            except (OSError, ValueError, AttributeError):
                warnings.append('invalid-session-identity:' + p.stem)
        files = self.data['files']
        candidates = sorted((self.home/'sessions').glob('*/*/session*.jsonl*'))
        # Unchanged or previously failed signatures are not decompressed again.
        for p in candidates:
            key = str(p.relative_to(self.home))
            identity = identities.get(p.parent.name, {})
            old_cwd = files.get(key, {}).get('metadata', {}).get('header', {}).get('cwd')
            encoded = p.parent.parent.name
            if (self.is_excluded(identity.get('cwd')) or self.is_excluded(old_cwd)
                    or any(encoded.endswith('-'+Path(name).name+'--') for name in self.exclude)):
                self.excluded_count += 1
                continue
            seen.add(key)
            try:
                if p.is_symlink() or not p.resolve().is_relative_to(self.home.resolve()):
                    raise ValueError('session-symlink/outside-home')
                st = p.stat()
                identity = identities.get(p.parent.name, {})
                signature = [st.st_dev, st.st_ino, st.st_mtime_ns, st.st_size,
                             identity.get('inheritedEventCount'), identity.get('cwd'), identity.get('isSeeded'), 'roles-v4-incremental-native']
                old = files.get(key)
                if old and old['signature'] == signature and not old.get('pending'):
                    continue
                if decoded >= self.max_files or time.monotonic()-start > self.budget:
                    warnings.append('scan-budget:pending-files')
                    continue
                decoded += 1; self.loads += 1; dirty = True
                try:
                    checkpoint=None
                    incremental = st.st_size>MAX_BYTES and MAX_BYTES==64*1024*1024 or str(p) in self.incremental.live or bool(old and old.get('incrementalRequired'))
                    if not incremental:
                        try:
                            metadata=extract(p,identity)
                        except ValueError as exc:
                            if str(exc)=='decoded-size-limit' and MAX_BYTES==64*1024*1024:
                                from incremental import PendingNative
                                raise PendingNative('incremental-cold-scan-pending:oversized-compressed-detected')
                            else: raise
                    if incremental:
                        metadata,checkpoint = self.incremental.parse(p,identity,old,seconds=min(1.5,max(.05,self.budget-(time.monotonic()-start))))
                    if metadata['header']['id'] != p.parent.name:
                        raise ValueError('directory-header-session-mismatch')
                    if checkpoint and checkpoint.get('snapshotSignature'):
                        signature=checkpoint['snapshotSignature']+[signature[-1]]
                    files[key] = dict(signature=signature, metadata=metadata, checkpoint=checkpoint)
                except (OSError, ValueError, subprocess.SubprocessError) as exc:
                    from incremental import PendingNative
                    if isinstance(exc,PendingNative):
                        files[key]=dict(signature=signature,error=str(exc),pending=True,incrementalRequired=True)
                        if old and old.get('metadata') and old['signature'][:2]==signature[:2] and old['signature'][4:]==signature[4:]:
                            files[key]['metadata']={**old['metadata'],'activity':[],'tools':[],'questions':[],'jobs':[],'toolOverflow':True}
                        continue
                    files[key] = dict(signature=signature, error=type(exc).__name__ + ':' + str(exc)[:100])
                    if (old and old.get('metadata') and old['signature'][:2] == signature[:2] and old['signature'][-1] == 'roles-v4-incremental-native'
                            and 'seed-boundary:' not in str(exc)):
                        # Retain proven historical usage, never stale activity as live.
                        files[key]['metadata'] = {**old['metadata'], 'activity': [], 'questions': [], 'jobs': [], 'tools': [], 'toolOverflow': True}
            except (OSError, ValueError) as exc:
                warnings.append('unreadable-session:' + key + ':' + type(exc).__name__)
        dirty |= any(k not in seen for k in files)
        files = self.data['files'] = {k: v for k, v in files.items() if k in seen}
        for key, entry in files.items():
            if entry.get('error'):
                warnings.append(key + ':' + entry['error'])
        sessions = [dict(v['metadata'], activationUntrusted=True) if v.get('error') or v.get('pending')
                    else v['metadata'] for v in files.values() if 'metadata' in v]
        from onboarding import external_sessions
        from external_journal import OfficialJournalReader
        self.presentation_requests=[]
        external_cache=self.data.setdefault('externalJournals',{})
        previous_external=json.dumps(external_cache,sort_keys=True)
        external=external_sessions(self.activation_receipts,now=getattr(self,'build_now',time.time()),reader=OfficialJournalReader(external_cache),requests=self.presentation_requests,warnings=warnings,excluded=self.exclude,freshness_seconds=getattr(self,'build_idle_seconds',300))
        sessions += external
        active_external_keys={s['sourceKey'] for s in external}
        for key in list(external_cache):
            if key not in active_external_keys:external_cache.pop(key,None)
        dirty |= previous_external!=json.dumps(external_cache,sort_keys=True)
        activated={s['header']['cwd'] for s in sessions if any(u['name']=='shipboss' for u in s['usages'])}
        projects=sorted(activated,key=lambda cwd:(min(u['at'] for s in sessions if s['header']['cwd']==cwd for u in s['usages'] if u['name']=='shipboss'),cwd))
        order = self.data['order']
        kept_order = [cwd for cwd in order if not self.is_excluded(cwd)]
        if kept_order != order:
            order = self.data['order'] = kept_order
            dirty = True
        for cwd in projects:
            if cwd not in order:
                order.append(cwd)
                dirty = True
        if dirty:
            atomic_write(self.path, self.data)
        if self.excluded_count:
            warnings.append('excluded-project-logs:'+str(self.excluded_count))
        return sessions, [p for p in order if p in projects], sorted(set(warnings))

    def is_excluded(self, cwd):
        cwd = cwd_key(cwd)
        return bool(cwd and (cwd in self.exclude or Path(cwd).name in self.exclude))

    def build(self, *, now=None, idle_seconds=300, explicit_roots=()):
        from observer_state import build_project, NAMES
        from registry import ROLES
        now = time.time() if now is None else now
        self.build_now=now
        self.build_idle_seconds=idle_seconds
        sessions, order, warnings = self.scan()
        inherited = continuation_activations(sessions, now)
        # A handoff retires only pre-handoff ancestor activity. A parent can
        # still open a later real turn/question/job as an independent PM source.
        handoffs = {}
        for s in sessions:
            proof = inherited.get(s['header']['id'])
            starts = [e['at'] for e in s['activity'] if e['type'] == 'turn/start' and e['at'] <= now]
            if proof and starts:
                for ancestor in proof['ancestorSessionIds']:
                    handoffs[ancestor] = max(handoffs.get(ancestor, 0), min(starts))
        explicit = {}
        for root in explicit_roots:
            if self.is_excluded(str(root)):
                continue
            p = build_project(root, reader=self.reader, auto=True, now=now)
            if p:
                explicit[cwd_key(str(root))] = p
        projects = []
        today = datetime.fromtimestamp(now).date()
        for cwd in order:
            if self.is_excluded(cwd):
                continue
            group = [s for s in sessions if s['header']['cwd'] == cwd]
            owners = [s for s in group if s['header']['id'] in inherited or
                      any(u['name'] == 'shipboss' for u in s['usages'])]
            overlay = explicit.get(cwd)
            if overlay is None and not self.is_excluded(cwd):
                try:
                    overlay = discovered_registry(cwd, owners, now, group)
                except (OSError, ValueError, KeyError, TypeError, AttributeError, OverflowError) as exc:
                    warnings.append('registry-overlay:'+Path(cwd).name+':'+type(exc).__name__+':'+str(exc)[:100])
            actors = [dict(id=k, role=ROLES[k], name=v, active=False, taskId=None,
                           motion='idle', uncertain=True, activity='unknown: no registered execution', papers=0) for k, v in NAMES.items()]
            p = overlay or dict(id='p-'+hashlib.sha256(cwd.encode()).hexdigest()[:20],
                name=Path(cwd).name, source='DSH metadata-only discovery', status='dispatching',
                activity='unknown: historical activation; no fresh PM source', actors=actors,
                tasks=[], reports=[], needsAttention=False, awaitingUser=False, recording=False,
                engineerCount=0, verifierCount=0, counts={}, events=[], simulated=False)
            if cwd in explicit and p.get('ownerSessionId') not in {s['header']['id'] for s in owners}:
                p['actors'][0].update(active=False, motion='idle', activity='unknown: registry owner has no confirmed Shipboss activation')
                p.update(needsAttention=False, awaitingUser=False, pendingQuestion=None)
            skills = {u['name'] for s in group for u in s['usages']
                      if u['name'] != 'shipboss' and u['at'] <= now and datetime.fromtimestamp(u['at']).date() == today}
            # A child can load the protocol while acting as an engineer/reviewer.
            # Usage establishes project membership, not authority to occupy the PM desk.
            def pm_capable(s):
                h = s['header']
                if h.get('subagent') or (h.get('depth') is not None and h['depth'] > 0):
                    return False
                return h.get('depth') == 0 or not h.get('parent') or h['id'] == p.get('ownerSessionId')
            pm_sources = {s.get('sourceKey',s['header']['id']) for s in owners if pm_capable(s)}
            owner_metadata = next((s for s in owners if s['header']['id'] == p.get('ownerSessionId')), None)
            if owner_metadata and not pm_capable(owner_metadata):
                p['actors'][0].update(active=False, uncertain=True, motion='idle', activity='状态未知/暂停：registry owner is a native child, not PM')
                p.update(needsAttention=False, awaitingUser=False, pendingQuestion=None)
            owner_ids = {s.get('sourceKey',s['header']['id']) for s in owners}
            last = 0; running = False; ended_fresh = False; ended = False
            unresolved = False; background_fresh = False
            current_pm = []
            for s in group:
                sid = s.get('sourceKey',s['header']['id'])
                is_pm = sid in pm_sources
                # Native parent/depth/descriptor links, not labels or user text.
                child = (s['header'].get('parent') in pm_sources and
                         (s['header'].get('subagent') or (s['header'].get('depth') or 0) > 0))
                activity = sorted((e for e in s['activity'] if handoffs.get(sid, 0) <= e['at'] <= now), key=lambda e: e['at'])
                turn, opened, heartbeat, ended_at, opened_at = None, False, 0, 0, 0
                for e in activity:
                    if sid in owner_ids:
                        last = max(last, e['at'])
                    if e['type'] == 'turn/start':
                        turn, opened, heartbeat, opened_at = e['turn'], True, e['at'], e['at']
                    elif e['type'] == 'turn/end' and turn in (None, e['turn']):
                        opened = False
                        ended_at = e['at']
                    elif opened and e['turn'] == turn:
                        heartbeat = e['at']
                if sid in owner_ids:
                    last = max(last, *(u['at'] for u in s['usages'] if u['at'] <= now), 0)
                active_turn = opened and 0 <= now-heartbeat <= idle_seconds
                if is_pm:
                    ended |= ended_at > 0 and not opened
                    ended_fresh |= ended_at > 0 and not opened and 0 <= now-ended_at <= idle_seconds
                    running |= active_turn
                    if active_turn:
                        current_pm.append((heartbeat, opened_at, sid))
                elif opened:
                    unresolved = True
                    if child and active_turn:
                        background_fresh = True
                        last = max(last, heartbeat)
                for j in s['jobs']:
                    if handoffs.get(sid, 0) <= j['at'] <= now and j['type'] != 'job/settled':
                        unresolved = True
                        if j.get('ownerVerified') is True and (is_pm or child) and 0 <= now-j['at'] <= idle_seconds:
                            background_fresh = True
                            last = max(last, j['at'])
            registered_background = any(a['active'] and not a.get('uncertain') for a in p['actors'][1:]) or (p.get('recording') and not p.get('recordingUncertain'))
            background_fresh |= registered_background
            last = max(last, p.get('lastActivityEpoch', 0))
            if running:
                p['actors'][0].update(active=True, uncertain=False, motion='working', activity='fresh activated PM session')
                if cwd not in explicit or p['status'] in ('idle', 'dispatching'):
                    p['status'] = 'implementing'
                p['activity'] = 'fresh activated PM session; ' + p['activity']
            elif ended and background_fresh:
                waiting_activity = 'PM waiting for fresh background callback; PM turn ended' + ('; registered execution' if registered_background else '; worker roles unknown')
                p['actors'][0].update(active=True, uncertain=False, motion='waiting', activity=waiting_activity)
                if not registered_background:
                    p['status'] = 'dispatching'
                p['activity'] = waiting_activity + '; ' + p['activity']
            elif ended:
                p['actors'][0].update(active=False, uncertain=False, motion='idle', activity='owner turn ended; not project done')
                if not any(a['active'] for a in p['actors']) and not p.get('recording'):
                    p['status'] = 'dispatching' if unresolved else 'idle'
                    p['activity'] = 'unknown: stale/unconfirmed background execution; PM turn ended' if unresolved else 'activated PM turn ended; not project done'
            elif unresolved and not running and not any(a['active'] for a in p['actors']):
                p['status'] = 'dispatching'
                p['activity'] = 'unknown: unregistered background execution unresolved'
            idle_for = max(0, now-last) if last else None
            p.update(skillsUsed=len(skills), skillNames=sorted(skills), skillPeriod='今天用过的其它技能',
                skillDay=today.isoformat(), lastActivityAt=datetime.fromtimestamp(last, timezone.utc).isoformat() if last else None,
                idleForSeconds=idle_for, isIdle=not (any(a['active'] and not a.get('uncertain') for a in p['actors']) or (p.get('recording') and not p.get('recordingUncertain'))) and (idle_for is None or idle_for >= idle_seconds),
                sessionIds=[s['header']['id'] for s in owners],
                activationProvenance={s['header']['id']: inherited[s['header']['id']]
                                      for s in owners if s['header']['id'] in inherited},
                observation=dict(status='live' if not unresolved and (running or ended_fresh or any(a['active'] for a in p['actors'])) else 'unknown',
                                 reason='; '.join(warnings) if warnings else 'metadata-only; roles require explicit registry'),
                source=p['source']+'; 今天用过的其它技能; '+str(len(owners))+' activated sessions')
            pending = [(s['header']['id'], q) for s in owners for q in s.get('questions', [])
                       if s.get('sourceKey',s['header']['id']) in pm_sources and
                       q['at'] >= handoffs.get(s['header']['id'], 0) and 0 <= now-q['at'] <= 900]
            if pending and not p.get('pendingQuestion'):
                sid, q = max(pending, key=lambda item: item[1]['at'])
                p.update(status='needs-human', needsAttention=True, awaitingUser=True,
                         pendingQuestion=dict(id=q['id'], sessionId=sid, question='该项目有待回答的用户问题（DSH 元数据）'))
                p['actors'][0].update(active=True, uncertain=False, motion='waiting', activity='owner session question pending')
            # Pick from the exact fresh/open PM lifecycles used for presence.
            # Latest matching heartbeat, then turn start, then lexical session ID
            # makes ties independent of discovery/list order. Registry ownership
            # and worker assignment bindings remain unchanged.
            representative = max(current_pm, default=None)
            attach(p, group, pm_sources, now, idle_seconds,
                   pm_session_id=representative[2] if representative else None,
                   pm_turn_start=representative[1] if representative else None)
            if any(a['active'] and not a.get('uncertain') for a in p['actors']) or (p.get('recording') and not p.get('recordingUncertain')):
                p['isIdle'] = False
            if p['actors'][0].get('uncertain'):
                p['actors'][0]['activity'] = '状态未知/暂停：PM lifecycle unconfirmed'
            if warnings:
                p['activity'] += '; coverage incomplete: '+str(len(warnings))+' metadata warnings'
            if len(skills) > 256:
                p['activity'] += '; 箱数 '+str(len(skills))+'，仅显示前256箱（渲染保护）'
            projects.append(p)
        # Bound the added activity payload independently of historical room order.
        remaining = 64 * 1024
        for project in projects:
            for actor in project['actors'] + ([project['recordingActor']] if project.get('recordingActor') else []):
                value = actor.get('toolActivity')
                if value:
                    size = len(json.dumps(value, ensure_ascii=False).encode())
                    if size > remaining:
                        value.update(calls=[], runningCount=0, thinking=False, suppressed=True)
                    else:
                        remaining -= size
        return dict(version=1,presentation=dict(requests=sorted({r['id']:r for r in getattr(self,'presentation_requests',[])}.values(),key=lambda r:(r['at'],r['id']))[-32:]), generatedAt=datetime.fromtimestamp(now, timezone.utc).isoformat(),
                    source='global-dsh-metadata; excluded_count='+str(self.excluded_count), coverage=dict(warnings=warnings, sessions=len(sessions),
                    projects=len(projects), excluded_count=self.excluded_count, complete=not warnings), projects=projects)
