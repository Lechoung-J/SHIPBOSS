"""Unified dispatch receipts. No role inference, backdated starts or automatic verdicts."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid

from onboarding import actual_session
from registry import bind, read, transaction, update


def receipt(root, assignment, action):
    with transaction(root) as d:
        r=d['assignments'][assignment]
        value=dict(version=1,kind='dispatch-receipt',action=action,projectId=d['project_id'],ownerSessionId=d['owner_session'],
                   assignment=assignment,launchId=r.get('launch_id'),source=r.get('source','native'),sessionId=r['session_id'],
                   contextId=r['context_id'],jobId=r.get('job_id'),agentId=r.get('agent_id'),role=r['role'],slot=r['slot'],
                   task=r['task'],state=r['state'],phase=r['phase'],revision=r.get('revision'),verdict=r.get('verdict'),exitCode=r.get('exit_code'),at=time.time())
        d['dispatch_receipts']=(d.get('dispatch_receipts',[])+[value])[-64:]
    return value


def register(root, owner_session, *, state='running', source='native', **binding):
    d=read(root)
    if not d or d['owner_session'] != owner_session:
        raise ValueError('dispatch owner mismatch; activate exact project first')
    actual_session(binding['session_id'])
    launch='launch-'+uuid.uuid4().hex
    assignment=bind(root,**binding,source=source,initial_state=state,launch_id=launch)
    return receipt(root,assignment,'registered')


REAP_TIMEOUT=5


def reap_owned_child(child):
    """Terminate/wait/kill fallback for this launch only, including closed pipes."""
    if child is None: return
    try:
        if child.poll() is None:
            try: child.terminate()
            except ProcessLookupError: pass
        try: child.wait(timeout=REAP_TIMEOUT)
        except subprocess.TimeoutExpired:
            try: child.kill()
            except ProcessLookupError: pass
            child.wait()
    finally:
        if child.stdout and not child.stdout.closed: child.stdout.close()


def launch(root, owner_session, command, *, source='process', **binding):
    if not command:
        raise ValueError('launch requires explicit executable')
    if binding.get('job_id') or binding.get('agent_id'):
        raise ValueError('managed launch owns job identity; use register for native host tool results')
    if source in ('codex','claude'):
        if source=='codex' and not ('exec' in command and '--json' in command):
            raise ValueError('Codex stream requires exec --json')
        if source=='claude' and not ('--output-format' in command and 'stream-json' in command and '--verbose' in command and any(a in command for a in ('-p','--print'))):
            raise ValueError('Claude stream requires --print --verbose --output-format stream-json')
    binding['job_id']='local-'+str(os.getpid())+'-'+uuid.uuid4().hex
    info=register(root,owner_session,source=source,**binding)
    assignment=info['assignment']
    print(json.dumps(info),file=sys.stderr,flush=True)
    child=None
    previous={}
    def interrupted(sig,frame):
        if child and child.poll() is None:
            child.send_signal(sig)
        raise KeyboardInterrupt
    try:
        for sig in (signal.SIGTERM,signal.SIGINT):
            previous[sig]=signal.signal(sig,interrupted)
        if source in ('codex','claude'):
            from cli_stream import StreamAdapter, forward_stream
            adapter=StreamAdapter(root,assignment,source)
            child=subprocess.Popen(command,cwd=root,stdout=subprocess.PIPE)  # stderr inherited; never saved by observer
            code=forward_stream(child,adapter)
        else:
            child=subprocess.Popen(command,cwd=root)
            code=child.wait()
    except KeyboardInterrupt:
        reap_owned_child(child)
        update(root,assignment,state='cancelled',exit_code=130)
        print(json.dumps(receipt(root,assignment,'finished')),file=sys.stderr,flush=True)
        return 130
    except OSError:
        reap_owned_child(child)
        # 127 is reserved for failure to start. A started transport that fails
        # reading/writing is a wrapper I/O failure, with a finished receipt.
        code=127 if child is None else 125
    except Exception:
        reap_owned_child(child)
        code=125
    finally:
        for sig,handler in previous.items(): signal.signal(sig,handler)
    update(root,assignment,state='cancelled' if code<0 else 'completed' if code==0 else 'failed',exit_code=code)
    print(json.dumps(receipt(root,assignment,'finished')),file=sys.stderr,flush=True)
    return 128-code if code<0 else code
