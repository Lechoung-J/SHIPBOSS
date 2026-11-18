"""Only activated fixture cwds' exact registries may overlay discovered rooms."""
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from discovery import DiscoveryIndex
from registry import activate, bind, update


class RegisteredRoomTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.base=Path(self.tmp.name).resolve();self.project=self.base/'external';self.project.mkdir()
        self.home=self.base/'dsh';self.now=time.time()
        self.session('pm')
        with patch('registry.time.time',return_value=self.now-100):
            activate(self.project,'pm','pm')
        self.path=self.project/'.delegate/observer/runtime.json'
        self.index=DiscoveryIndex(self.home,self.base/'index.json')

    def session(self,sid,cwd=None,activated=True):
        p=self.home/'sessions/x'/sid/'session.jsonl';p.parent.mkdir(parents=True,exist_ok=True)
        events=[dict(type='session',id=sid,cwd=str(cwd or self.project),delegationDepth=0,isSeeded=False)]
        if activated:events.append(dict(type='user/message',seq=0,time=(self.now-800)*1000,data={'source':{'kind':'skill-invocation','name':'shipboss','form':'instructions'}}))
        events.append(dict(type='turn/end',seq=len(events)-1,time=(self.now-700)*1000,data={'turn':1}))
        p.write_text('\n'.join(json.dumps(e) for e in events)+'\n')

    def write(self,d):self.path.write_text(json.dumps(d))
    def data(self):return json.loads(self.path.read_text())
    def worker(self,assignment='impl',slot='eng-b',role='engineer',task='TASK',at=None,**kw):
        with patch('registry.time.time',return_value=self.now-10 if at is None else at):
            bind(self.project,assignment=assignment,task=task,role=role,slot=slot,policy='fresh' if role=='verifier' else 'new',context_id=assignment,session_id=assignment,job_id='job-'+assignment,**kw)
            update(self.project,assignment,state='running')
    def build(self):return self.index.build(now=self.now)

    def test_running_readonly_no_owner_path_and_waiting_pm(self):
        self.worker()
        d=self.data();d['session_file']='/forbidden/session.jsonl';self.write(d)
        before=self.path.read_bytes()
        # Prohibit following even a valid-looking session_file, writes/locks,
        # or the old registry reader (only the already parsed exact file is used).
        with patch('events.EventReader.read',side_effect=AssertionError('extra owner file')), patch('observer_state.read',side_effect=AssertionError('extra registry read')), patch('registry.atomic_write',side_effect=AssertionError('write')):
            p=self.build()['projects'][0]
        self.assertEqual(self.path.read_bytes(),before)
        self.assertTrue(p['actors'][2]['active']);self.assertEqual(p['actors'][2]['taskId'],'TASK')
        self.assertEqual(p['actors'][0]['motion'],'waiting');self.assertFalse(p['needsAttention'])
        self.assertFalse(p['isIdle']);self.assertEqual(p['engineerCount'],1)
        self.assertEqual(p['tasks'][0]['status'],'implementing')

    def test_expired_terminal_superseded_and_verdict(self):
        self.worker(at=self.now-1000)
        p=self.build()['projects'][0];self.assertFalse(p['actors'][2]['active']);self.assertTrue(p['actors'][2]['uncertain'])
        with patch('registry.time.time',return_value=self.now-20):update(self.project,'impl',state='completed')
        p=self.build()['projects'][0];self.assertFalse(p['actors'][2]['active']);self.assertFalse(p['actors'][2]['uncertain']);self.assertEqual(p['tasks'][0]['verification'],'queued')
        with patch('registry.time.time',return_value=self.now-10):
            bind(self.project,assignment='next',task='TASK',role='engineer',slot='eng-b',policy='resume',context_id='impl',session_id='impl',job_id='next-job',predecessor='impl')
            update(self.project,'next',state='running')
        self.worker('review','verifier','verifier',task='REVIEW',revision='rev1')
        with patch('registry.time.time',return_value=self.now-5):update(self.project,'review',state='completed',verdict='FAIL',revision='rev1')
        before=self.path.read_bytes();p=self.build()['projects'][0]
        self.assertEqual(self.path.read_bytes(),before)
        self.assertTrue(p['actors'][2]['active']);self.assertEqual(len([t for t in p['tasks'] if t['id']=='TASK']),1)
        review=next(t for t in p['tasks'] if t['id']=='REVIEW');self.assertEqual(review['verdict'],'FAIL');self.assertEqual(review['status'],'rework')

    def test_invalid_inactive_or_wrong_owner_project_no_worker(self):
        self.worker();valid=self.data()
        self.session('elsewhere',cwd=self.base/'elsewhere')
        for field,value in [('owner_session','elsewhere'),('owner_session','not-activated'),('project',str(self.base/'wrong')),('active',False)]:
            d={**valid,field:value};self.write(d);before=self.path.read_bytes()
            p=self.build()['projects'][0]
            self.assertFalse(p['actors'][2]['active']);self.assertEqual(self.path.read_bytes(),before)
        self.path.write_text('{broken');self.assertFalse(self.build()['projects'][0]['actors'][2]['active'])
        self.path.unlink();self.assertFalse(self.build()['projects'][0]['actors'][2]['active'])

    def test_unactivated_excluded_and_symlink_do_not_overlay(self):
        self.worker();before=self.path.read_bytes()
        self.session('pm',activated=False)
        with patch('discovery.discovered_registry',side_effect=AssertionError('must not inspect nonactivated cwd')):
            self.assertEqual(self.build()['projects'],[])
        self.session('pm')
        excluded=DiscoveryIndex(self.home,self.base/'excluded.json',exclude=(str(self.project),))
        with patch('discovery.discovered_registry',side_effect=AssertionError('excluded')):
            self.assertEqual(excluded.build(now=self.now)['projects'],[])
        target=self.base/'untouched.json';target.write_bytes(before);self.path.unlink();self.path.symlink_to(target)
        self.assertFalse(self.build()['projects'][0]['actors'][2]['active']);self.assertEqual(target.read_bytes(),before)

    def test_tick_read_race_skew_bounded_not_future_execution(self):
        self.worker(at=self.now+.1);self.assertTrue(self.build()['projects'][0]['actors'][2]['active'])
        d=self.data();d['assignments']['impl']['updated_at']=self.now+6;self.write(d)
        self.assertFalse(self.build()['projects'][0]['actors'][2]['active'])

if __name__=='__main__':unittest.main()
