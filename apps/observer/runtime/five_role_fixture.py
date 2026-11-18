"""Isolated five-role native fixture producer for source and exact-app GUI checks."""
import argparse
from datetime import datetime,timezone
import json
from pathlib import Path
import time
import uuid

from discovery import DiscoveryIndex
from registry import activate,bind,update,read,atomic_write
from test_tool_activity import native

SLOTS=['pm','eng-a','eng-b','verifier','recording']


def make_fixture(directory,now=None):
    now=time.time() if now is None else now
    directory=Path(directory).resolve();directory.mkdir(parents=True,exist_ok=True)
    home=directory/'dsh';roots=[]
    for project_index in range(2):
        root=directory/('five-roles' if project_index==0 else 'second-project');root.mkdir(exist_ok=True);roots.append(root)
        owner=str(uuid.uuid4());activate(root,owner,owner)
        ids={'pm':owner};records=[]
        for slot in SLOTS[1:]:
            sid=str(uuid.uuid4());ids[slot]=sid;role='engineer' if slot.startswith('eng-') else slot
            bind(root,assignment='launch-'+slot,task='task-'+slot,role=role,slot=slot,policy='fresh' if slot=='verifier' else 'new',context_id=sid,session_id=sid,agent_id='agent-'+slot,revision='synthetic-revision' if slot=='verifier' else None)
            update(root,'launch-'+slot,state='running' if project_index==0 else 'completed',exit_code=None if project_index==0 else 0)
        registry=read(root)
        registry['activated_at']=now-30
        for r in registry['assignments'].values():r.update(bound_at=now-20,updated_at=now-1)
        atomic_write(root/'.delegate/observer/runtime.json',registry)
        for i,slot in enumerate(SLOTS):
            sid=ids[slot];events=[]
            if slot=='pm':events.append(('user/message',now-25,{'source':{'kind':'skill-invocation','form':'instructions','name':'shipboss'}}))
            else:events.append(('subagent/descriptor',now-15,{'name':'fixture-worker'}))
            events += [('turn/start',now-10,{'turn':1}),('step/start',now-2,{'turn':1,'step':1})]
            name=['read','edit','bash','grep','read'][i]
            call_id='call-'+slot+'|'+('a'*82)
            args={'file_path':'src/app.ts'} if name in ('read','edit') else {'command':'SECRET_COMMAND'} if name=='bash' else {'pattern':'SECRET_QUERY'}
            if project_index==0:events.append(('tool/call',now-1,{'name':name,'callId':call_id,'arguments':args}))
            else:events.append(('turn/end',now-1,{'turn':1}))
            path=home/'sessions/encoded'/sid/'session.jsonl';native(path,sid,root,events,None if slot=='pm' else owner)
            records.append(dict(role=slot,sessionId=sid,path=str(path),callId=call_id))
        if project_index==0:main=dict(root=str(root),records=records,ids=ids)
    control=dict(version=1,home=str(home),**main)
    atomic_write(directory/'control.json',control)
    return control


def transition(directory,action,role,now):
    directory=Path(directory).resolve();control=json.loads((directory/'control.json').read_text())
    row=next(r for r in control['records'] if r['role']==role);path=Path(row['path'])
    rows=[json.loads(line) for line in path.read_text().splitlines()]
    if action in ('thinking','result','error'):
        rows.append(dict(type='tool/result',seq=len(rows)-1,time=now*1000,data={'message':{'toolCallId':row['callId'],'isError':action=='error'}}))
        if action=='thinking':rows.append(dict(type='step/start',seq=len(rows)-1,time=now*1000,data={'turn':1,'step':2}))
    elif action=='tool':
        row['callId']='new-'+uuid.uuid4().hex+'|'+role
        rows.append(dict(type='tool/call',seq=len(rows)-1,time=now*1000,data={'name':'read','callId':row['callId'],'arguments':{'file_path':'src/latest.ts'}}))
        atomic_write(directory/'control.json',control)
    elif action in ('unknown','exit'):
        registry=read(control['root'])
        if role=='pm':
            if action=='exit':rows.append(dict(type='turn/end',seq=len(rows)-1,time=now*1000,data={'turn':1}))
            else:
                rows.append(dict(type='step/start',seq=len(rows)-1,time=now*1000,data={'turn':1,'step':3,'source':42}))
        else:
            r=registry['assignments']['launch-'+role];r.update(state='unknown' if action=='unknown' else 'completed',updated_at=now)
            atomic_write(Path(control['root'])/'.delegate/observer/runtime.json',registry)
    path.write_text('\n'.join(json.dumps(r) for r in rows)+'\n')


def build_fixture(directory,now):
    directory=Path(directory).resolve();control=json.loads((directory/'control.json').read_text())
    state=DiscoveryIndex(control['home'],directory/'index.json').build(now=now)
    state['generatedAt']=datetime.now(timezone.utc).isoformat()
    state['source']='EXAMPLE-054 synthetic native five-role fixture; not actual user work'
    for p in state['projects']:p['source']='synthetic five-role native fixture'
    return state


if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--directory',required=True);ap.add_argument('--out',required=True);ap.add_argument('--action',default='init');ap.add_argument('--role',default='pm');ap.add_argument('--clock',type=float,default=time.time())
    a=ap.parse_args()
    if a.action=='init':make_fixture(a.directory,a.clock)
    else:transition(a.directory,a.action,a.role,a.clock)
    atomic_write(a.out,build_fixture(a.directory,a.clock))
