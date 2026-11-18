import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from registry import activate, bind, read, update
from observer_state import build_project

CLI = Path(__file__).with_name('runtime.py')

class StageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        activate(self.root, 'pm', 'pm')
        bind(self.root, assignment='impl', task='T', role='engineer', slot='eng-a', policy='new',
             context_id='eng', session_id='eng', job_id='job')
        update(self.root, 'impl', state='running', phase='reading')
    def launch(self, code):
        return subprocess.Popen([sys.executable, str(CLI), '--root', str(self.root), 'stage', 'impl',
            '--phase', 'testing', '--', sys.executable, '-c', code], stderr=subprocess.PIPE)
    def wait_phase(self):
        until=time.monotonic()+3
        while time.monotonic()<until:
            if read(self.root)['assignments']['impl']['phase']=='testing': return
            time.sleep(.01)
        self.fail('stage not started')
    def test_real_stage_snapshot_exit_and_restore_not_complete(self):
        p=self.launch('import time; time.sleep(.4); raise SystemExit(7)'); self.wait_phase()
        a=build_project(self.root)['actors'][1]
        self.assertEqual(a['motion'],'testing'); self.assertTrue(a['active'])
        self.assertEqual(p.wait(),7); p.stderr.close()
        r=read(self.root)['assignments']['impl']
        self.assertEqual((r['phase'],r['state'],r['verdict']),('reading','running',None))
    def test_concurrent_and_manual_phase_compare_restore(self):
        p=self.launch('import time; time.sleep(.5)'); self.wait_phase()
        second=self.launch('raise SystemExit(99)'); self.assertEqual(second.wait(),2); second.stderr.close()
        update(self.root,'impl',phase='thinking'); self.assertEqual(p.wait(),0); p.stderr.close()
        self.assertEqual(read(self.root)['assignments']['impl']['phase'],'thinking')
    def test_signal_and_spawn_failure_restore(self):
        p=self.launch('import time; time.sleep(20)'); self.wait_phase(); p.send_signal(signal.SIGTERM)
        self.assertEqual(p.wait(timeout=5),143); p.stderr.close()
        self.assertEqual(read(self.root)['assignments']['impl']['phase'],'reading')
        result=subprocess.run([sys.executable,str(CLI),'--root',str(self.root),'stage','impl','--phase','testing','--','/no-such-stage-command'],capture_output=True)
        self.assertEqual(result.returncode,127)
        self.assertEqual(read(self.root)['assignments']['impl']['phase'],'reading')
    def test_reject_nonrunning_terminal_nonengineer_and_unknown(self):
        for state in ('unknown','blocked','completed'):
            update(self.root,'impl',state=state)
            p=self.launch('raise SystemExit(99)'); self.assertEqual(p.wait(),2); p.stderr.close()
        bind(self.root,assignment='rec',task='R',role='recording',slot='recording',policy='new',context_id='rec',session_id='rec',job_id='rec-job')
        update(self.root,'rec',state='running')
        from stage import run_stage
        for assignment in ('rec','missing'):
            with self.assertRaises((ValueError,KeyError)):
                run_stage(self.root,assignment,'testing',[sys.executable,'-c','pass'])
    def test_abandoned_token_recovers_under_released_lock(self):
        from registry import transaction
        with transaction(self.root) as data:
            data['assignments']['impl'].update(phase='testing', stage=dict(token='abandoned', previous='reading'))
        p=self.launch('pass'); self.assertEqual(p.wait(),0);p.stderr.close()
        r=read(self.root)['assignments']['impl']
        self.assertEqual(r['phase'],'reading');self.assertNotIn('stage',r)

    def test_unknown_lifecycle_freezes_but_fresh_global_pm_clears_uncertainty(self):
        from discovery import DiscoveryIndex
        update(self.root,'impl',state='unknown')
        self.assertTrue(build_project(self.root)['actors'][1]['uncertain'])
        update(self.root,'impl',state='running')
        self.assertFalse(build_project(self.root)['actors'][1]['uncertain'])
        home=self.root/'dsh'; p=home/'sessions/encoded/pm/session.jsonl'
        p.parent.mkdir(parents=True)
        now=time.time()
        p.write_text('\n'.join(json.dumps(e) for e in [
            dict(type='session',id='pm',cwd=str(self.root),isSeeded=False),
            dict(type='user/message',seq=0,time=now*1000,data=dict(source=dict(kind='skill-invocation',name='shipboss',form='instructions'))),
            dict(type='turn/start',seq=1,time=now*1000,data=dict(turn=1))])+'\n')
        project=DiscoveryIndex(home,self.root/'index.json').build(now=now,explicit_roots=[self.root])['projects'][0]
        self.assertTrue(project['actors'][0]['active'])
        self.assertFalse(project['actors'][0]['uncertain'])
        expired=DiscoveryIndex(home,self.root/'index.json').build(now=now+600)['projects'][0]
        self.assertFalse(expired['actors'][0]['active'])
        self.assertTrue(expired['actors'][0]['uncertain'])

    def test_finish_during_stage_not_overwritten(self):
        p=self.launch('import time; time.sleep(.3)'); self.wait_phase()
        update(self.root,'impl',state='completed',exit_code=0)
        self.assertEqual(p.wait(),0);p.stderr.close()
        r=read(self.root)['assignments']['impl'];self.assertEqual(r['state'],'completed');self.assertNotIn('stage',r)
