"""Bounded stdout sidecar for explicitly managed Codex/Claude launches.

Codex exec --json: item.started/updated/completed (command_execution,
file_change, mcp_tool_call, web_search). Claude stream-json: assistant tool_use,
user tool_result; stream_event content_block_start for early tool indication.
Text, thinking deltas, commands, searches and result bodies are never retained.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import time

from registry import atomic_write, read, identifier
from tool_activity import native_call_id, call_metadata, valid_id, display_target

MAX_STREAM_LINE = 1024*1024


def stream_path(root, assignment):
    identifier(assignment)
    root=Path(root).resolve()
    path=root/'.delegate/observer/streams'/(assignment+'.json')
    for parent in (path,*path.parents):
        if parent.is_symlink():
            raise ValueError('stream path symlink')
        if parent==root: break
    return path


class StreamAdapter:
    def __init__(self, root, assignment, source, *, now=time.time):
        self.root,self.assignment,self.source,self.now=root,assignment,source,now
        d=read(root);r=d['assignments'][assignment]
        if r.get('source')!=source or source not in ('codex','claude') or not r.get('launch_id') or r['state']!='running':
            raise ValueError('stream requires registered active managed CLI launch')
        self.identity=dict(version=1,projectId=d['project_id'],ownerSessionId=d['owner_session'],assignment=assignment,
            launchId=r['launch_id'],source=source,sessionId=r['session_id'])
        self.scope=json.dumps(self.identity,sort_keys=True,separators=(',',':'))
        self.calls={};self.closed={};self.sequence=0;self.transport=None;self.suppressed=False;self.path=stream_path(root,assignment)
        self.persist()

    def persist(self):
        active=sorted((c for c in self.calls.values() if c['state']=='started'),key=lambda c:c['sequence'])
        recent=sorted((c for c in self.calls.values() if c['state']!='started'),key=lambda c:c['sequence'])[-4:]
        if len(active)>32: self.suppressed=True
        selected=[] if self.suppressed else active[-8:]+recent
        value=dict(**self.identity,updatedAt=self.now(),runningCount=0 if self.suppressed else len(active),thinking=False,
                   suppressed=self.suppressed,calls=selected,
                   transport=dict(source=self.source,hostSessionId=self.identity['sessionId'],launchId=self.identity['launchId'],transportSessionId=self.transport))
        value['metadataSha256']=hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        atomic_write(self.path,value)
        # Bound per-launch state independently of the CLI's full stdout volume.
        self.calls={c['callId']:c for c in active[-32:]+recent}
        # Keep terminal identities until a fixed per-launch capacity. At the
        # limit detailed output stops rather than forgetting IDs and replaying.
        if len(self.closed)>4096:
            self.suppressed=True
            self.closed=dict(list(self.closed.items())[:4096])

    def tool(self, raw_id, category, target='', state='started'):
        wire=native_call_id(raw_id,self.scope)
        cid='cli-sha256-'+hashlib.sha256(json.dumps([self.scope,wire],separators=(',',':')).encode()).hexdigest() if wire else None
        if cid is None:
            self.suppressed=True;return
        self.sequence+=1;at=self.now()*1000
        old=self.calls.get(cid)
        if state=='started' and (old or cid in self.closed):
            if old and (target or old['state']!='started'): old.update(category=category,target=target)
            return
        if state!='started' and (cid in self.closed): return
        if len(self.closed)>=4096 and cid not in self.closed:
            self.suppressed=True
            return
        if old is None:
            old=dict(callId=cid,category=category,target=target,startedAt=at,timestamp=at,state=state,sequence=self.sequence)
        if state!='started':
            old.update(state=state,timestamp=at,sequence=self.sequence);self.closed[cid]=state
        self.calls[cid]=old

    def feed(self, row):
        if not isinstance(row,dict): return
        sid=row.get('session_id') if self.source=='claude' else row.get('thread_id')
        if sid is not None:
            from onboarding import actual_session
            try:actual_session(sid)
            except ValueError:self.suppressed=True;self.persist();return
            if self.transport is None: self.transport=sid
            elif self.transport!=sid: self.suppressed=True
        if self.source=='codex':
            kind=row.get('type');item=row.get('item')
            if kind in ('item.started','item.updated','item.completed') and isinstance(item,dict):
                name=item.get('type');category={'command_execution':'command','file_change':'edit','mcp_tool_call':'other','web_search':'search'}.get(name)
                if category:
                    target=''
                    if name=='file_change' and isinstance(item.get('changes'),list) and len(item['changes'])==1:
                        target=call_metadata({'name':'edit','callId':'safe'},{'file_path':item['changes'][0].get('path')}).get('target','')
                    state='started' if kind!='item.completed' else 'error' if item.get('status')=='failed' or item.get('exit_code') not in (None,0) else 'ended'
                    self.tool(item.get('id'),category,target,state)
        else:
            if row.get('parent_tool_use_id') is not None: return  # forwarded child is not this assigned actor
            kind=row.get('type')
            if kind in ('assistant','user') and isinstance(row.get('message'),dict):
                blocks=row['message'].get('content',[])
                if isinstance(blocks,list):
                    for block in blocks[:128]:
                        if not isinstance(block,dict): continue
                        if block.get('type')=='tool_use': self.claude_start(block)
                        elif block.get('type')=='tool_result':
                            self.tool(block.get('tool_use_id'),'other',state='error' if block.get('is_error') is True else 'ended')
            elif kind=='stream_event' and isinstance(row.get('event'),dict):
                event=row['event']
                if event.get('type')=='content_block_start' and isinstance(event.get('content_block'),dict) and event['content_block'].get('type')=='tool_use':
                    self.claude_start(event['content_block'])
        self.persist()

    def claude_start(self, block):
        name=block.get('name');mapping={'Read':'read','Glob':'search','Grep':'search','WebSearch':'search','WebFetch':'search','Edit':'edit','Write':'edit','Bash':'command','Task':'delegate','Agent':'delegate'}
        args=block.get('input') if isinstance(block.get('input'),dict) else {}
        safe=call_metadata({'name':'read' if name=='Read' else 'edit' if name in ('Edit','Write') else 'unknown','callId':'safe'},args)
        self.tool(block.get('id'),mapping.get(name,'other'),safe['target'])


def suppress_metadata(adapter):
    """Observer sink failures never escape into the CLI byte transport."""
    try:
        adapter.suppressed=True
        adapter.persist()
    except Exception:
        pass


def forward_stream(child, adapter):
    buffer=b'';discard=False
    try:
        while True:
            chunk=os.read(child.stdout.fileno(),65536)
            if not chunk: break
            sys.stdout.buffer.write(chunk);sys.stdout.buffer.flush()  # exact CLI bytes, never an observer log
            for part in chunk.splitlines(keepends=True):
                if not discard: buffer+=part
                if len(buffer)>MAX_STREAM_LINE:
                    buffer=b'';discard=True
                    suppress_metadata(adapter)
                if part.endswith(b'\n'):
                    if not discard:
                        try: adapter.feed(json.loads(buffer))
                        except Exception: suppress_metadata(adapter)
                    buffer=b'';discard=False
        if buffer and not discard:
            try: adapter.feed(json.loads(buffer))
            except Exception: suppress_metadata(adapter)
        return child.wait()
    except BaseException:
        # Actual read/output failures cannot preserve a byte stream. Reap only
        # this wrapper's child, then let dispatch emit its failure receipt.
        from dispatch import reap_owned_child
        reap_owned_child(child)
        raise
    finally:
        if child.stdout and not child.stdout.closed: child.stdout.close()


def load_activity(root, registry, record, *, now):
    if record.get('source') not in ('codex','claude') or not record.get('launch_id'): return None
    try:
        path=stream_path(root,record['assignment'])
        if path.stat().st_size>32*1024: return None
        value=json.loads(path.read_text())
        expected=dict(version=1,projectId=registry['project_id'],ownerSessionId=registry['owner_session'],assignment=record['assignment'],
                      launchId=record['launch_id'],source=record['source'],sessionId=record['session_id'])
        if any(value.get(k)!=v for k,v in expected.items()) or not 0<=now-value['updatedAt']<=record['ttl']: return None
        sha=value.pop('metadataSha256',None)
        if hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()!=sha: return None
        if not isinstance(value.get('calls'),list) or len(value['calls'])>12 or type(value.get('runningCount')) is not int or not 0<=value['runningCount']<=32 or type(value.get('suppressed')) is not bool: return None
        clean=[];seen=set()
        for call in value['calls']:
            if not isinstance(call,dict) or not valid_id(call.get('callId')) or call['callId'] in seen or call.get('category') not in ('read','edit','search','command','test','delegate','other') or call.get('state') not in ('started','ended','error') or not isinstance(call.get('target'),str) or call['target'] and not display_target(call['target']): return None
            if type(call.get('sequence')) is not int or not 0<=call['sequence']<=9007199254740991: return None
            if any(type(call.get(k)) not in (int,float) or not 0<=call[k]<=253402300799000 for k in ('startedAt','timestamp')) or call['timestamp']<call['startedAt']: return None
            seen.add(call['callId']);clean.append({k:call[k] for k in ('callId','sequence','state','category','target','startedAt','timestamp')})
        return dict(version=1,projectId=registry['project_id'],actorId=record['slot'],sessionId=record['session_id'],
                    runningCount=value['runningCount'],thinking=False,suppressed=value['suppressed'],calls=clean)
    except (OSError,ValueError,KeyError,TypeError): return None
