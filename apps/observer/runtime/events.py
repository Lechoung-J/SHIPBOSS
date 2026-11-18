"""Owner-file lifecycle adapter. Native v4 and legacy synthetic envelopes only.

Roles come exclusively from the registry. Commands, labels, result content and
assistant text are never interpreted or retained in the metadata cache.
"""
from datetime import datetime
import json
import math
import re
from pathlib import Path
import subprocess

from registry import TERMINAL, validate_session_file

MAX_BYTES = 64 * 1024 * 1024
LIFECYCLE = {'job/started', 'job/registered', 'agent/started', 'job/settled', 'agent/settled',
             'turn/started', 'turn/completed', 'turn/start', 'turn/end', 'step/start', 'step/end',
             'question/asked', 'question/answered', 'user/message'}


def timestamp(value, milliseconds=False):
    try:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            value = float(value)
            return value / 1000 if math.isfinite(value) and (milliseconds or value > 1e11) else value if math.isfinite(value) else None
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (ValueError, TypeError, AttributeError, OverflowError):
        return None


def safe_question(value):
    value = re.sub(r"(?i)(?:apikey_[a-z0-9_-]+|sk-[a-z0-9_-]{6,}|gh[pousr]_[a-z0-9_-]+)", "[REDACTED]", str(value))
    return re.sub(r"/(?:Users|home)/[^/\s]+", "/[USER]", value)[:500]


def arguments(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return {}
    return value if isinstance(value, dict) else {}


class EventReader:
    def __init__(self):
        self.cache = {}
        self.loads = 0

    def read(self, path):
        path = Path(path)
        stat = path.stat()
        key = (str(path), stat.st_mtime_ns, stat.st_size)
        if key in self.cache:
            return self.cache[key]
        # Same bounded streaming decoder/deadline as global discovery. Imported
        # here to avoid the metadata extractor's timestamp import cycle.
        from discovery import lines
        events, diagnostics = [], set()
        for line in lines(path):
            try:
                e = json.loads(line)
                kind = e.get('type')
                if not isinstance(kind, str):
                    raise ValueError('invalid event type')
                if kind == 'session':
                    events.append(dict(type='session', id=e.get('id'), project=e.get('cwd'),
                                       at=timestamp(e.get('createdAt'), milliseconds=True), native=True))
                    continue
                # Ignore unsupported events before parsing their payload. Tool catalogs aren't usage.
                if kind not in LIFECYCLE | {'tool/call', 'tool/result'}:
                    continue
                d = e.get('data')
                if not isinstance(d, dict):
                    diagnostics.add('malformed owner event')
                    continue
                native = 'time' in e
                at = timestamp(e.get('time') if native else e.get('timestamp'), milliseconds=native)
                if at is None:
                    diagnostics.add('event missing/invalid timestamp')
                    continue
                item = dict(type=kind, at=at, native=native, job_id=d.get('jobId'),
                            agent_id=d.get('agentId'), sessionId=d.get('sessionId'), owner=d.get('owner'))
                if kind in ('job/started', 'job/settled'):
                    item['job_id'] = item['job_id'] or d.get('id')
                if kind in LIFECYCLE:
                    for field in ('exitCode', 'status', 'questionId', 'turn'):
                        item[field] = d.get(field)
                    if kind == 'question/asked':
                        item['question'] = safe_question(d.get('question', ''))
                    if kind == 'user/message':
                        source = d.get('source')
                        item['human'] = (isinstance(source, dict) and source.get('kind') == 'user'
                                         and (not native or d.get('role') == 'user'))
                        # Legacy synthetic messages required explicit owner sessionId.
                        if not native and source is None:
                            item['human'] = bool(d.get('sessionId'))
                    events.append(item)
                elif kind == 'tool/call':
                    if d.get('name') == 'skill':
                        args = arguments(d.get('arguments'))
                        if isinstance(args.get('name'), str):
                            item.update(type='skill/used', name=args['name'][:160])
                            events.append(item)
                    elif d.get('name') == 'ask_user_question' and isinstance(d.get('callId'), str):
                        questions = arguments(d.get('arguments')).get('questions')
                        if isinstance(questions, list):
                            clean = [dict(id=str(q['id'])[:160], question=safe_question(q['question']))
                                     for q in questions[:20] if isinstance(q, dict) and q.get('id')
                                     and isinstance(q.get('question'), str) and q['question'].strip()]
                            if clean:
                                item.update(type='questions/called', call_id=d['callId'], questions=clean)
                                events.append(item)
                elif kind == 'tool/result':
                    message = d.get('message')
                    if isinstance(message, dict) and isinstance(message.get('toolCallId'), str):
                        # Exact call correlation suffices; do not inspect content/ordinary text.
                        item.update(type='question/result', call_id=message['toolCallId'])
                        events.append(item)
            except (ValueError, TypeError, AttributeError):
                diagnostics.add('malformed owner event')
        self.loads += 1
        self.cache = {k: v for k, v in self.cache.items() if k[0] != str(path)}
        # A corrupt/partial owner observation cannot certify its valid prefix.
        result = ([] if diagnostics else events, sorted(diagnostics))
        self.cache[key] = result
        return result


def execution_record(records, event):
    """Resolve one execution, never the first record that shares a reusable agent.

    Explicit job IDs cannot fall back to agent identity. Agent-only events use a
    validated linear engineer lineage and its binding-time windows. Pre-binding
    agent events have no per-execution evidence and cannot import a terminal.
    Returns (record, possibly affected ambiguous records, diagnostic).
    """
    job, agent, at = event.get('job_id'), event.get('agent_id'), event['at']
    if job:
        matches = [r for r in records.values() if r.get('job_id') == job]
        if len(matches) == 1 and (not agent or matches[0].get('agent_id') == agent):
            return matches[0], [], None
        if matches:
            return None, matches, 'unknown: ambiguous/conflicting job-agent lifecycle identity'
        return None, [], None
    if not agent:
        return None, [], None
    matches = sorted((r for r in records.values() if r.get('agent_id') == agent),
                     key=lambda r: r['bound_at'])
    if not matches:
        return None, [], None
    eligible = [r for r in matches if r['bound_at'] <= at]
    if not eligible:
        return None, [], 'coverage: agent-only event before binding ignored'
    if len(matches) > 1:
        identities = {(r['role'], r['lineage'], r['context_id'], r['session_id'], r['slot']) for r in matches}
        linear = (len(identities) == 1 and matches[0]['role'] == 'engineer'
                  and all(cur.get('predecessor') == prev['assignment']
                          for prev, cur in zip(matches, matches[1:])))
        if not linear:
            return None, eligible, 'unknown: ambiguous agent lifecycle lineage'
    latest = [r for r in eligible if r['bound_at'] == eligible[-1]['bound_at']]
    if len(latest) != 1:
        return None, latest, 'unknown: ambiguous agent lifecycle binding time'
    return latest[0], [], None


def apply(data, reader, now):
    diagnostics, skills = set(), set()
    path = data.get('session_file')
    if not path:
        return ['auto unknown: no explicit owner session file'], skills
    try:
        path = validate_session_file(data['project'], data['owner_session'], path)
        events, notes = reader.read(path)
    except (OSError, ValueError, subprocess.SubprocessError):
        data['pm'] = dict(state='unknown', updated_at=0, turn=None)
        return ['auto unknown: owner file unavailable/oversized/undecodable'], skills
    diagnostics.update(notes)
    if notes:
        data['pm'] = dict(state='unknown', updated_at=0, turn=None)
        return sorted(diagnostics | {'auto unknown: owner observation malformed; prefix ignored'}), skills
    headers = [e for e in events if e['type'] == 'session']
    native = any(e.get('native') for e in events)
    if native:
        if (len(headers) != 1 or headers[0].get('id') != data['owner_session']
                or not isinstance(headers[0].get('project'), str)
                or not Path(headers[0]['project']).is_absolute()
                or Path(headers[0]['project']).resolve() != Path(data['project']).resolve()
                or headers[0].get('at') is None or headers[0]['at'] > now + 5):
            return ['auto unknown: native header owner/project mismatch or missing'], skills
    today = datetime.fromtimestamp(now).date()
    newest, unknown_jobs, pending = 0, {}, {}
    accepted_prestarts = set()
    stats = dict(turns=0, registered_jobs=0, matched_job_events=0, prebound_terminals=0)
    pm = data.setdefault('pm', dict(state='unknown', updated_at=0, turn=None))
    # Header-validated owner turns describe the PM without creating per-turn assignments.
    for e in sorted((e for e in events if e['type'] != 'session'), key=lambda v: v['at']):
        at, kind = e['at'], e['type']
        if at > now + 5:
            diagnostics.add('future event ignored')
            continue
        supplied_owners = (e.get('owner'), e.get('sessionId'))
        if any(owner and owner != data['owner_session'] for owner in supplied_owners):
            diagnostics.add('foreign owner event ignored')
            continue
        if e.get('native') and kind.startswith('job/') and e.get('owner') != data['owner_session']:
            diagnostics.add('native job missing/mismatched owner ignored')
            continue
        newest = max(newest, at)
        if kind == 'skill/used':
            if datetime.fromtimestamp(at).date() == today:
                skills.add(e['name'])
            continue
        # Only owner-native events or explicitly owner-stamped legacy messages can ask/answer.
        owner_message = e.get('native') or e.get('sessionId') == data['owner_session']
        if kind in ('questions/called', 'question/result', 'question/asked', 'question/answered', 'user/message'):
            if not owner_message or e.get('job_id') or e.get('agent_id'):
                continue
            if kind == 'questions/called':
                pending[e['call_id']] = dict(id=e['call_id'], sessionId=data['owner_session'],
                    question='\n'.join(q['question'] for q in e['questions']), at=at, count=len(e['questions']))
            elif kind == 'question/result':
                pending.pop(e['call_id'], None)
            elif kind == 'question/asked' and e.get('questionId') and e.get('question'):
                pending[e['questionId']] = dict(id=str(e['questionId']), sessionId=data['owner_session'],
                                               question=e['question'], at=at, count=1)
            elif kind == 'question/answered':
                pending.pop(e.get('questionId'), None)
            elif kind == 'user/message' and e.get('human'):
                pending.clear()
            continue
        if kind in ('turn/start', 'turn/end', 'turn/started', 'turn/completed') and owner_message and not (e.get('job_id') or e.get('agent_id')):
            stats['turns'] += 1
            if at >= pm['updated_at']:
                if kind in ('turn/start', 'turn/started'):
                    pm.update(state='running', updated_at=at, turn=e.get('turn'))
                elif pm.get('turn') in (None, e.get('turn')):
                    pm.update(state='idle', updated_at=at, turn=e.get('turn'))
            continue
        # Native owner steps confirm ongoing PM activity without promoting a tool to a worker role.
        if kind in ('step/start', 'step/end') and owner_message and not (e.get('job_id') or e.get('agent_id')):
            if pm['state'] == 'running' and e.get('turn') == pm.get('turn') and at >= pm['updated_at']:
                pm['updated_at'] = at
            continue
        if kind == 'job/registered':
            stats['registered_jobs'] += 1
        r, ambiguous, diagnostic = execution_record(data['assignments'], e)
        if diagnostic:
            diagnostics.add(diagnostic)
            # An unresolved current lifecycle cannot certify continued activity or
            # a settlement. Preserve terminal facts and newer explicit observations.
            for candidate in ambiguous:
                if (candidate['state'] not in TERMINAL and at >= candidate['bound_at']
                        and at >= candidate['updated_at']):
                    candidate.update(state='unknown', updated_at=at)
            continue
        if r is None:
            if e.get('job_id') or e.get('agent_id'):
                unknown_jobs[(e.get('job_id'), e.get('agent_id'))] = (kind, at)
            continue
        stats['matched_job_events'] += 1
        if r['state'] in TERMINAL:
            continue
        settled = kind in ('job/settled', 'agent/settled', 'turn/completed')
        prebound = at < r['bound_at']
        # The ID is normally returned after job/registered. Admit that exact job's
        # still-fresh start within 5s of an untouched binding; never backdate an agent-only
        # start, override a manual observation, or revive an already settled execution.
        untouched = r['state'] == 'unknown' and r['updated_at'] == r['bound_at']
        prestart = (prebound and e.get('job_id') and kind in ('job/started', 'job/registered')
                    and untouched and 0 <= now-at <= r['ttl']
                    and 0 <= r['bound_at']-at <= min(5, r['ttl']))
        if prebound:
            if prestart:
                accepted_prestarts.add(r['assignment'])
            elif not (e.get('job_id') and settled and (untouched or r['assignment'] in accepted_prestarts)):
                continue
        if not prebound and at < r['updated_at']:
            continue
        if kind in ('job/started', 'job/registered', 'agent/started', 'turn/started'):
            r.update(state='running', updated_at=at)
        elif settled:
            code, status = e.get('exitCode'), e.get('status')
            valid_code = type(code) is int  # bool/float/NaN/string cannot prove an integer exit code
            state = ('cancelled' if status in ('cancelled', 'canceled') else
                     'failed' if status in ('failed', 'error') or (valid_code and code != 0) else
                     'completed' if status in ('completed', 'succeeded', 'success') or (valid_code and code == 0) else 'unknown')
            r.update(state=state, exit_code=code if valid_code else None, updated_at=at)
            if prebound and state in TERMINAL:
                r['historical_terminal'] = True
                stats['prebound_terminals'] += 1
    data.pop('question', None)
    if pending:
        data['question'] = next((q for q in pending.values() if 0 <= now-q['at'] <= data['ttl']),
                                next(iter(pending.values())))
    data['pending_question_count'] = sum(q['count'] for q in pending.values())
    data['event_stats'] = stats
    data['unregistered_recent_unsettled'] = 0
    if unknown_jobs:
        recent_unsettled = sum(kind not in ('job/settled', 'agent/settled', 'turn/completed') and
                               0 <= now-at <= data['ttl'] for kind, at in unknown_jobs.values())
        data['unregistered_recent_unsettled'] = recent_unsettled
        diagnostics.add(f'coverage: {len(unknown_jobs)} unregistered executions ignored; {recent_unsettled} recent unsettled (roles unknown)')
    if not newest or now - newest > data['ttl']:
        diagnostics.add('auto unknown: owner events stale/empty')
    return sorted(diagnostics), skills
