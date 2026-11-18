"""Bounded display metadata only. No argument/result body survives this module."""
import hashlib
import json
import re

ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$')
TARGET = re.compile(r'^[\w.()@+ -]{1,32}$', re.UNICODE)
CATEGORIES = {'read': 'read', 'read_image': 'read', 'glob': 'search', 'grep': 'search',
              'web_search': 'search', 'web_fetch': 'search', 'edit': 'edit', 'write': 'edit',
              'bash': 'command', 'subagent': 'delegate', 'subagent_fork': 'delegate',
              'send_message': 'delegate'}
MAX_ACTIVE = 32
DISPLAY_SUFFIXES = {'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.c', '.cc', '.cpp', '.h', '.hpp', '.java', '.kt', '.swift', '.vue', '.svelte', '.css', '.scss', '.html', '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.ini', '.xml', '.sh', '.sql', '.r', '.rb', '.php', '.lock'}
SENSITIVE = re.compile(r'(?:^|[._ -])env(?:[._ -]|$)|secret|credential|password|passwd|token|private|id_rsa|key|cert|keystore|wallet', re.I)


def display_target(value):
    return bool(TARGET.fullmatch(value) and value not in ('.', '..') and not SENSITIVE.search(value)
                and (('.' in value and '.'+value.rsplit('.', 1)[-1].lower() in DISPLAY_SUFFIXES) or value in ('Dockerfile', 'Makefile')))


def valid_id(value):
    return isinstance(value, str) and ID.fullmatch(value) is not None


NATIVE_CALL_ID = re.compile(r'^[!-~]{1,512}$')
HASH_PREFIX = 'native-sha256-'


def native_call_id(value, session_id=''):
    """Map bounded opaque native identity to wire identity, never truncate it.

    Reserve the hash prefix so a raw simple ID cannot impersonate a hashed ID.
    Length-framed JSON plus session identity prevents cross-session aliasing.
    """
    if not isinstance(value, str) or NATIVE_CALL_ID.fullmatch(value) is None:
        return None
    if valid_id(value) and not value.startswith(HASH_PREFIX):
        return value
    scope = json.dumps([session_id, value], ensure_ascii=True, separators=(',', ':')).encode('ascii')
    return HASH_PREFIX + hashlib.sha256(scope).hexdigest()


def call_metadata(data, args, session_id=''):
    name, call_id = data.get('name'), native_call_id(data.get('callId'), session_id)
    if call_id is None or not isinstance(name, str) or len(name) > 200:
        return None
    category = CATEGORIES.get(name, 'other')
    target = ''
    # Search query, URLs, commands and generic MCP arguments are never labels.
    if name in ('read', 'read_image', 'write', 'edit'):
        value = args.get('file_path')
        if isinstance(value, str) and len(value) <= 4096:
            basename = value.replace('\\', '/').rsplit('/', 1)[-1]
            if display_target(basename):
                target = basename
    return dict(callId=call_id, category=category, target=target)


def summarize(events):
    """Collapse replay/duplicates; terminal IDs never reopen in the same session."""
    calls, results, invalid = {}, {}, False
    for e in events:
        d, seq, at = e['data'], e['seq'], e['time']
        if type(seq) is not int or not 0 <= seq <= 9007199254740991:
            invalid = True
            continue
        if not isinstance(at, (int, float)) or isinstance(at, bool) or not 0 <= at <= 253402300799000:
            continue
        if e['type'] == 'tool/call' and d.get('tool'):
            c = d['tool']
            old = calls.get(c['callId'])
            if old is None or seq < old['sequence']:
                calls[c['callId']] = dict(**c, sequence=seq, startedAt=at, timestamp=at, state='started')
        elif e['type'] == 'tool/result':
            msg = d.get('message') or {}
            cid = msg.get('toolCallId')
            if valid_id(cid) and type(msg.get('isError')) is bool:
                old = results.get(cid)
                if old is None or seq > old[0]:
                    results[cid] = (seq, at, msg['isError'])
            else:
                invalid = True
        elif e['type'] == 'tool/call':
            invalid = True
    for cid, c in calls.items():
        if cid in results:
            seq, at, error = results[cid]
            c.update(sequence=max(c['sequence'], seq), timestamp=max(c['startedAt'], at), state='error' if error else 'ended')
    active = [c for c in calls.values() if c['state'] == 'started']
    if invalid or len(active) > MAX_ACTIVE:
        return [], True
    recent = sorted((c for c in calls.values() if c['state'] != 'started'), key=lambda c: (c['timestamp'], c['sequence']))[-4:]
    return sorted(active, key=lambda c: c['sequence']) + recent, False


def attach(project, sessions, pm_sources, now, ttl, *, pm_session_id=None, pm_turn_start=None):
    """Overlay activity onto confirmed existing actors, never establish a role."""
    by_id = {s['header']['id']: s for s in sessions if not s.get('sourceKey')}
    pm_by_key={s.get('sourceKey',s['header']['id']):s for s in sessions}
    for actor in project['actors'] + ([project['recordingActor']] if project.get('recordingActor') else []):
        cli_activity = actor.pop('toolActivity', None)
        binding = actor.pop('_activityBinding', None)
        if not actor.get('active') or actor.get('uncertain'):
            continue
        declared_pm = actor['id']=='pm' and cli_activity and any(s['header']['id']==cli_activity['sessionId'] and s.get('sourceKey',s['header']['id']) in pm_sources and s['header'].get('source') in ('external-declared','official-codex-journal','official-claude-journal') for s in sessions)
        if cli_activity and (actor['id'] != 'pm' or declared_pm):
            if actor['motion']=='testing':
                for call in cli_activity['calls']:
                    if call['category']=='command': call['category']='test'
            actor['toolActivity'] = cli_activity
            continue
        if actor['id'] == 'pm':
            # Discovery selects this from the same fresh/open trusted PM
            # lifecycle that drives the body, never from the registry owner.
            sid = pm_session_id
            if sid not in pm_sources or pm_turn_start is None:
                continue
            start, end = pm_turn_start, None
        else:
            if not binding:
                continue
            sid, start, end = binding['sessionId'], binding['start'], binding['end']
        s = pm_by_key.get(sid) if actor['id']=='pm' else by_id.get(sid)
        if not s:
            continue
        if actor['id'] == 'pm' and (s['header'].get('depth') != 0 or s['header'].get('subagent')):
            continue
        envelope = dict(version=1, projectId=project['id'], actorId=actor['id'], sessionId=sid, runningCount=0, thinking=False, calls=[])
        if s.get('toolOverflow') or s.get('activitySourceInvalid') or (binding and binding.get('ambiguous')):
            actor['toolActivity'] = dict(**envelope, suppressed=True)
            continue
        # Assignment ownership is fixed by start time. A result may arrive in a
        # later assignment without moving the original call to that new role.
        def owns(at):
            return start <= at and (at <= now if end is None else at < end)
        activity = sorted((e for e in s['activity'] if e['at'] <= now), key=lambda e: e['at'])
        turn, step, heartbeat, opened = None, None, 0, False
        for e in activity:
            if e['type'] == 'turn/start':
                turn, opened, step, heartbeat = e['turn'], True, None, e['at']
            elif e['type'] == 'turn/end' and e['turn'] in (None, turn):
                opened, step = False, None
            elif opened and e['turn'] == turn:
                if e['type'] == 'step/start' and e.get('step') is not None:
                    step, heartbeat = e['step'], e['at']
                elif e['type'] == 'step/end' and e.get('step') == step:
                    step, heartbeat = None, e['at']
        fresh = opened and owns(heartbeat) and owns(now) and 0 <= now-heartbeat <= ttl
        # Explicit lifecycle may remain fresh without a native turn. Tools themselves
        # still need a fresh start; a stale stream never supplies model thinking.
        scoped = [c for c in s.get('tools', []) if owns(c['startedAt']/1000)]
        if any(c['state'] == 'started' and now-c['timestamp']/1000 > ttl for c in scoped):
            actor['toolActivity'] = dict(**envelope, suppressed=True)
            continue
        calls = [dict(c) for c in scoped if c['timestamp'] <= now*1000
                 and 0 <= now-c['timestamp']/1000 <= (ttl if c['state'] == 'started' else 4)]
        running = [c for c in calls if c['state'] == 'started']
        if actor['motion'] == 'testing':
            for c in calls:
                if c['category'] == 'command':
                    c['category'] = 'test'
        selected = sorted(running, key=lambda c: (c['timestamp'], c['sequence']))[-8:]
        selected += sorted((c for c in calls if c['state'] != 'started'), key=lambda c: (c['timestamp'], c['sequence']))[-4:]
        if valid_id(project['id']) and valid_id(sid):
            actor['toolActivity'] = dict(version=1, projectId=project['id'], actorId=actor['id'], sessionId=sid,
                runningCount=len(running), thinking=bool(fresh and step is not None and not running), calls=selected)
        if actor.get('toolActivity', {}).get('thinking') and actor['motion'] == 'waiting':
            actor['toolActivity']['thinking'] = False


def execution_heartbeat(record, records, sessions, now):
    """Exact running session/window activity may extend read-only observation TTL."""
    candidates=[s for s in sessions if s['header']['id']==record['session_id']]
    if len(candidates)!=1: return None
    s=candidates[0]
    if s.get('toolOverflow') or s.get('activitySourceInvalid'): return None
    related=[r for r in records if r['session_id']==record['session_id']]
    if sum(r['bound_at']==record['bound_at'] for r in related)!=1: return None
    end=min((r['bound_at'] for r in related if r['bound_at']>record['bound_at']),default=None)
    if end is not None and now>=end: return None
    turn=None;opened=False;heartbeat=None
    for e in sorted((e for e in s['activity'] if e['at']<=now),key=lambda e:e['at']):
        if e['type']=='turn/start': turn=e['turn'];opened=True
        elif e['type']=='turn/end' and e['turn'] in (None,turn): opened=False
        elif opened and e['turn']==turn and e['type']=='step/start': heartbeat=e['at']
    if not opened:return None
    timestamps=[c['timestamp']/1000 for c in s.get('tools',[]) if c['startedAt']/1000>=record['bound_at'] and c['timestamp']<=now*1000]
    if heartbeat is not None:timestamps.append(heartbeat)
    latest=max(timestamps,default=0)
    return latest if record['bound_at']<=latest<=now and now-latest<=record['ttl'] else None
