#!/usr/bin/env python3
"""Contract-v1 snapshot writer. Unknown uses dispatching + visible diagnostics, never idle."""
import argparse
import copy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import time

from registry import ROLES, TERMINAL, atomic_write, pulse, read
from events import EventReader, apply

NAMES = {'pm': '产品经理', 'eng-a': '工程师 A', 'eng-b': '工程师 B', 'verifier': '验收员'}


def build_project(root, reader=None, auto=False, now=None, *, registry_data=None, native_sessions=()):
    now = time.time() if now is None else now
    try:
        d = read(root) if registry_data is None else registry_data
    except (OSError, ValueError) as exc:
        print(f'runtime unknown: {Path(root)} ({type(exc).__name__})', file=sys.stderr)
        # Do not invent an activated identity from a corrupt file.
        return None
    if not d or not d.get('active'):
        return None
    d = copy.deepcopy(d)
    # A discovery overlay is an already-validated registry snapshot. Never follow
    # its session_file (even when supplied); native events come from the index.
    notes, skills = ((['read-only discovered registry lifecycle'], set()) if registry_data is not None else
                    apply(d if auto else copy.deepcopy(d), reader or EventReader(), now) if d.get('session_file') or auto else ([], set()))
    if not auto:
        notes.append('coverage: explicit registry lifecycle only; owner skill events if configured')
    actors = {slot: dict(id=slot, role=ROLES[slot], name=name, active=False,
                         taskId=None, motion='idle', activity='unknown: no fresh registered execution', papers=0)
              for slot, name in NAMES.items()}
    recording_actor = dict(id='recording', role='recording', name='记录员', active=False, uncertain=False, taskId=None, motion='idle', activity='', papers=0)
    records = sorted(d['assignments'].values(), key=lambda r: r['bound_at'])
    # Read-only event heartbeat: never mutate a real registry or revive terminal.
    from tool_activity import execution_heartbeat
    for record in records:
        if record['state']=='running':
            heartbeat=execution_heartbeat(record,records,native_sessions,now)
            if heartbeat is not None: record['updated_at']=max(record['updated_at'],heartbeat)
            if record.get('source') in ('codex','claude'):
                from cli_stream import load_activity
                current=load_activity(root,d,record,now=now)
                if current: record['updated_at']=now
    tasks, recording, fresh_terminal, uncertain = {}, False, False, False
    recording_uncertain = False
    pm = d.get('pm', {})
    pm_fresh = 0 <= now - pm.get('updated_at', 0) <= d['ttl']
    if (pm_fresh and pm.get('state') == 'running') or pm.get('state') == 'idle':
        running = pm['state'] == 'running'
        actors['pm'].update(active=running, motion='working' if running else 'idle',
                            activity='owner turn running' if running else 'owner turn ended; PM idle (not project done)')
        fresh_terminal = not running and pm_fresh

    superseded = {r['predecessor'] for r in records if r.get('predecessor')}
    for r in records:
        if r['assignment'] in superseded:
            continue
        if r['role'] == 'pm' and pm.get('state') in ('running', 'idle') and (
                r['state'] == 'unknown' or pm.get('updated_at', 0) >= r['updated_at']):
            continue
        # A registry may be updated while this discovery tick is being read.
        # Bound that read-race skew just like native events; do not extend TTL.
        fresh = (-5 if registry_data is not None else 0) <= now - r['updated_at'] <= r['ttl']
        # Terminal execution facts do not become running/unknown merely by aging.
        # Freshness is still required before claiming the project is idle.
        state = r['state'] if fresh or r['state'] in TERMINAL else 'unknown'
        active = state == 'running'
        if state == 'unknown':
            uncertain = True
        if state == 'blocked':
            uncertain = True
        if state in TERMINAL and fresh:
            fresh_terminal = True
        activity = ('unknown: expired/unconfirmed execution' if state == 'unknown' else
                    'blocked: explicit lifecycle; not rework' if state == 'blocked' else state)
        if r['role'] == 'engineer' and state == 'completed':
            activity = 'implementation delivered; awaiting explicit independent verification'
        if r.get('historical_terminal'):
            activity += '; historical pre-binding terminal, not live start evidence'
        if r['slot'] == 'recording':
            recording = active
            recording_uncertain = state in ('unknown', 'blocked')
        a = recording_actor if r['slot'] == 'recording' else actors[r['slot']]
        # Native activity follows this exact registration window, including resumes.
        same_session = [other for other in records if other['session_id'] == r['session_id']]
        later = [other['bound_at'] for other in same_session if other['bound_at'] > r['bound_at']]
        ambiguous = sum(other['bound_at'] == r['bound_at'] for other in same_session) != 1
        if r.get('owner_session') == d['owner_session']:
            a['_activityBinding'] = dict(sessionId=r['session_id'], start=r['bound_at'],
                                         end=min(later, default=None), ambiguous=ambiguous)
        a.update(uncertain=state in ('unknown', 'blocked'), active=active, taskId=r['task'], motion=r['phase'] if active else 'idle', activity=activity,
                 papers=1 if active else 0)
        if active and r.get('source') in ('codex','claude'):
            from cli_stream import load_activity
            a['toolActivity'] = load_activity(root, d, r, now=now)
        if r['role'] in ('pm', 'recording'):
            continue
        status = 'implementing' if r['role'] == 'engineer' and active else 'queued'
        verification = None
        if r['role'] == 'engineer' and state == 'completed':
            status, verification = 'queued', 'queued'
        if r['role'] == 'verifier':
            status = 'verifying' if active else 'queued'
            verification = 'active' if active else 'queued'
            if r['verdict'] and state == 'completed':
                status = 'rework' if r['verdict'] == 'FAIL' else 'reviewing'
                verification = 'rejected' if r['verdict'] == 'FAIL' else 'passed' if r['verdict'] == 'PASS' else None
                if r['verdict'] == 'FAIL':
                    a['motion'] = 'rejected'
                activity = 'explicit ' + r['verdict'] + ' for revision ' + r['revision']
                a['activity'] = activity
        tasks[r['task']] = dict(id=r['task'], title=r['task'], status=status, assignee=r['slot'],
            attempt=1, motion=a['motion'], activity=activity, verdict=r['verdict'],
            verification=verification, evidence=(['revision: ' + r['revision']] if r['revision'] else [])
            + (['execution: ' + state + (' (pre-binding)' if r.get('historical_terminal') else '')] if state in TERMINAL else []), simulated=False)
    q = d.get('question')
    if q and not 0 <= now - q['at'] <= d['ttl']:
        q = None
        notes.append('unknown: expired question')
        uncertain = True
    p = d.get('pulse', {})
    if p and 0 <= now - p['at'] <= p['ttl']:
        actors['pm'].update(active=True, motion='waiting' if p['pm'] == 'waiting' else 'working',
                            activity='explicit PM pulse (not a dispatched role)')
    elif p:
        notes.append('unknown: expired PM pulse')
        uncertain = True
    if q:
        actors['pm'].update(active=True, motion='waiting', activity='owner session question pending')
    if actors['pm']['active']:
        actors['pm']['uncertain'] = False
    elif pm.get('state') != 'idle' and not pm_fresh and not any(r['role'] == 'pm' and r['state'] in TERMINAL for r in records):
        actors['pm']['uncertain'] = True
    for actor in actors.values():
        if actor.get('uncertain'):
            actor['activity'] = '状态未知/暂停：' + actor['activity']
    active = any(a['active'] for a in actors.values()) or recording
    statuses = {t['status'] for t in tasks.values()}
    status = ('needs-human' if q else 'implementing' if active and any(a['active'] and a['role'] == 'engineer' for a in actors.values())
              else 'verifying' if actors['verifier']['active'] else 'implementing' if active
              else 'dispatching' if uncertain or not fresh_terminal else
              'rework' if 'rework' in statuses else 'reviewing' if 'reviewing' in statuses else
              'verifying' if 'verifying' in statuses else
              'dispatching' if d.get('unregistered_recent_unsettled') else 'idle')
    if uncertain:
        notes.append('unknown: registered execution/question/pulse expired, blocked or unconfirmed')
    summary = 'unknown: no fresh confirmed work/terminal state' if status == 'dispatching' else status
    activity = '; '.join([summary] + notes)
    counts = {s: sum(t['status'] == s for t in tasks.values()) for s in
              ('queued', 'implementing', 'rework', 'verifying', 'reviewing', 'done')}
    counts['testing'] = sum(t['motion'] == 'testing' and t['status'] == 'implementing' for t in tasks.values())
    last_activity = max([d.get('pm', {}).get('updated_at', 0), d.get('pulse', {}).get('at', 0), (d.get('question') or {}).get('at', 0)]
                        + [r['updated_at'] for r in records])
    return dict(ownerSessionId=d['owner_session'], lastActivityEpoch=last_activity, id=d['project_id'], name=Path(root).name, source='explicit runtime; owner=' + d['owner_session'] + '; ' + '; '.join(notes),
        skillsUsed=len(skills), status=status, activity=activity, needsAttention=bool(q), awaitingUser=bool(q),
        pendingQuestion={k: q[k] for k in ('id', 'sessionId', 'question')} if q else None,
        recordingActor=recording_actor, recording=recording, recordingUncertain=recording_uncertain, scribeActivity='状态未知/暂停：recording lifecycle unconfirmed' if recording_uncertain else 'registered recording running' if recording else '',
        actors=list(actors.values()), tasks=list(tasks.values()), reports=[], latestEvent=None,
        epoch=1, time=max(0, now-d['activated_at']), elapsed=max(0, now-d['activated_at']),
        counts=counts, engineerCount=sum(a['active'] and a['role'] == 'engineer' for a in actors.values()),
        verifierCount=int(actors['verifier']['active']), unreadReports=0, queuedReports=0,
        verificationQueue=[t['id'] for t in tasks.values() if t['verification'] == 'queued'], events=[], simulated=False)


def build(roots, reader=None, auto=False, now=None):
    return dict(version=1, generatedAt=datetime.now(timezone.utc).isoformat(), source='explicit-project-runtime',
                projects=[p for root in roots if (p := build_project(root, reader, auto, now))])


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--root')
    ap.add_argument('--dsh-home', help='global metadata discovery; never scan project trees')
    ap.add_argument('--exclude-project', action='append', default=[], help='additional excluded cwd or basename; ExcludedProject is excluded by default')
    ap.add_argument('--activation-receipts', help='explicit service-owned activation-receipts directory')
    ap.add_argument('--index', help='persistent discovery index outside observed projects')
    ap.add_argument('--idle-seconds', type=int, default=300)
    ap.add_argument('--projects-root', default='.')
    ap.add_argument('--out', default=os.environ.get('SHIPBOSS_OBSERVER_STATE'))
    ap.add_argument('--stdout', action='store_true')
    ap.add_argument('--auto', action='store_true')
    ap.add_argument('--watch', action='store_true')
    ap.add_argument('--pulse')
    a = ap.parse_args()
    if a.pulse:
        if not a.root:
            ap.error('--pulse requires explicit --root')
        pulse(a.root, json.loads(a.pulse))
    if a.idle_seconds < 1:
        ap.error('--idle-seconds must be positive')
    discovery = None
    if a.dsh_home:
        from discovery import DiscoveryIndex
        if not a.index:
            ap.error('--dsh-home requires --index')
        discovery = DiscoveryIndex(a.dsh_home, a.index, exclude=('ExcludedProject', *a.exclude_project), activation_receipts=a.activation_receipts)
    reader = EventReader()
    while True:
        # Only inspect direct children for the registry file; never read backlog/session discovery.
        roots = [Path(a.root).resolve()] if a.root else [] if discovery else sorted(
            p for p in Path(a.projects_root).expanduser().iterdir()
            if p.is_dir() and (p / '.delegate/observer/runtime.json').is_file())
        payload = (discovery.build(idle_seconds=a.idle_seconds, explicit_roots=roots)
                   if discovery else build(roots, reader, a.auto))
        if a.out:
            atomic_write(Path(a.out).expanduser(), payload)
        if a.stdout or not a.out:
            print(json.dumps(payload, ensure_ascii=False), flush=True)
        if not a.watch:
            return 0
        time.sleep(1)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
