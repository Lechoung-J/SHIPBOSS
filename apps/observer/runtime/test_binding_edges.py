"""Binding edge cases, including natural post-launch binding."""
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from events import EventReader, apply
from observer_state import build_project
from registry import activate, bind, read, update


class BindingEdgeTests(unittest.TestCase):
    def setup_project(self, td):
        root = Path(td).resolve()
        log = root / 'session.jsonl'
        log.write_text('')
        activate(root, 'owner', 'owner-context', str(log))
        return root, log

    def test_same_continuable_agent_can_resume_three_times(self):
        with tempfile.TemporaryDirectory() as td:
            root, _ = self.setup_project(td)
            for index in range(3):
                bind(root, assignment=f'run-{index}', task='TASK', role='engineer', slot='eng-a',
                     policy='new' if index == 0 else 'resume', context_id='impl-context', session_id='impl-session',
                     agent_id='actual-persistent-agent', predecessor=None if index == 0 else f'run-{index-1}')
                update(root, f'run-{index}', state='completed', exit_code=0)

    def test_actual_job_starts_before_returned_id_can_be_bound(self):
        with tempfile.TemporaryDirectory() as td:
            root, log = self.setup_project(td)
            now = time.time()
            events = [
                {'type':'session', 'id':'owner', 'cwd':str(root), 'createdAt':int((now-100)*1000)},
                {'type':'job/registered', 'time':int((now-.003)*1000),
                 'data':{'owner':'owner', 'jobId':'actual-new-job', 'kind':'bash'}},
            ]
            log.write_text('\n'.join(json.dumps(x) for x in events))
            with patch('registry.time.time', return_value=now):
                bind(root, assignment='impl', task='TASK', role='engineer', slot='eng-a', policy='new',
                     context_id='impl', session_id='impl', job_id='actual-new-job')
            p = build_project(root, EventReader(), auto=True, now=now+.01)
            self.assertTrue(next(a for a in p['actors'] if a['id']=='eng-a')['active'])
            self.assertFalse(next(a for a in p['actors'] if a['id']=='verifier')['active'])
            self.assertEqual(p['tasks'][0]['status'],'implementing')

    def test_nonzero_exit_cannot_be_completed_then_pass(self):
        with tempfile.TemporaryDirectory() as td:
            root, _ = self.setup_project(td)
            bind(root, assignment='v', task='TASK', role='verifier', slot='verifier', policy='fresh',
                 context_id='fresh', session_id='fresh', agent_id='new-agent', revision='tested-revision')
            with self.assertRaises(ValueError):
                update(root, 'v', state='completed', exit_code=1)

    def test_bool_exit_code_without_success_status_does_not_complete(self):
        with tempfile.TemporaryDirectory() as td:
            root, log = self.setup_project(td)
            bind(root, assignment='impl', task='TASK', role='engineer', slot='eng-a', policy='new',
                 context_id='impl', session_id='impl', job_id='new-job')
            log.write_text(json.dumps({'type':'job/settled', 'timestamp':time.time(),
                                      'data':{'jobId':'new-job', 'exitCode':False}}))
            data = read(root)
            apply(data, EventReader(), time.time())
            self.assertEqual(data['assignments']['impl']['state'], 'unknown')
            self.assertIsNone(data['assignments']['impl']['exit_code'])

    def bind_at(self, root, now, **kw):
        args = dict(assignment='impl', task='TASK', role='engineer', slot='eng-a', policy='new',
                    context_id='impl', session_id='impl', job_id='new-job', agent_id='impl-agent')
        args.update(kw)
        with patch('registry.time.time', return_value=now):
            bind(root, **args)

    def write_native(self, root, log, *events):
        header = {'type':'session', 'id':'owner', 'cwd':str(root), 'createdAt':1700000000000}
        log.write_text('\n'.join(json.dumps(e) for e in (header, *events)))

    def job_event(self, kind, at, **data):
        return {'type':kind, 'time':int(at*1000), 'data':dict(owner='owner', jobId='new-job', **data)}

    def test_prebinding_start_then_settled_before_bind_never_reactivates(self):
        for status in ('completed', 'cancelled', 'failed'):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as td:
                root, log = self.setup_project(td)
                now = time.time()
                self.bind_at(root, now)
                self.write_native(root, log, self.job_event('job/registered', now-.003),
                                  self.job_event('job/settled', now-.001, status=status))
                d = read(root)
                apply(d, EventReader(), now+.01)
                self.assertEqual(d['assignments']['impl']['state'], status)
                self.assertTrue(d['assignments']['impl']['historical_terminal'])
                p = build_project(root, EventReader(), auto=True, now=now+.01)
                self.assertFalse(any(a['active'] for a in p['actors']))
                self.assertIsNone(p['tasks'][0]['verdict'])

    def test_old_or_agent_only_prebinding_start_is_not_current_execution(self):
        with tempfile.TemporaryDirectory() as td:
            root, log = self.setup_project(td)
            now = time.time()
            self.bind_at(root, now)
            cases = [self.job_event('job/registered', now-120),
                     self.job_event('job/registered', now-6),
                     {'type':'agent/started', 'time':int((now-.003)*1000),
                      'data':{'owner':'owner','agentId':'impl-agent'}},
                     self.job_event('agent/started', now-.003, agentId='impl-agent')]
            for event in cases:
                with self.subTest(event=event['type'], at=event['time']):
                    self.write_native(root, log, event)
                    d = read(root)
                    apply(d, EventReader(), now+.01)
                    self.assertEqual(d['assignments']['impl']['state'], 'unknown')
                    self.assertFalse(next(a for a in build_project(root, auto=True, now=now+.01)['actors']
                                          if a['id']=='eng-a')['active'])

    def test_prebinding_start_cannot_override_manual_state_or_rebind_job(self):
        with tempfile.TemporaryDirectory() as td:
            root, log = self.setup_project(td)
            now = time.time()
            self.bind_at(root, now)
            self.write_native(root, log, self.job_event('job/registered', now-.003))
            self.assertTrue(build_project(root, auto=True, now=now+.01)['actors'][1]['active'])
            self.assertFalse(build_project(root, auto=True, now=now+901)['actors'][1]['active'])
            with patch('registry.time.time', return_value=now+.1):
                update(root, 'impl', state='unknown')
            self.assertFalse(build_project(root, auto=True, now=now+.2)['actors'][1]['active'])
            update(root, 'impl', state='completed', exit_code=0)
            self.assertFalse(build_project(root, auto=True, now=time.time()+1)['actors'][1]['active'])
            with self.assertRaises(ValueError):
                self.bind_at(root, now+1, assignment='round-2', policy='resume', predecessor='impl')

    def test_prebinding_start_works_for_new_job_of_same_agent_resume(self):
        with tempfile.TemporaryDirectory() as td:
            root, log = self.setup_project(td)
            now = time.time()
            self.bind_at(root, now-10, job_id='old-job')
            with patch('registry.time.time', return_value=now-5):
                update(root, 'impl', state='completed', exit_code=0)
            self.bind_at(root, now, assignment='round-2', policy='resume', predecessor='impl')
            self.write_native(root, log, self.job_event('job/registered', now-.003, agentId='impl-agent'))
            d = read(root)
            apply(d, EventReader(), now+.01)
            self.assertEqual(d['assignments']['impl']['state'], 'completed')
            self.assertEqual(d['assignments']['round-2']['state'], 'running')

    def test_non_integer_exit_codes_do_not_prove_success(self):
        with tempfile.TemporaryDirectory() as td:
            root, log = self.setup_project(td)
            now = time.time()
            self.bind_at(root, now)
            for code in (False, True, '0', '1', 0.0, 1.0, float('nan'), float('inf'), None):
                with self.subTest(code=repr(code)):
                    log.write_text(json.dumps({'type':'job/settled','timestamp':now+.01,
                                              'data':{'jobId':'new-job','exitCode':code}}))
                    d = read(root)
                    apply(d, EventReader(), now+1)
                    self.assertEqual(d['assignments']['impl']['state'], 'unknown')
                    self.assertIsNone(d['assignments']['impl']['exit_code'])

    def test_integer_exit_codes_and_explicit_status_still_work(self):
        with tempfile.TemporaryDirectory() as td:
            root, log = self.setup_project(td)
            now = time.time()
            self.bind_at(root, now)
            cases = [(dict(exitCode=0),'completed'), (dict(exitCode=7),'failed'),
                     (dict(exitCode=-9),'failed'), (dict(status='completed',exitCode=1),'failed'),
                     (dict(status='completed'),'completed'), (dict(status='cancelled'),'cancelled')]
            for fields, expected in cases:
                with self.subTest(fields=fields):
                    log.write_text(json.dumps({'type':'job/settled','timestamp':now+.01,
                                              'data':dict(jobId='new-job', **fields)}))
                    d = read(root)
                    apply(d, EventReader(), now+1)
                    self.assertEqual(d['assignments']['impl']['state'], expected)

    def test_manual_invalid_exit_updates_roll_back_and_do_not_enable_verdict(self):
        with tempfile.TemporaryDirectory() as td:
            root, _ = self.setup_project(td)
            self.bind_at(root, time.time(), role='verifier', slot='verifier', policy='fresh', revision='revision')
            before = read(root)
            for code in (False, True, '0', 0.0, float('nan'), float('inf'), 1, -9):
                with self.subTest(code=repr(code)), self.assertRaises(ValueError):
                    update(root, 'impl', state='completed', exit_code=code)
                self.assertEqual(read(root), before)
            with self.assertRaises(ValueError):
                update(root, 'impl', verdict='PASS', revision='revision')
            update(root, 'impl', state='completed', exit_code=0)
            completed = read(root)
            with self.assertRaises(ValueError):
                update(root, 'impl', exit_code=1)
            self.assertEqual(read(root), completed)


if __name__=='__main__':
    unittest.main()
