#!/usr/bin/env python3
"""One local observer service; exact process identities, immutable registry owner."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

APP = Path(__file__).resolve().parents[1]
REPO = APP.parents[1]
RUNTIME = APP / 'runtime'
SERVICE = REPO / '.delegate/observer-service'
STATE = REPO / '.delegate/observer-state.json'
sys.path.insert(0, str(RUNTIME))


def process_identity(pid):
    if not isinstance(pid, int) or pid <= 1:
        return None
    result = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart=', '-o', 'command='],
                            capture_output=True, text=True, errors='replace', timeout=5)
    return result.stdout.strip() if result.returncode == 0 else None


def live(record):
    return isinstance(record, dict) and record.get('identity') is not None and process_identity(record.get('pid')) == record['identity']


def start_process(argv, env, name):
    log = (SERVICE / (name + '.log')).open('ab')
    try:
        process = subprocess.Popen(argv, cwd=APP, env=env, stdin=subprocess.DEVNULL,
                                   stdout=log, stderr=log, start_new_session=True)
    finally:
        log.close()
    # Allow the executable's shebang/launcher exec chain to settle before
    # recording its command identity. This is liveness, not GUI readiness.
    time.sleep(1)
    if process.poll() is not None:
        raise RuntimeError(f'{name} exited {process.returncode} during startup; see {name}.log')
    identity = process_identity(process.pid)
    if identity is None:
        process.terminate()
        process.wait(timeout=5)
        raise RuntimeError(f'{name} process identity unavailable')
    return {'pid': process.pid, 'identity': identity, 'argv': argv, 'started_at': time.time()}


def dependencies():
    missing = [str(APP / p) for p in ('runtime/observer_state.py', 'runtime/onboarding.py',
               'desktop/main.cjs', 'desktop/trayTemplate.png', 'dist/widget.html') if not (APP / p).is_file()]
    binary = os.environ.get('SHIPBOSS_ELECTRON_BINARY')
    if not binary:
        node = shutil.which('node')
        if node:
            env = {**os.environ, 'ELECTRON_RUN_AS_NODE': '1'}
            result = subprocess.run([node, '-p', "require('electron')"], cwd=APP, env=env,
                                    capture_output=True, text=True, timeout=10)
            if result.returncode == 0:
                binary = result.stdout.strip()
        else:
            missing.append('node (or SHIPBOSS_ELECTRON_BINARY)')
    if not binary or not Path(binary).is_file() or not os.access(binary, os.X_OK):
        missing.append('existing Electron executable; no online installation attempted')
    if binary and '.app/' in str(binary):
        import importlib.util
        spec = importlib.util.spec_from_file_location('electron_health', Path(__file__).with_name('electron-health.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        health = module.check(binary)
        if not health['healthy']:
            missing.extend(health['issues'])
    if not shutil.which('zstd'):
        missing.append('zstd for native DSH sessions')
    return {'ready': not missing, 'missing': missing, 'electron': binary, 'app': str(APP)}


def activate_project(args):
    # Runtime owns all trust/role interpretation. Never infer a role from a CLI.
    from onboarding import validate_native_activation
    from registry import activate, read
    if args.harness != 'dsh':
        from onboarding import record_external_activation
        return record_external_activation(args.project, session_id=args.owner_session,
                    context_id=args.context_id, harness=args.harness,
                    receipts_dir=SERVICE / 'activation-receipts')
    if not args.owner_session:
        raise ValueError('DSH_SESSION_ID/--owner-session is required; no guessed PM session')
    proof = validate_native_activation(args.project, args.owner_session, args.session_file)
    if not proof.get('pm_capable'):
        raise ValueError('native child/unknown owner cannot bootstrap a PM; use its existing assignment')
    registry = read(args.project)
    if registry is None:
        activate(args.project, args.owner_session, args.owner_session, proof['session_file'])
    # An activated new session contributes through DiscoveryIndex. Original
    # owner, generation and all worker lineages remain byte-for-byte unchanged.
    return {**proof, 'registry': 'reused' if registry else 'created',
            'registry_owner': registry['owner_session'] if registry else args.owner_session}


def snapshot(running, **extra):
    if not isinstance(running, dict):
        running = {}
    app = running.get('app') if isinstance(running.get('app'), dict) else {}
    writer = running.get('writer') if isinstance(running.get('writer'), dict) else {}
    return {'app': live(app), 'writer': live(writer), 'state': str(STATE),
            'service_dir': str(SERVICE), 'app_pid': app.get('pid'), 'writer_pid': writer.get('pid'), **extra}


def terminate(record):
    if not live(record):
        return
    os.kill(record['pid'], signal.SIGTERM)
    deadline = time.monotonic() + 5
    while live(record) and time.monotonic() < deadline:
        time.sleep(.1)
    if live(record):
        raise RuntimeError('owned process did not stop after SIGTERM: ' + str(record['pid']))


def main(argv=None):
    global SERVICE, STATE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'show', 'stop', 'status', 'check'])
    parser.add_argument('--project', default=os.getcwd())
    parser.add_argument('--owner-session')
    parser.add_argument('--session-file', help='exact native source; runtime validates its project/session')
    parser.add_argument('--harness', choices=['dsh', 'codex', 'claude'])
    parser.add_argument('--direct', action='store_true', help='outside-sandbox process lifecycle; external default queues metadata')
    parser.add_argument('--context-id', help='actual external harness context; no CLI-name role assignment')
    parser.add_argument('--service-dir', default=os.environ.get('SHIPBOSS_OBSERVER_SERVICE_DIR'))
    parser.add_argument('--projects-root', help='legacy option; discovery uses DSH_HOME')
    parser.add_argument('--exclude-project', action='append', default=[])
    parser.add_argument('--idle-seconds', type=int, default=300)
    args = parser.parse_args(argv)
    args.harness = args.harness or ('codex' if os.environ.get('CODEX_THREAD_ID') else
                                   'claude' if os.environ.get('CLAUDE_SESSION_ID') else 'dsh')
    identity_env = {'dsh': 'DSH_SESSION_ID', 'codex': 'CODEX_THREAD_ID', 'claude': 'CLAUDE_SESSION_ID'}
    args.owner_session = args.owner_session or os.environ.get(identity_env[args.harness])
    if args.harness != 'dsh':
        args.context_id = args.context_id or args.owner_session
    if args.service_dir:
        SERVICE = Path(args.service_dir).expanduser().resolve()
        STATE = SERVICE / 'observer-state.json'
    if args.action == 'check':
        ready = dependencies()
        print(json.dumps(ready, ensure_ascii=False))
        return 0 if ready['ready'] else 1
    # Read-only status must not create service directories.
    state_path = SERVICE / 'processes.json'
    if args.action == 'status' and args.harness != 'dsh' and not args.direct:
        helper = helper_status()
        print(json.dumps({'helper': helper, 'service_dir': str(SERVICE), 'process_probe': False}))
        return 0
    if args.action == 'status':
        try:
            running = json.loads(state_path.read_text())
        except (ValueError, OSError):
            running = {}
        print(json.dumps(snapshot(running), ensure_ascii=False))
        return 0
    if not 1 <= args.idle_seconds <= 86400:
        raise ValueError('idle-seconds must be 1..86400')
    args.project = str(Path(args.project).resolve())
    if args.action == 'start' and not Path(args.project).is_dir():
        raise ValueError('project directory is missing')
    if args.action in ('start', 'show'):
        # Reuse the runtime's exact cwd/basename exclusion semantics before
        # native validation/decoding, external receipts, or any project writes.
        from discovery import DiscoveryIndex
        guard = DiscoveryIndex(os.environ.get('DSH_HOME', str(Path.home() / '.dsh')),
                               SERVICE / 'discovery-index.json',
                               exclude=('ExcludedProject', *args.exclude_project))
        try:
            excluded = guard.is_excluded(args.project)
        finally:
            incremental = getattr(guard, 'incremental', None)
            if incremental is not None:
                incremental.close()
        if excluded:
            print(json.dumps({'excluded': True, 'project': args.project,
                              'first_show_requested': False,
                              'diagnostic': 'project excluded before activation or session reads'}))
            return 0
    if args.harness != 'dsh' and not args.direct and args.action in ('start', 'show'):
        return queue_request(args)
    SERVICE.mkdir(parents=True, exist_ok=True)
    from registry import atomic_write
    with (SERVICE / 'service.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            running = json.loads(state_path.read_text()) if state_path.exists() else {}
            if not isinstance(running, dict):
                running = {}
        except (ValueError, OSError):
            running = {}
        if args.action == 'stop':
            for name in ('writer', 'app'):
                terminate(running.get(name))
            atomic_write(state_path, {})
            print(json.dumps({'stopped': True, 'task_execution_changed': False}))
            return 0
        if args.action == 'show':
            record = running.get('app')
            if not live(record):
                raise ValueError('app is not running; start with a verified activation first')
            # Electron's existing single-instance event calls showInactive.
            # Reuse its exact launch environment and userData scope.
            request_show(record)
            print(json.dumps(snapshot(running, show_requested=True, focus=False)))
            return 0
        ready = dependencies()
        if not ready['ready']:
            raise ValueError('runtime not ready: ' + '; '.join(ready['missing']))
        activation = activate_project(args)
        env = launch_environment()
        writer = [sys.executable, str(RUNTIME/'observer_state.py'),
                  '--dsh-home', str(Path(env.get('DSH_HOME', '~/.dsh')).expanduser()),
                  '--index', str(SERVICE/'discovery-index.json'), '--root', args.project,
                  '--idle-seconds', str(args.idle_seconds), '--auto', '--out', str(STATE)]
        writer.extend(['--activation-receipts', str(SERVICE / 'activation-receipts')])
        for excluded in args.exclude_project:
            writer.extend(['--exclude-project', excluded])
        first = subprocess.run(writer, cwd=APP, env=env, capture_output=True, text=True, timeout=25)
        if first.returncode:
            raise RuntimeError('initial state exited ' + str(first.returncode) + ': ' + first.stderr[-1000:])
        seen = running.get('seen_activations', [])
        seen = [item for item in seen if isinstance(item, str) and len(item) == 64] if isinstance(seen, list) else []
        activation_id = hashlib.sha256(json.dumps([args.project, args.harness,
                             activation.get('session_id', activation.get('sessionId')),
                             activation.get('context_id', activation.get('contextId'))],
                             separators=(',', ':')).encode()).hexdigest()
        first_load = activation_id not in seen
        created = []
        try:
            if not live(running.get('writer')):
                running['writer'] = start_process(writer + ['--watch'], env, 'writer')
                created.append('writer')
                atomic_write(state_path, running)
            if not live(running.get('app')):
                running['app'] = start_process([ready['electron'], str(APP/'desktop/main.cjs')], env, 'app')
                created.append('app')
                atomic_write(state_path, running)
            elif first_load:
                request_show(running['app'])
            if first_load:
                seen.append(activation_id)
            running['seen_activations'] = seen[-256:]
            atomic_write(state_path, running)
        except Exception:
            # Roll back only processes this invocation started, never a live peer.
            for name in reversed(created):
                terminate(running.get(name))
                running.pop(name, None)
            atomic_write(state_path, running)
            raise
        print(json.dumps(snapshot(running, project=args.project, activation=activation,
                    started=created, first_load=first_load,
                    first_show_requested=first_load or 'app' in created, focus=False), ensure_ascii=False))
        return 0


def read_metadata(path, limit=24000):
    path = Path(path).absolute()
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise ValueError('metadata symlink rejected')
    import stat
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('metadata must be a regular file')
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise ValueError('metadata size limit')
    return json.loads(raw)


def helper_status():
    try:
        value = read_metadata(SERVICE / 'helper-status.json')
        if (value.get('version') != 1 or value.get('kind') != 'shipboss-observer-helper'
                or value.get('statePath') != str(STATE) or value.get('status') != 'ready'
                or 'activation-queue-v1' not in value.get('capabilities', [])
                or type(value.get('updatedAt')) not in (float, int)
                or not -5 <= time.time() - value['updatedAt'] <= 15):
            raise ValueError('existing helper heartbeat is absent, stale or waiting')
        return value
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def queue_request(args):
    from onboarding import actual_session, queue_external_activation
    # External identity never falls back to the parent DSH environment.
    actual_session(args.owner_session)
    if not args.context_id:
        raise ValueError('external harness context is required')
    if not helper_status():
        raise ValueError('no ready existing observer helper; start the observer once from the OS/outside sandbox, then retry this metadata request; no process probe or cold launch attempted')
    receipt = queue_external_activation(args.project, args.harness, args.owner_session,
                    args.context_id, SERVICE / 'activation-receipts',
                    action='show' if args.action == 'show' else 'firstload')
    print(json.dumps({'queued': True, 'shown': False, 'process_probe': False,
                     'activation': receipt, 'service_dir': str(SERVICE),
                     'diagnostic': 'pending official journal validation by the existing observer writer'}))
    return 0


def request_show(record):
    if not live(record):
        raise ValueError('app exited before the show request')
    result = subprocess.run(record['argv'], cwd=APP, env=launch_environment(),
                            capture_output=True, text=True, timeout=10)
    if result.returncode:
        raise RuntimeError('show request exited ' + str(result.returncode) + ': ' + result.stderr[-500:])


def launch_environment():
    env = dict(os.environ)
    for name in ('ELECTRON_RUN_AS_NODE', 'SHIPBOSS_DEV_URL', 'SHIPBOSS_TEST_MODE',
                 'SHIPBOSS_TEST_RUN_ID', 'SHIPBOSS_ACTIVITY_PREVIEW', 'SHIPBOSS_ACTIVITY_RUN_ID'):
        env.pop(name, None)
    env.update(SHIPBOSS_OBSERVER_STATE=str(STATE), SHIPBOSS_OBSERVER_SERVICE_DIR=str(SERVICE),
               PYTHONDONTWRITEBYTECODE='1')
    return env


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, ImportError, subprocess.SubprocessError) as exc:
        print(json.dumps({'ready': False, 'diagnostic': str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
