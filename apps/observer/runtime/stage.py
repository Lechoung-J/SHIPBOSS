"""Run a bounded explicit engineer stage, never completing its assignment.

A per-assignment flock rejects overlapping wrappers. Token compare-and-restore
respects manual phase/lifecycle changes; an abandoned token can be recovered by
next invocation after the OS releases the lock. Only this wrapper's child is owned.
"""
import fcntl
import os
from pathlib import Path
import signal
import subprocess
import time
import uuid

from registry import PHASES, transaction


def run_stage(root, assignment, phase, command):
    from registry import identifier
    identifier(assignment)
    if phase not in PHASES or not command:
        raise ValueError('stage requires valid phase and -- executable [args]')
    lock_path = Path(root)/'.delegate/observer'/('stage-'+assignment+'.lock')
    # Do not create a registry or establish identity implicitly.
    if not lock_path.parent.is_dir():
        raise ValueError('stage requires existing registry')
    with lock_path.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('stage already running for assignment') from None
        token = uuid.uuid4().hex
        with transaction(root) as data:
            r = data['assignments'][assignment]
            if r['role'] != 'engineer' or r['state'] != 'running':
                raise ValueError('stage requires a registered running engineer')
            previous = (r.get('stage') or {}).get('previous', r['phase'])
            r.update(phase=phase, updated_at=time.time(), stage=dict(token=token, previous=previous))
        child = None
        old_handlers = {}
        def interrupted(signum, frame):
            raise KeyboardInterrupt(signum)
        try:
            for sig in (signal.SIGTERM, signal.SIGINT):
                old_handlers[sig] = signal.signal(sig, interrupted)
            child = subprocess.Popen(command, start_new_session=True)
            while True:
                try:
                    code = child.wait(timeout=1)
                    return 128-code if code < 0 else code
                except subprocess.TimeoutExpired:
                    with transaction(root) as data:
                        r = data['assignments'][assignment]
                        if r.get('stage', {}).get('token') == token and r['state'] == 'running':
                            r['updated_at'] = time.time()
        except KeyboardInterrupt as exc:
            sig = exc.args[0] if exc.args and type(exc.args[0]) is int else signal.SIGINT
            if child and child.poll() is None:
                os.killpg(child.pid, sig)
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
            return 128+sig
        except OSError:
            return 127
        finally:
            # Unexpected snapshot/registry failures must not orphan our command.
            if child and child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
            for sig, handler in old_handlers.items():
                signal.signal(sig, handler)
            with transaction(root) as data:
                r = data['assignments'][assignment]
                if r.get('stage', {}).get('token') == token:
                    r.pop('stage', None)
                    if r['state'] == 'running' and r['phase'] == phase:
                        r.update(phase=previous, updated_at=time.time())
