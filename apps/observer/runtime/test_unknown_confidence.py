"""Unknown-confidence regressions: never infer activity from unowned/corrupt evidence."""
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from discovery import DiscoveryIndex, extract
from events import EventReader
from observer_state import build_project
from registry import activate,bind,update

class UnknownConfidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.base=Path(self.tmp.name).resolve();self.project=self.base/'project';self.project.mkdir()
        self.now=time.time();self.home=self.base/'dsh'
        self.file=self.project/'session.jsonl'
    def events(self,owner='missing'):
        job={'jobId':'j'}
        if owner!='missing':job['owner']=owner
        return [dict(type='session',id='pm',cwd=str(self.project),createdAt=(self.now-1000)*1000,delegationDepth=0,isSeeded=False),
            dict(type='user/message',seq=0,time=(self.now-900)*1000,data={'source':{'kind':'skill-invocation','name':'shipboss','form':'instructions'}}),
            dict(type='turn/end',seq=1,time=(self.now-800)*1000,data={'turn':1}),
            dict(type='job/started',seq=2,time=(self.now-1)*1000,data=job)]
    def write(self,path,events):
        path.parent.mkdir(parents=True,exist_ok=True);path.write_text('\n'.join(json.dumps(e) for e in events)+'\n')
    def test_missing_owner_job_unknown_not_pm_proof_including_cached_migration(self):
        path=self.home/'sessions/x/pm/session.jsonl';self.write(path,self.events())
        index_path=self.base/'index.json';index=DiscoveryIndex(self.home,index_path)
        p=index.build(now=self.now)['projects'][0]
        self.assertFalse(p['actors'][0]['active']);self.assertEqual(p['observation']['status'],'unknown')
        # Simulate a previously accepted v2 entry. Preserve room order but decode
        # the unchanged file again so an old unowned job cannot survive migration.
        old=json.loads(index_path.read_text());order=old['order'][:]
        for entry in old['files'].values():
            entry['signature'][-1]='presence-v2'
            entry['metadata']['jobs']=[{'type':'job/started','at':self.now-1}]
        index_path.write_text(json.dumps(old))
        restarted=DiscoveryIndex(self.home,index_path);p=restarted.build(now=self.now)['projects'][0]
        self.assertEqual(restarted.loads,1);self.assertEqual(restarted.data['order'],order)
        self.assertFalse(p['actors'][0]['active'])
        for owner,expected in [(None,False),('foreign',False),('pm',True)]:
            self.write(path,self.events(owner));p=restarted.build(now=self.now)['projects'][0]
            self.assertEqual(p['actors'][0]['active'],expected)
    def test_corrupt_owner_prefix_unknown_but_independent_worker_stays_running(self):
        activate(self.project,'pm','pm',str(self.file))
        with patch('registry.time.time',return_value=self.now-2):
            bind(self.project,assignment='worker',task='TASK',role='engineer',slot='eng-b',policy='new',context_id='worker',session_id='worker',job_id='job-worker')
            update(self.project,'worker',state='running')
        records=self.events('pm')[:1]+[dict(type='turn/start',time=(self.now-1)*1000,data={'turn':1})]
        reader=EventReader()
        for broken in ['{broken','[]','{}',json.dumps({'type':'turn/end','time':self.now*1000,'data':['bad']}),json.dumps({'type':'turn/end','time':self.now*1000,'data':[]}),json.dumps({'type':'turn/end','time':self.now*1000,'data':None})]:
            self.write(self.file,records)
            with self.file.open('a') as f:f.write(broken+'\n')
            before=(self.project/'.delegate/observer/runtime.json').read_bytes()
            p=build_project(self.project,reader=reader,auto=True,now=self.now)
            self.assertFalse(p['actors'][0]['active']);self.assertTrue(p['actors'][0]['uncertain'])
            self.assertTrue(p['actors'][2]['active']);self.assertFalse(p['actors'][2]['uncertain'])
            self.assertIn('malformed owner event',p['activity']);self.assertNotEqual(p['status'],'done')
            self.assertEqual(before,(self.project/'.delegate/observer/runtime.json').read_bytes())
            with self.assertRaises(ValueError):extract(self.file,{})
        # A repaired full observation recovers without reviving/rewriting workers.
        self.write(self.file,records)
        self.assertTrue(build_project(self.project,reader=reader,auto=True,now=self.now)['actors'][0]['active'])

if __name__=='__main__':unittest.main()
