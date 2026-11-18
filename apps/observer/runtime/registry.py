"""Explicit, project-local launch records. No role inference or process discovery."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
import uuid

FILE = '.delegate/observer/runtime.json'
ROLES = {'pm': 'pm', 'eng-a': 'engineer', 'eng-b': 'engineer',
         'verifier': 'verifier', 'recording': 'recording'}
TERMINAL = {'completed', 'failed', 'cancelled'}
STATES = {'running', 'blocked', 'unknown'} | TERMINAL
PHASES = {'working', 'thinking', 'testing', 'reading', 'waiting'}


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', value):
        raise ValueError('invalid identifier')
    return value


def required(value, label):
    if not isinstance(value, str) or not value.strip() or len(value) > 512:
        raise ValueError('required short string: ' + label)
    return value


def atomic_write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f, ensure_ascii=False, allow_nan=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def read(root):
    path = Path(root) / FILE
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    if not isinstance(data, dict) or data.get('version') != 1 or data.get('project') != str(Path(root).resolve()):
        raise ValueError('runtime version/project mismatch')
    if not isinstance(data.get('assignments'), dict) or not all(k in data for k in ('owner_session', 'pm_context', 'project_id', 'ttl', 'activated_at')):
        raise ValueError('incomplete runtime registry')
    return data


@contextlib.contextmanager
def transaction(root):
    root = Path(root).resolve()
    path = root / FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    with (path.parent / 'runtime.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = read(root)
        yield data
        if data is None:
            raise ValueError('activate first')
        data['generation'] = data.get('generation', 0) + 1
        atomic_write(path, data)


def validate_session_file(root, owner_session, session_file):
    root = Path(root).resolve()
    identifier(owner_session)
    target = Path(session_file).resolve()
    encoded = '--' + ''.join('-' if ch == '/' else ch if ch.isalnum() or ch in '-._' else '~%04X' % ord(ch)
                              for ch in str(root).lstrip('/')) + '--'
    expected = Path(os.environ.get('DSH_HOME', str(Path.home() / '.dsh'))).expanduser().resolve() / 'sessions' / encoded / owner_session / 'session.v4.jsonl.zstd'
    # Local exports stay inside this project. Native DSH files must match project AND owner.
    if not target.is_relative_to(root) and target != expected:
        raise ValueError('session file outside activated project/owner')
    if target.name not in ('session.v4.jsonl.zstd', 'session.jsonl'):
        raise ValueError('expected explicit session.jsonl or session.v4.jsonl.zstd')
    return str(target)


def activate(root, owner_session, context_id, session_file=None, ttl=900):
    root = Path(root).resolve()
    identifier(owner_session)
    required(context_id, 'PM context')
    if not 1 <= ttl <= 86400:
        raise ValueError('TTL must be 1..86400 seconds')
    # Explicit file only. No glob, newest-session lookup, or neighbouring projects.
    if session_file:
        session_file = validate_session_file(root, owner_session, session_file)
    path = root / FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    with (path.parent / 'runtime.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = read(root)
        if data and (data['owner_session'] != owner_session or data['pm_context'] != context_id):
            raise ValueError('owner immutable; use a separate runtime for a new PM context')
        if data is None:
            data = dict(version=1, project=str(root), project_id='p-' + hashlib.sha256(str(root).encode()).hexdigest()[:20],
                        owner_session=owner_session, pm_context=context_id, assignments={}, activated_at=time.time(), generation=0)
        data.setdefault('pm', dict(state='unknown', updated_at=0, turn=None))
        data.update(active=True, session_file=session_file or data.get('session_file'), ttl=ttl)
        atomic_write(path, data)
    return data


def bind(root, *, assignment, task, role, slot, policy, context_id, session_id,
         job_id=None, agent_id=None, revision=None, predecessor=None, ttl=None,
         initial_state='unknown', source='native', launch_id=None):
    identifier(assignment)
    identifier(task)
    if initial_state not in ('unknown', 'running') or source not in ('native','process','codex','claude'):
        raise ValueError('invalid dispatch state/source')
    if launch_id is not None:
        identifier(launch_id)
    if slot not in ROLES or ROLES[slot] != role:
        raise ValueError('role must match explicit workstation')
    for val, label in [(context_id, 'context_id'), (session_id, 'session_id')]:
        required(val, label)
    if not job_id and not agent_id:
        raise ValueError('real job_id or agent_id required')
    for val in (job_id, agent_id, revision):
        if val is not None:
            required(val, 'identity/revision')
    now = time.time()
    with transaction(root) as d:
        if d is None:
            raise ValueError('activate first')
        records = d['assignments']
        if assignment in records:
            raise ValueError('assignment already bound; phase/finish it or use a new launch id')
        if ttl is not None and not 1 <= ttl <= 86400:
            raise ValueError('TTL must be 1..86400')
        previous = records.get(predecessor) if predecessor else None
        if predecessor and (not previous or previous['task'] != task or previous['role'] != role):
            raise ValueError('predecessor must be same task and responsibility')
        related = [r for r in records.values() if r['task'] == task and r['role'] == role]
        if role == 'verifier':
            required(revision, 'verification target revision')
            used = {d['pm_context'], d['owner_session']}
            used.update(r[k] for r in records.values() for k in ('context_id', 'session_id'))
            if policy != 'fresh' or context_id in used or session_id in used:
                raise ValueError('formal verification requires fresh, distinct context/session')
            if context_id == d['owner_session'] or session_id == d['pm_context']:
                raise ValueError('verification cannot inherit PM context')
        elif role == 'engineer':
            if not related:
                if policy != 'new' or predecessor:
                    raise ValueError('first engineer launch must be new')
            else:
                if not previous or policy not in ('resume', 'handoff'):
                    raise ValueError('explicit resume/handoff predecessor required')
                # Cannot branch an old lineage or silently change the workstation.
                if any(r.get('predecessor') == predecessor for r in related):
                    raise ValueError('predecessor already continued')
                same = (context_id, session_id) == (previous['context_id'], previous['session_id'])
                if policy == 'resume' and not same:
                    raise ValueError('resume must preserve context/session')
                if policy == 'handoff' and same:
                    raise ValueError('handoff requires a different context/session')
                if slot != previous['slot'] or previous['state'] not in TERMINAL:
                    raise ValueError('finish predecessor and preserve workstation')
        elif policy != 'new':
            raise ValueError('PM/recording launches use new policy')
        if role != 'verifier' and policy in ('fresh', 'fork'):
            raise ValueError('invalid context policy')
        if role == 'engineer' and any(r['role'] == 'verifier' and
                (context_id in (r['context_id'], r['session_id']) or session_id in (r['context_id'], r['session_id']))
                for r in records.values()):
            raise ValueError('implementation cannot reuse a formal verification context')
        # A job identifies one execution; an agent may identify a resumable engineer.
        # Reuse is narrow: only a terminal, same-context predecessor in this lineage.
        resume_agent = (role == 'engineer' and policy == 'resume' and previous
                        and agent_id and previous.get('agent_id') == agent_id)
        for r in records.values():
            if job_id and job_id == r.get('job_id'):
                raise ValueError('execution job identity already registered')
            if agent_id and agent_id == r.get('agent_id'):
                same_engineer = (resume_agent and r['role'] == 'engineer'
                                 and r['lineage'] == previous['lineage']
                                 and r['context_id'] == context_id and r['session_id'] == session_id
                                 and r['slot'] == slot and r['state'] in TERMINAL)
                if not same_engineer:
                    raise ValueError('agent identity requires same-lineage engineer resume')
            if r['slot'] == slot and r['state'] not in TERMINAL:
                raise ValueError('workstation occupied; finish explicitly first')
        records[assignment] = dict(assignment=assignment, task=task, role=role, slot=slot,
            policy=policy, context_id=context_id, session_id=session_id, job_id=job_id, agent_id=agent_id,
            revision=revision, predecessor=predecessor, lineage=previous['lineage'] if previous else assignment,
            state=initial_state, source=source, launch_id=launch_id, phase='working', updated_at=now, bound_at=now, ttl=ttl or d['ttl'],
            owner_session=d['owner_session'], verdict=None, exit_code=None)
    return assignment


def update(root, assignment, *, state=None, phase=None, exit_code=None, verdict=None, revision=None):
    with transaction(root) as d:
        if d is None:
            raise ValueError('activate first')
        r = d['assignments'][assignment]
        if state is not None:
            if state not in STATES:
                raise ValueError('invalid lifecycle state')
            if r['state'] in TERMINAL and state != r['state']:
                raise ValueError('terminal launch immutable; bind a continuation')
            r['state'] = state
        if phase is not None:
            if phase not in PHASES or r['state'] in TERMINAL:
                raise ValueError('invalid phase or terminal launch')
            r['phase'] = phase
            r.pop('stage', None)
        if verdict is not None:
            if r['role'] != 'verifier' or r['state'] != 'completed' or verdict not in ('PASS', 'FAIL', 'NEEDS-HUMAN'):
                raise ValueError('explicit verdict requires completed verifier')
            if not revision or revision != r['revision']:
                raise ValueError('verdict target revision mismatch')
            r['verdict'] = verdict
        if exit_code is not None:
            if type(exit_code) is not int or r['state'] not in TERMINAL:
                raise ValueError('exit code requires terminal state')
            r['exit_code'] = exit_code
        if r['state'] == 'completed' and r['exit_code'] is not None and (
                type(r['exit_code']) is not int or r['exit_code'] != 0):
            raise ValueError('completed execution requires zero exit code when supplied')
        r['updated_at'] = time.time()


def pulse(root, payload):
    if payload.get('pm') not in ('waiting', 'working'):
        raise ValueError('pulse only supports explicit PM waiting/working')
    with transaction(root) as d:
        if d is None:
            raise ValueError('activate first')
        ttl = payload.get('ttl', 60)
        if not isinstance(ttl, int) or not 1 <= ttl <= 900:
            raise ValueError('pulse TTL must be 1..900')
        d['pulse'] = dict(pm=payload['pm'], at=time.time(), ttl=ttl)
