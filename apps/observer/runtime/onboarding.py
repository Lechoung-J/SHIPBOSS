"""Explicit first-load activation metadata. No global settings or history reads."""
import hashlib
import json
import os
from pathlib import Path
import time
import uuid

from registry import atomic_write, validate_session_file


def actual_session(value):
    raw = value.removeprefix('session-') if isinstance(value, str) else ''
    try:
        uuid.UUID(raw)
    except (ValueError, AttributeError):
        raise ValueError('actual session UUID required; agent labels are not session identity')
    return value


def validate_native_activation(project, session_id, session_file=None):
    from discovery import extract
    root = Path(project).resolve()
    actual_session(session_id)
    if session_file is None:
        home = Path(os.environ.get('DSH_HOME', str(Path.home()/'.dsh'))).expanduser()
        encoded = '--' + ''.join('-' if ch == '/' else ch if ch.isalnum() or ch in '-._' else '~%04X' % ord(ch) for ch in str(root).lstrip('/')) + '--'
        session_file = home/'sessions'/encoded/session_id/'session.v4.jsonl.zstd'
    path = Path(validate_session_file(root, session_id, session_file))
    from incremental import IncrementalNative
    reader=IncrementalNative()
    try:
        from incremental import PendingNative
        deadline=time.monotonic()+12
        for tick in range(64):
            try:
                data,_ = reader.parse(path, {'cwd':str(root)}, None,seconds=min(1.5,max(.01,deadline-time.monotonic())))
                break
            except PendingNative:
                if time.monotonic()>=deadline or tick==63:
                    raise ValueError('native activation cold-scan pending: bootstrap budget exhausted; run bounded writer scan to completion')
        else: raise ValueError('activation scan budget')
    finally:
        reader.close()
    h = data['header']
    capable = h.get('depth') == 0 and not h.get('subagent')
    if h['id'] != session_id or h['cwd'] != str(root) or not capable or data.get('activitySourceInvalid') or not any(u['name']=='shipboss' and 0<=u['at']<=time.time() for u in data['usages']):
        raise ValueError('activation requires exact same-project successful Shipboss primary session')
    return dict(session_file=str(path), source='dsh-native-success', session_id=session_id, context_id=session_id, pm_capable=capable)


def receipt_directory(receipts_dir, *, create=False):
    directory = Path(receipts_dir).absolute()
    if directory.name != 'activation-receipts':
        raise ValueError('expected explicit service-owned activation-receipts directory')
    for parent in (directory, *directory.parents):
        if parent.is_symlink():
            raise ValueError('activation directory must not traverse symlinks')
    if create:
        directory.mkdir(parents=True, exist_ok=True)
    return directory


def record_external_activation(project, harness, session_id, context_id, receipts_dir):
    if harness not in ('codex','claude'):
        raise ValueError('explicit supported harness required')
    actual_session(session_id)
    if not isinstance(context_id,str) or not 0 < len(context_id) <= 80:
        raise ValueError('bounded explicit context required')
    root = str(Path(project).resolve())
    directory = receipt_directory(receipts_dir, create=True)
    identity = hashlib.sha256(json.dumps([root,harness,session_id,context_id], separators=(',',':')).encode()).hexdigest()
    from registry import activate, read
    existing=read(root)
    if existing is None:
        # Explicit Skill load is the authority for a declared owner. This is not
        # a native success, and invents no execution/turn/step or worker role.
        existing=activate(root,session_id,context_id)
    receipt = dict(version=1, kind='shipboss-skill-activation', source='external-declared', harness=harness,
                   project=root, sessionId=session_id, contextId=context_id, activatedAt=time.time(), receiptId=identity,
                   registryOwnerSessionId=existing['owner_session'])
    atomic_write(directory/(identity+'.json'), receipt)
    return receipt


def queue_external_activation(project,harness,session_id,context_id,receipts_dir,action='firstload'):
    """Sandbox-friendly request: service metadata only, never project registry."""
    if harness not in ('codex','claude') or action not in ('firstload','show'):
        raise ValueError('supported external harness/action required')
    actual_session(session_id)
    if not isinstance(context_id,str) or not 0<len(context_id)<=80:
        raise ValueError('bounded explicit context required')
    root=str(Path(project).resolve());directory=receipt_directory(receipts_dir,create=True)
    identity=hashlib.sha256(json.dumps([root,harness,session_id,context_id],separators=(',',':')).encode()).hexdigest()
    path=directory/(identity+'.json');at=time.time();activated=at
    if path.exists():
        if path.is_symlink() or path.stat().st_size>4096:raise ValueError('invalid activation receipt target')
        old=json.loads(path.read_text())
        if old.get('receiptId')!=identity:raise ValueError('activation receipt identity mismatch')
        activated=old.get('activatedAt',at)
    request_id=identity if action=='firstload' else hashlib.sha256((identity+'|'+uuid.uuid4().hex).encode()).hexdigest()
    receipt=dict(version=1,kind='shipboss-skill-activation',source='external-declared',harness=harness,project=root,
                 sessionId=session_id,contextId=context_id,activatedAt=activated,receiptId=identity,
                 showRequestedAt=at,showAction=action,showRequestId=request_id)
    atomic_write(path,receipt)
    return receipt


def external_sessions(receipts_dir, *, now, reader=None, requests=None, warnings=None, excluded=(), freshness_seconds=300):
    if not receipts_dir:return []
    from external_journal import OfficialJournalReader,source_key
    reader=OfficialJournalReader() if reader is None else reader
    directory=receipt_directory(receipts_dir);sessions={};deadline=time.monotonic()+2
    for path in sorted(directory.glob('*.json'))[:256]:
        try:
            if path.is_symlink() or path.stat().st_size>4096:continue
            r=json.loads(path.read_text())
            if r.get('version')!=1 or r.get('source')!='external-declared' or r.get('kind')!='shipboss-skill-activation' or r.get('harness') not in ('codex','claude'):continue
            actual_session(r['sessionId'])
            if type(r.get('activatedAt')) not in (int,float) or not 0<=r['activatedAt']<=now or not isinstance(r.get('contextId'),str) or not 0<len(r['contextId'])<=80 or not isinstance(r.get('project'),str) or not Path(r['project']).is_absolute() or os.path.normpath(r['project'])!=r['project']:continue
            if r['project'] in excluded or Path(r['project']).name in excluded:continue
            digest=hashlib.sha256(json.dumps([r['project'],r['harness'],r['sessionId'],r['contextId']],separators=(',',':')).encode()).hexdigest()
            if path.stem!=digest or r.get('receiptId')!=digest:continue
            verified,error=reader.read(r,now=now,seconds=deadline-time.monotonic(),freshness_seconds=freshness_seconds) if time.monotonic()<deadline else (None,'journal-batch-budget')
            if verified:
                # Only queued, source-verified loads may initialize a registry in
                # the writer. Old record_external_activation remains compatible.
                if r.get('showRequestId'):
                    from registry import activate,read
                    existing=read(r['project'])
                    if existing is None:activate(r['project'],r['sessionId'],r['contextId'])
                session=verified
                at=r.get('showRequestedAt');action=r.get('showAction');request_id=r.get('showRequestId')
                if verified.get('sourceFresh') is True and requests is not None and type(at) in (int,float) and 0<=now-at<=120 and action in ('firstload','show') and isinstance(request_id,str) and len(request_id)==64 and all(ch in '0123456789abcdef' for ch in request_id):
                    if action!='firstload' or request_id==digest:requests.append(dict(id=request_id,at=at,action=action))
            else:
                session=dict(header=dict(id=r['sessionId'],cwd=r['project'],parent=None,depth=0,subagent=False,seeded=False,source='external-declared'),
                    sourceKey=source_key(r),usages=[dict(name='shipboss',seq=0,at=r['activatedAt'])],activity=[],tools=[],jobs=[],questions=[])
                if warnings is not None:warnings.append('external-'+r['harness']+':'+str(error))
            key=source_key(r)
            previous=sessions.get(key)
            if previous:session['usages']+=previous['usages']
            sessions[key]=session
        except (OSError,ValueError,KeyError,TypeError):
            if warnings is not None:warnings.append('invalid-external-activation')
    return list(sessions.values())
