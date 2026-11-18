"""Actual >64MiB synthetic native histories; no host logs or project reads."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import uuid

from discovery import DiscoveryIndex
from incremental import IncrementalNative,PendingNative
from onboarding import validate_native_activation
from test_tool_activity import NOW


class IncrementalTests(unittest.TestCase):
    def large(self,path,sid='owner',cwd='/synthetic/large',*,seeded=False):
        path.parent.mkdir(parents=True,exist_ok=True)
        with path.open('wb') as f:
            f.write((json.dumps(dict(type='session',id=sid,cwd=cwd,isSeeded=seeded,delegationDepth=0))+'\n').encode())
            f.write((json.dumps(dict(type='user/message',seq=0,time=(NOW-10)*1000,data={'source':{'kind':'skill-invocation','name':'shipboss','form':'instructions'}}))+'\n').encode())
            for i in range(132):
                f.write((json.dumps(dict(type='assistant/text',seq=i+1,time=(NOW-5)*1000,data={'text':'SECRET_BODY'+('x'*524288)}))+'\n').encode())
            for i,(kind,data) in enumerate([('turn/start',{'turn':1}),('step/start',{'turn':1,'step':1}),('tool/call',{'name':'read','callId':'large-call','arguments':{'file_path':'app.ts','secret':'SECRET_VALUE'}})]):
                f.write((json.dumps(dict(type=kind,seq=133+i,time=(NOW-1)*1000,data=data))+'\n').encode())
        self.assertGreater(path.stat().st_size,64*1024*1024)

    def test_large_plain_budget_progress_checkpoint_restart_append_and_replacement(self):
        with tempfile.TemporaryDirectory() as td:
            base=Path(td).resolve();home=base/'home';p=home/'sessions/encoded/owner/session.jsonl';self.large(p)
            index=DiscoveryIndex(home,base/'index.json')
            pending=0
            for _ in range(16):
                state=index.build(now=NOW)
                if state['projects']:break
                pending+=1
            self.assertGreater(pending,0);self.assertLess(pending,16)
            self.assertEqual(state['projects'][0]['actors'][0]['toolActivity']['calls'][0]['target'],'app.ts')
            self.assertNotIn('SECRET',index.path.read_text());self.assertLess(index.path.stat().st_size,100000)
            restarted=DiscoveryIndex(home,index.path);self.assertEqual(restarted.build(now=NOW)['projects'][0]['id'],state['projects'][0]['id']);self.assertEqual(restarted.loads,0)
            with p.open('a') as f:f.write(json.dumps(dict(type='tool/result',seq=136,time=NOW*1000,data={'message':{'toolCallId':'large-call','isError':False}}))+'\n')
            result=restarted.build(now=NOW)
            self.assertEqual(result['projects'][0]['actors'][0]['toolActivity']['calls'][0]['state'],'ended')
            self.assertEqual(restarted.loads,1,'certified plain checkpoint only reads the appended tail')
            replacement=p.with_name('replacement');replacement.write_text('{broken\n');replacement.replace(p)
            self.assertEqual(restarted.build(now=NOW)['projects'],[],'replacement cannot inherit activation checkpoint')
            index.incremental.close();restarted.incremental.close()

    def test_large_seeded_without_final_boundary_never_activates(self):
        with tempfile.TemporaryDirectory() as td:
            base=Path(td).resolve();p=base/'home/sessions/encoded/owner/session.jsonl';self.large(p,seeded=True)
            index=DiscoveryIndex(base/'home',base/'index.json')
            for _ in range(16):state=index.build(now=NOW)
            self.assertEqual(state['projects'],[])
            self.assertTrue(any('seed-boundary' in w for w in state['coverage']['warnings']))
            index.incremental.close()

    @unittest.skipUnless(shutil.which('zstd'),'installed local zstd required')
    def test_compressed_pinned_snapshot_progress_with_every_tick_append_and_atomic_rewrite(self):
        for atomic in (False,True):
            with self.subTest(atomic=atomic),tempfile.TemporaryDirectory() as td:
                base=Path(td).resolve();source=base/'source.jsonl';self.large(source)
                path=base/'home/sessions/encoded/owner/session.v4.jsonl.zstd';path.parent.mkdir(parents=True)
                compressed=subprocess.run(['zstd','-q','-c',str(source)],capture_output=True,check=True).stdout
                path.write_bytes(compressed)
                index=DiscoveryIndex(base/'home',base/'index.json')
                completed=None
                for tick in range(16):
                    state=index.build(now=NOW)
                    if state['projects']:
                        completed=state;break
                    event=json.dumps(dict(type='step/start',seq=136+tick,time=NOW*1000,data={'turn':1,'step':tick+2})).encode()+b'\n'
                    frame=subprocess.run(['zstd','-q','-c'],input=event,capture_output=True,check=True).stdout
                    if atomic:
                        compressed+=frame;new=path.with_name('new.zstd');new.write_bytes(compressed);new.replace(path)
                    else:
                        with path.open('ab') as f:f.write(frame)
                self.assertIsNotNone(completed,'ongoing writes must not reset fixed input every tick')
                self.assertEqual(completed['projects'][0]['actors'][0]['toolActivity']['calls'][0]['callId'],'large-call')
                self.assertNotIn('SECRET',index.path.read_text())
                # A second pinned snapshot incorporates the fresh appended tail.
                for _ in range(16):
                    state=index.build(now=NOW)
                    entry=next(iter(index.data['files'].values()))
                    if not entry.get('pending') and entry['signature'][3]==path.stat().st_size:break
                self.assertEqual(state['projects'][0]['actors'][0]['toolActivity']['sessionId'],'owner')
                index.incremental.close()

    def test_large_first_load_validation_advances_beyond_one_tick(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve();sid=str(uuid.uuid4());p=root/'session.jsonl';self.large(p,sid,str(root))
            value=validate_native_activation(root,sid,p)
            self.assertTrue(value['pm_capable']);self.assertEqual(value['session_id'],sid)


if __name__=='__main__':unittest.main()
