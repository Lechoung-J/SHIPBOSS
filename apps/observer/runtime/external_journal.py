"""Receipt-scoped official journals. Only white metadata survives parsing.

No global history/config/credential reads. Codex filename lookup is bounded and
reads names only; Claude path is exact root encoding plus the declared UUID.
Append checkpoints store normalized identities/calls/lifecycle, never raw lines.
"""
from datetime import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import time

from tool_activity import call_metadata, native_call_id, valid_id

VERSION='official-journal-v3-identity-diagnostics'
DEFAULT_SOURCE_TTL=300
MAX_LINE=4*1024*1024
MAX_TICK=8*1024*1024
MAX_CALLS=32
CLAUDE_IDENTITY_ERRORS=frozenset('claude-'+name for name in (
    'session-missing','session-mismatch','cwd-missing','cwd-invalid','cwd-mismatch',
    'sidechain-missing','sidechain-not-false','timestamp-invalid','turn-id-invalid'))


def claude_identity_reason(receipt,row):
    """Fixed reason codes only; never echo journal text, paths or identities."""
    if 'sessionId' not in row:return 'claude-session-missing'
    if row.get('sessionId')!=receipt['sessionId']:return 'claude-session-mismatch'
    if 'cwd' not in row:return 'claude-cwd-missing'
    cwd=canonical_project(row.get('cwd'))
    if cwd is None:return 'claude-cwd-invalid'
    if cwd!=receipt['project']:return 'claude-cwd-mismatch'
    if 'isSidechain' not in row:return 'claude-sidechain-missing'
    if row.get('isSidechain') is not False:return 'claude-sidechain-not-false'
    if epoch(row.get('timestamp')) is None:return 'claude-timestamp-invalid'
    return None


def invalidate_claude(state,reason):
    state['invalid']=True
    if reason in CLAUDE_IDENTITY_ERRORS:state.setdefault('invalidReason',reason)


def epoch(value):
    if isinstance(value,str):
        try:value=datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()
        except (ValueError,OverflowError):return None
    elif type(value) in (int,float):
        if value>253402300799:value/=1000
    else:return None
    return value if math.isfinite(value) and 0<=value<=253402300799 else None


def source_key(receipt):
    return 'external-'+receipt['harness']+'-'+hashlib.sha256(json.dumps([receipt['project'],receipt['sessionId']],separators=(',',':')).encode()).hexdigest()[:40]


def no_symlinks(path):
    return not any(parent.is_symlink() for parent in (path,*path.parents))


def canonical_project(value):
    return os.path.normpath(value) if isinstance(value,str) and os.path.isabs(value) else None


def locate(receipt, home, old=None):
    """Names-only lookup, no journal other than this exact UUID is opened."""
    sid=receipt['sessionId'];harness=receipt['harness']
    if harness=='claude':
        encoded=re.sub(r'[^A-Za-z0-9]','-',receipt['project'])
        path=home/'.claude/projects'/encoded/(sid+'.jsonl')
        return path if no_symlinks(path) and path.is_file() else None
    store=home/'.codex/sessions'
    if not no_symlinks(store) or not store.is_dir():return None
    if old and isinstance(old.get('path'),str):
        known=Path(old['path'])
        if known.is_relative_to(store) and len(known.relative_to(store).parts)==4 and known.name.startswith('rollout-') and known.name.endswith('-'+sid+'.jsonl') and no_symlinks(known) and known.is_file():return known
    matches=[];remaining=12000;deadline=time.monotonic()+.25
    pending=[(store,0)]
    while pending and remaining>0 and time.monotonic()<deadline:
        folder,depth=pending.pop()
        with os.scandir(folder) as entries:
            for entry in entries:
                remaining-=1
                if remaining<=0 or time.monotonic()>=deadline:raise ValueError('journal-name-lookup-budget')
                if entry.is_symlink():continue
                if depth<3 and entry.is_dir(follow_symlinks=False) and entry.name.isdigit():pending.append((Path(entry.path),depth+1))
                elif depth==3 and entry.is_file(follow_symlinks=False) and entry.name.startswith('rollout-') and entry.name.endswith('-'+sid+'.jsonl'):matches.append(Path(entry.path))
    if pending:raise ValueError('journal-name-lookup-budget')
    if len(matches)>1:raise ValueError('ambiguous-official-journal')
    return matches[0] if matches else None


def checkpoint_proof(stream,offset):
    position=stream.tell();stream.seek(0);first=stream.read(min(offset,4096))
    stream.seek(max(0,offset-4096));tail=stream.read(min(offset,4096));stream.seek(position)
    return hashlib.sha256(first+b'\0'+tail).hexdigest()


class OfficialJournalReader:
    def __init__(self, cache=None, *, home=None):
        self.cache=cache if cache is not None else {}
        self.home=Path.home() if home is None else Path(home).absolute()

    def read(self,receipt,*,now,seconds=.75,freshness_seconds=DEFAULT_SOURCE_TTL):
        if type(now) not in (int,float) or not math.isfinite(now) or type(freshness_seconds) not in (int,float) or not math.isfinite(freshness_seconds) or freshness_seconds<=0:
            return None,'journal-invalid-freshness-clock'
        key=source_key(receipt);old=self.cache.get(key)
        path=locate(receipt,self.home,old)
        if path is None:return None,'journal-missing'
        if not no_symlinks(path):return None,'journal-symlink'
        st=path.stat();identity=[st.st_dev,st.st_ino]
        with path.open('rb') as stream:
            if old and old.get('version')==VERSION and 'lastEventAt' in old.get('state',{}) and old.get('inode')==identity and old.get('offset',0)<=st.st_size and checkpoint_proof(stream,old['offset'])==old.get('proof'):
                state=json.loads(json.dumps(old['state']));offset=old['offset']
            else:
                state=dict(verified=False,invalid=False,events=[],calls={},results={},seq=0,turn=None,opened=False,lastAt=0,lastEventAt=None)
                offset=0
            stream.seek(offset);limit=st.st_size;consumed=0;deadline=time.monotonic()+min(.75,max(.001,seconds))
            try:
                while stream.tell()<limit and consumed<MAX_TICK and time.monotonic()<deadline:
                    start=stream.tell();raw=stream.readline(min(MAX_LINE+1,limit-start))
                    if len(raw)>MAX_LINE:raise ValueError('journal-line-size-limit')
                    if not raw.endswith(b'\n'):
                        stream.seek(start);break  # incomplete append, never persist raw buffer
                    if consumed+len(raw)>MAX_TICK:stream.seek(start);break
                    consumed+=len(raw)
                    row=json.loads(raw)
                    if not isinstance(row,dict):raise ValueError('journal-event-not-object')
                    self.consume(receipt,state,row)
                offset=stream.tell();complete=offset==limit
                entry=dict(version=VERSION,path=str(path),inode=identity,offset=offset,proof=checkpoint_proof(stream,offset),state=state)
                self.cache[key]=entry
            except (ValueError,TypeError,KeyError,OverflowError):
                self.cache.pop(key,None)
                return None,'journal-invalid'
        if state['invalid']:
            reason=state.get('invalidReason')
            return None,'journal-identity-invalid'+(':'+reason if reason in CLAUDE_IDENTITY_ERRORS else '')
        if not complete:return None,'journal-scan-pending'
        if not state['verified']:return None,'journal-unverified'
        calls=[]
        for cid,call in state['calls'].items():
            value=dict(call)
            if cid in state['results']:
                result=state['results'][cid];value.update(state=result['state'],timestamp=max(value['timestamp'],result['timestamp']),sequence=max(value['sequence'],result['sequence']))
            calls.append(value)
        active=[c for c in calls if c['state']=='started']
        recent=sorted((c for c in calls if c['state']!='started'),key=lambda c:(c['timestamp'],c['sequence']))[-4:]
        overflow=len(active)>MAX_CALLS
        last_event=state.get('lastEventAt')
        valid_event=type(last_event) in (int,float) and math.isfinite(last_event) and 0<=last_event<=now
        fresh=bool(valid_event and now-last_event<=freshness_seconds)
        # A certified historical terminal remains known idle. An old open turn,
        # missing timestamp, or future event is never current work or show proof.
        known_ended=bool(valid_event and not state['opened'] and state['events'] and state['events'][-1]['type']=='turn/end')
        current_events=state['events'][-32:] if fresh or known_ended else []
        return dict(header=dict(id=receipt['sessionId'],cwd=receipt['project'],parent=None,depth=0,subagent=False,seeded=False,source='official-'+receipt['harness']+'-journal'),
                    sourceKey=key,lastEventAt=last_event,sourceFresh=fresh,sourceTTL=freshness_seconds,knownEnded=known_ended,
                    usages=[dict(name='shipboss',seq=0,at=receipt['activatedAt'])],activity=current_events,
                    tools=[] if overflow or not fresh else active+recent,toolOverflow=overflow,activitySourceInvalid=False,jobs=[],questions=[]),None

    def event(self,state,kind,at,turn):
        if at<state['lastAt']:raise ValueError('journal-clock-regression')
        state['lastAt']=at
        state['lastEventAt']=at
        entry=dict(type=kind,at=at,turn=turn,step=None)
        if kind=='turn/start':state['events']=[entry]
        else:
            state['events'].append(entry)
            if len(state['events'])>32:state['events']=[state['events'][0]]+state['events'][-31:]

    def call(self,receipt,state,at,raw_id,name,args):
        cid=native_call_id(raw_id,source_key(receipt))
        if cid is None:raise ValueError('invalid-journal-call-id')
        # Namespace even ordinary IDs across harnesses sharing UUID/root.
        cid='journal-'+hashlib.sha256((source_key(receipt)+'\0'+cid).encode()).hexdigest()
        normalized=call_metadata({'name':name,'callId':'wire'},args)
        if normalized is None:raise ValueError('invalid-journal-tool')
        if cid not in state['calls']:
            if len(state['calls'])>=256:raise ValueError('journal-call-metadata-limit')
            state['calls'][cid]=dict(callId=cid,category=normalized['category'],target=normalized['target'],state='started',startedAt=at*1000,timestamp=at*1000,sequence=state['seq'])
        self.event(state,'tool',at,state['turn'])

    def result(self,receipt,state,at,raw_id,error=False):
        raw=native_call_id(raw_id,source_key(receipt))
        if raw is None:raise ValueError('invalid-journal-result-id')
        cid='journal-'+hashlib.sha256((source_key(receipt)+'\0'+raw).encode()).hexdigest()
        if cid not in state['results'] and len(state['results'])>=256:raise ValueError('journal-result-metadata-limit')
        state['results'][cid]=dict(state='error' if error else 'ended',timestamp=at*1000,sequence=state['seq'])
        self.event(state,'tool',at,state['turn'])

    def consume(self,r,s,row):
        s['seq']+=1
        typ=row.get('type');at=epoch(row.get('timestamp'))
        if r['harness']=='codex':
            p=row.get('payload');p=p if isinstance(p,dict) else {}
            kind=p.get('type')
            if typ=='session_meta':
                source=p.get('source')
                if s['verified'] or p.get('id')!=r['sessionId'] or canonical_project(p.get('cwd'))!=r['project'] or source not in ('exec','cli','vscode') or p.get('thread_source') not in (None,'user','cli','exec','vscode') or any(p.get(k) is not None for k in ('parent_thread_id','parentSession','forked_from_id')):
                    s['invalid']=True;return
                if p.get('session_id') not in (None,r['sessionId']):s['invalid']=True;return
                s['verified']=True;return
            if typ=='turn_context':
                if canonical_project(p.get('cwd'))!=r['project']:s['invalid']=True
                return
            if typ not in ('event_msg','response_item'):return
            relevant=typ=='event_msg' and kind in ('task_started','task_complete','task_aborted') or typ=='response_item' and kind in ('function_call','function_call_output')
            if not relevant:return  # reasoning/messages never examined
            if not s['verified'] or at is None:s['invalid']=True;return
            if typ=='event_msg':
                turn=p.get('turn_id')
                attribution=p.get('turn_attribution')
                if p.get('root_turn_id') not in (None,turn) or attribution is not None and (not isinstance(attribution,dict) or attribution.get('parent_turn_id') is not None or attribution.get('initiating_agent_path') is not None or attribution.get('root_turn_id') not in (None,turn)):
                    s['invalid']=True;return
                if not valid_id(turn):s['invalid']=True;return
                # Task timestamps are explicit lifecycle facts, not text chunks.
                task_time=epoch(p.get('started_at') if kind=='task_started' else p.get('completed_at'))
                at=max(at,task_time) if task_time is not None else at
                if kind=='task_started':
                    s['turn']=turn;s['opened']=True;self.event(s,'turn/start',at,turn)
                elif s['opened'] and turn==s['turn']:
                    self.event(s,'turn/end',at,turn);s['opened']=False
            elif s['opened']:
                if kind=='function_call':
                    name=p.get('name');mapping={'exec_command':'bash','shell_command':'bash','read_file':'read','list_dir':'glob','apply_patch':'edit'}
                    args=p.get('arguments');args=json.loads(args) if isinstance(args,str) and len(args)<=MAX_LINE else args
                    args=args if isinstance(args,dict) else {}
                    self.call(r,s,at,p.get('call_id'),mapping.get(name,name),args)
                else:self.result(r,s,at,p.get('call_id'),p.get('is_error') is True)
        else:
            if typ not in ('user','assistant'):return
            reason=claude_identity_reason(r,row)
            if reason:
                invalidate_claude(s,reason);return
            if row.get('parent_tool_use_id') is not None or row.get('sourceToolAssistantUUID') and row.get('isSidechain') is not False:
                return
            s['verified']=True
            msg=row.get('message');msg=msg if isinstance(msg,dict) else {}
            blocks=msg.get('content');blocks=blocks if isinstance(blocks,list) else []
            # Ignore text/thinking contents completely; a primary user message
            # starts coarse work, a tool-result user message does not start anew.
            results=[b for b in blocks if isinstance(b,dict) and b.get('type')=='tool_result']
            if typ=='user' and not results:
                turn=row.get('uuid')
                if not valid_id(turn):invalidate_claude(s,'claude-turn-id-invalid');return
                s['turn']=turn;s['opened']=True;self.event(s,'turn/start',at,turn)
            if s['opened']:
                for b in blocks[:128]:
                    if not isinstance(b,dict):continue
                    if typ=='assistant' and b.get('type')=='tool_use':
                        names={'Read':'read','Write':'write','Edit':'edit','Bash':'bash','Glob':'glob','Grep':'grep','WebSearch':'web_search','WebFetch':'web_fetch','Agent':'subagent','Task':'subagent'}
                        args=b.get('input') if isinstance(b.get('input'),dict) else {}
                        self.call(r,s,at,b.get('id'),names.get(b.get('name'),'unknown'),args)
                    elif typ=='user' and b.get('type')=='tool_result':self.result(r,s,at,b.get('tool_use_id'),b.get('is_error') is True)
                if typ=='assistant' and msg.get('stop_reason') in ('end_turn','stop_sequence','max_tokens'):
                    self.event(s,'turn/end',at,s['turn']);s['opened']=False
        # Bound long certified histories by retaining unfinished and recent IDs.
        if len(s['calls'])>128:
            completed=[k for k in s['calls'] if k in s['results']]
            for cid in completed[:-4]:s['calls'].pop(cid,None);s['results'].pop(cid,None)


def claude_metadata_sample(receipt, *, home=None, now=None):
    """Read one exact declared journal, returning only comparison enums/types.

    This opt-in diagnostic does not activate, cache or persist any journal data.
    It reads at most 32 lines/256 KiB and never returns raw field values.
    """
    import stat
    import uuid
    uuid.UUID(receipt['sessionId'])
    if receipt.get('harness')!='claude' or canonical_project(receipt.get('project'))!=receipt.get('project'):
        raise ValueError('exact absolute Claude project and session required')
    now=time.time() if now is None else now
    path=locate(receipt,Path.home() if home is None else Path(home))
    report=dict(version=1,kind='claude-journal-metadata',status='journal-missing',rows=[])
    if path is None:return report
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('journal must be a regular file')
        total=0
        for number in range(1,33):
            raw=stream.readline(256*1024-total+1)
            if not raw:
                report['status']='complete';break
            total+=len(raw)
            if total>256*1024:
                report['status']='sample-byte-limit';break
            if not raw.endswith(b'\n'):
                report['status']='partial-line';break
            try:row=json.loads(raw)
            except (ValueError,UnicodeError):
                report['status']='invalid-json';break
            if not isinstance(row,dict):
                report['status']='invalid-row';break
            typ=row.get('type')
            if typ not in ('user','assistant'):continue
            stamp=epoch(row.get('timestamp'))
            clock=('invalid' if stamp is None else 'future' if stamp>now else
                   'fresh' if now-stamp<=DEFAULT_SOURCE_TTL else 'stale')
            report['rows'].append(dict(line=number,eventType=typ,
                session='missing' if 'sessionId' not in row else 'match' if row.get('sessionId')==receipt['sessionId'] else 'mismatch',
                cwd='missing' if 'cwd' not in row else 'match' if canonical_project(row.get('cwd'))==receipt['project'] else 'invalid' if canonical_project(row.get('cwd')) is None else 'mismatch',
                sidechain='missing' if 'isSidechain' not in row else 'false' if row['isSidechain'] is False else 'true' if row['isSidechain'] is True else 'invalid-type',
                parentToolUsePresent=row.get('parent_tool_use_id') is not None,
                turnIdValid=valid_id(row.get('uuid')),timestamp=clock,
                identityReason=claude_identity_reason(receipt,row)))
        else:report['status']='sample-line-limit'
    return report


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description='Bounded Claude metadata diagnostics; no model calls or raw body output.')
    parser.add_argument('action',choices=['claude-metadata'])
    parser.add_argument('--project',required=True)
    parser.add_argument('--session-id',required=True)
    args=parser.parse_args()
    try:
        receipt=dict(harness='claude',project=str(Path(args.project).resolve()),sessionId=args.session_id)
        print(json.dumps(claude_metadata_sample(receipt)))
    except (OSError,ValueError,KeyError,TypeError):
        print(json.dumps(dict(version=1,kind='claude-journal-metadata',status='diagnostic-read-failed',rows=[])))
        raise SystemExit(1)
