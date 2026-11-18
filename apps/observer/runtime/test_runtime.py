import concurrent.futures
from datetime import datetime, timedelta
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

from events import EventReader, apply
from observer_state import build, build_project
from registry import FILE, activate, bind, pulse, read, update

HERE = Path(__file__).resolve().parent


def worker(root, n):
    # Repeated concurrent merges of the SAME file, separate processes/locks.
    pulse(root, {'pm': 'working'})
    from registry import transaction
    with transaction(root) as d:
        d.setdefault('concurrency', []).append(n)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'project'
        self.root.mkdir()
        self.file = self.root / 'session.jsonl'
        self.now = time.time()
        activate(self.root, 'owner', 'pm-context', str(self.file), ttl=900)

    def tearDown(self):
        self.temp.cleanup()

    def bind(self, assignment='eng-1', task='TASK-1', slot='eng-a', role='engineer', **kw):
        args = dict(assignment=assignment, task=task, role=role, slot=slot, policy='new',
                    context_id=assignment + '-ctx', session_id=assignment + '-session', job_id=assignment + '-job')
        args.update(kw)
        bind(self.root, **args)
        return assignment

    def events(self, *events):
        self.file.write_text('\n'.join(json.dumps(e) for e in events) + '\n')

    def e(self, kind, **data):
        return dict(type=kind, timestamp=time.time(), data=data)

    def snapshot(self, auto=False, now=None, reader=None):
        return build_project(self.root, auto=auto, now=now, reader=reader)

    def actor(self, p, slot):
        return next(a for a in p['actors'] if a['id'] == slot)

    def test_unregistered_bash_background_build_never_grant_role(self):
        self.events(self.e('tool/call', name='bash', arguments={'command': 'build verifier engineer test'}),
                    self.e('job/started', id='build-123', description='验收实现'))
        p = self.snapshot(True)
        self.assertFalse(any(a['active'] for a in p['actors']))
        self.assertEqual(p['status'], 'dispatching')
        self.assertIn('unregistered', p['activity'])
        self.assertEqual(len(p['actors']), 4)

    def test_same_tool_explicit_roles_testing_and_finish(self):
        self.bind()
        update(self.root, 'eng-1', state='running', phase='testing')
        p = self.snapshot()
        self.assertEqual(self.actor(p, 'eng-a')['motion'], 'testing')
        self.assertEqual(p['tasks'][0]['status'], 'implementing')
        update(self.root, 'eng-1', state='completed')
        p = self.snapshot()
        self.assertFalse(self.actor(p, 'verifier')['active'])
        self.assertEqual(p['tasks'][0]['verification'], 'queued')
        self.bind('v1', slot='verifier', role='verifier', policy='fresh', revision='abc123')
        self.events(self.e('tool/call', name='bash', arguments={'command': 'same build'}),
                    self.e('job/started', jobId='v1-job'))
        self.assertTrue(self.actor(self.snapshot(True), 'verifier')['active'])
        self.assertFalse(self.actor(self.snapshot(True), 'eng-a')['active'])

    def test_resume_and_handoff_lineage(self):
        self.bind()
        update(self.root, 'eng-1', state='completed')
        with self.assertRaises(ValueError):
            self.bind('eng-2')
        with self.assertRaises(ValueError):
            self.bind('eng-2', policy='resume', predecessor='eng-1')
        self.bind('eng-2', policy='resume', predecessor='eng-1', context_id='eng-1-ctx', session_id='eng-1-session')
        update(self.root, 'eng-2', state='completed')
        self.bind('eng-3', policy='handoff', predecessor='eng-2')
        self.assertEqual(read(self.root)['assignments']['eng-3']['lineage'], 'eng-1')
        with self.assertRaises(ValueError):
            self.bind('branch', policy='handoff', predecessor='eng-1')
        update(self.root, 'eng-3', state='running')
        self.assertTrue(self.actor(self.snapshot(now=time.time()+5), 'eng-a')['active'])

    def test_verify_rejects_inheritance_reuse_and_missing_revision(self):
        self.bind()
        for kw in [dict(policy='fork', revision='r'), dict(policy='resume', revision='r'),
                   dict(policy='fresh'), dict(policy='fresh', revision='r', context_id='eng-1-ctx'),
                   dict(policy='fresh', revision='r', session_id='eng-1-session'),
                   dict(policy='fresh', revision='r', context_id='owner')]:
            with self.assertRaises(ValueError):
                self.bind('v', role='verifier', slot='verifier', **kw)
        self.bind('v', role='verifier', slot='verifier', policy='fresh', revision='r')
        update(self.root, 'v', state='completed')
        self.assertIsNone(self.snapshot()['tasks'][0]['verdict'])
        with self.assertRaises(ValueError):
            update(self.root, 'v', verdict='PASS', revision='wrong')
        update(self.root, 'v', verdict='PASS', revision='r')
        p = self.snapshot()
        self.assertEqual(p['tasks'][0]['verdict'], 'PASS')
        self.assertIn('revision: r', p['tasks'][0]['evidence'])
        self.assertFalse(self.actor(p, 'verifier')['active'])

    def test_two_engineers_stable_slots(self):
        self.bind()
        self.bind('eng-2', task='TASK-2', slot='eng-b')
        for a in ('eng-1', 'eng-2'):
            update(self.root, a, state='running')
        p = self.snapshot()
        self.assertEqual(self.actor(p, 'eng-a')['taskId'], 'TASK-1')
        self.assertEqual(self.actor(p, 'eng-b')['taskId'], 'TASK-2')
        self.assertEqual(p['engineerCount'], 2)
        with self.assertRaises(ValueError):
            self.bind('eng-3', task='TASK-3')

    def test_start_settled_cancel_unknown_identity_and_staleness(self):
        self.bind()
        self.events(self.e('job/started', jobId='eng-1-job'))
        self.assertTrue(self.actor(self.snapshot(True), 'eng-a')['active'])
        self.events(self.e('job/settled', jobId='eng-1-job', status='cancelled'))
        p = self.snapshot(True)
        self.assertFalse(self.actor(p, 'eng-a')['active'])
        self.assertEqual(p['status'], 'idle')
        self.events(self.e('job/settled', jobId='eng-1-job'))
        self.assertIn('unknown', self.snapshot(True)['activity'])
        self.events(self.e('job/started', jobId='eng-1-job', agentId='wrong'))
        self.assertFalse(self.actor(self.snapshot(True), 'eng-a')['active'])
        update(self.root, 'eng-1', state='running')
        p = self.snapshot(now=time.time()+901)
        self.assertFalse(self.actor(p, 'eng-a')['active'])
        self.assertIn('unknown', p['activity'])

    def test_blocked_not_rework(self):
        self.bind()
        update(self.root, 'eng-1', state='blocked')
        p = self.snapshot()
        self.assertNotEqual(p['tasks'][0]['status'], 'rework')
        self.assertIn('blocked', p['tasks'][0]['activity'])
        self.assertFalse(p['pendingQuestion'])

    def test_question_answer_and_no_fabrication(self):
        asked = self.e('question/asked', sessionId='owner', questionId='q1', question='Choose A or B?')
        self.events(asked)
        p = self.snapshot(True)
        self.assertTrue(p['awaitingUser'])
        self.assertEqual(p['pendingQuestion']['question'], 'Choose A or B?')
        self.events(asked, self.e('question/answered', sessionId='owner', questionId='q1'))
        self.assertIsNone(self.snapshot(True)['pendingQuestion'])
        self.events(asked, self.e('user/message', sessionId='owner', text='A'))
        self.assertFalse(self.snapshot(True)['needsAttention'])
        pulse(self.root, dict(pm='waiting', role='verifier', activity='invent a question', ttl=2))
        self.assertIsNone(self.snapshot()['pendingQuestion'])
        self.assertFalse(self.actor(self.snapshot(), 'verifier')['active'])
        p = self.snapshot(now=time.time()+3)
        self.assertFalse(self.actor(p, 'pm')['active'])
        self.assertIn('expired PM pulse', p['activity'])

    def test_recorder_running_finished(self):
        self.bind('scribe', role='recording', slot='recording')
        update(self.root, 'scribe', state='running')
        self.assertTrue(self.snapshot()['recording'])
        update(self.root, 'scribe', state='completed')
        self.assertFalse(self.snapshot()['recording'])

    def test_skill_event_time_dedup_cache_minimal_data(self):
        today = self.e('tool/call', name='skill', arguments=json.dumps({'name': 'real-skill'}))
        yesterday = dict(type='tool/call', timestamp=(datetime.now()-timedelta(days=1)).isoformat(),
                         data={'name': 'skill', 'arguments': {'name': 'yesterday-only'}})
        self.events(today, today, yesterday, self.e('tool/list', name='skill', text='SECRET'),
                    self.e('tool/call', name='bash', arguments={'command': 'SECRET'}))
        reader = EventReader()
        for _ in range(3):
            self.assertEqual(self.snapshot(True, reader=reader)['skillsUsed'], 1)
        self.assertEqual(reader.loads, 1)
        self.assertNotIn('SECRET', repr(reader.cache))
        self.events(today, self.e('tool/call', name='skill', arguments={'name': 'another'}))
        self.assertEqual(self.snapshot(True, reader=reader)['skillsUsed'], 2)
        self.assertEqual(reader.loads, 2)

    def test_cross_project_no_discovery_or_writes(self):
        other = self.root.parent / 'ExcludedProject'
        other.mkdir()
        (other / 'session.jsonl').write_text('PRIVATE')
        before = (other / 'session.jsonl').stat()
        with self.assertRaises(ValueError):
            activate(self.root, 'owner', 'pm-context', str(other/'session.jsonl'))
        self.assertEqual(build([other])['projects'], [])
        self.snapshot(True)
        self.assertEqual((other/'session.jsonl').stat().st_mtime_ns, before.st_mtime_ns)
        self.assertEqual(list(other.iterdir()), [other/'session.jsonl'])
        self.assertFalse((self.root/'.delegate/observer/observer-auto.json').exists())

    def test_atomic_concurrent_merges(self):
        code = 'import sys; from test_runtime import worker; worker(sys.argv[1], int(sys.argv[2]))'
        def launch(n):
            subprocess.run([sys.executable, '-c', code, str(self.root), str(n)], cwd=HERE, check=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(launch, range(30)))
        self.assertEqual(sorted(read(self.root)['concurrency']), list(range(30)))
        self.assertFalse(list((self.root/FILE).parent.glob('.runtime.json*')))

    def test_run_exit_code_and_terminal_not_pass(self):
        cmd = [sys.executable, str(HERE/'runtime.py'), '--root', str(self.root), 'run',
               '--assignment', 'local', '--task', 'T-1', '--role', 'engineer', '--slot', 'eng-a',
               '--policy', 'new', '--context-id', 'local-ctx', '--session-id', 'local-session',
               '--', sys.executable, '-c', 'import json,sys; from pathlib import Path; d=json.loads(Path(sys.argv[1]).read_text()); assert d["assignments"]["local"]["state"] == "running"; sys.exit(7)', str(self.root/FILE)]
        result = subprocess.run(cmd, capture_output=True)
        self.assertEqual(result.returncode, 7, result.stderr)
        record = read(self.root)['assignments']['local']
        self.assertEqual((record['state'], record['exit_code'], record['verdict']), ('failed', 7, None))
        self.assertTrue(record['job_id'].startswith('local-'))

    @unittest.skipUnless(shutil.which('zstd'), 'optional zstd CLI unavailable')
    def test_native_zstd_cache(self):
        raw = json.dumps(self.e('tool/call', name='skill', arguments={'name': 'compressed'})).encode()
        compressed = subprocess.run(['zstd', '-q', '-c'], input=raw, capture_output=True, check=True).stdout
        file = self.root / 'session.v4.jsonl.zstd'
        file.write_bytes(compressed)
        activate(self.root, 'owner', 'pm-context', str(file))
        reader = EventReader()
        self.assertEqual(self.snapshot(True, reader=reader)['skillsUsed'], 1)
        self.snapshot(True, reader=reader)
        self.assertEqual(reader.loads, 1)

    def test_fail_verdict_rework_only_explicit_and_new_round_fresh(self):
        self.bind('v1', role='verifier', slot='verifier', policy='fresh', revision='rev1')
        update(self.root, 'v1', state='completed')
        self.assertNotEqual(self.snapshot()['tasks'][0]['status'], 'rework')
        update(self.root, 'v1', verdict='FAIL', revision='rev1')
        self.assertEqual(self.snapshot()['tasks'][0]['status'], 'rework')
        with self.assertRaises(ValueError):
            self.bind('v2', role='verifier', slot='verifier', policy='fresh', revision='rev2',
                      context_id='v1-ctx', session_id='v1-session')
        self.bind('v2', role='verifier', slot='verifier', policy='fresh', revision='rev2')
        self.assertIsNone(self.snapshot()['tasks'][0]['verdict'])

    def test_snapshot_does_not_write_or_refresh_ttl(self):
        self.bind()
        update(self.root, 'eng-1', state='completed')
        registry = self.root / FILE
        before = registry.read_bytes(), registry.stat().st_mtime_ns
        for t in (time.time(), time.time()+100, time.time()+1000):
            self.snapshot(True, now=t)
        self.assertEqual((registry.read_bytes(), registry.stat().st_mtime_ns), before)
        self.assertIn('unknown', self.snapshot(now=time.time()+1000)['activity'])
        self.assertNotEqual(self.snapshot(now=time.time()+1000)['status'], 'idle')

    def test_pm_turn_does_not_light_engineer_and_foreign_owner_ignored(self):
        self.bind('pm-job', role='pm', slot='pm', session_id='owner', context_id='pm-context')
        self.events(self.e('turn/started', sessionId='owner'))
        p = self.snapshot(True)
        self.assertTrue(self.actor(p, 'pm')['active'])
        self.assertFalse(self.actor(p, 'eng-a')['active'])
        self.events(self.e('job/started', sessionId='another-owner', jobId='pm-job-job'))
        self.assertFalse(self.actor(self.snapshot(True), 'pm')['active'])

    def test_bad_file_diagnostic_cache_and_cli_compatibility(self):
        self.file.write_text('not json\n')
        self.assertIn('malformed owner event', self.snapshot(True)['activity'])
        cmd = [sys.executable, str(HERE/'observer_state.py'), '--root', str(self.root), '--stdout', '--auto']
        result = subprocess.run(cmd, text=True, capture_output=True, check=True)
        self.assertEqual(len(json.loads(result.stdout)['projects']), 1)
        self.file.unlink()
        self.assertIn('unavailable', self.snapshot(True)['activity'])

    def native(self, event_type, at=None, **data):
        return dict(type=event_type, seq=1, time=int((time.time()+.01 if at is None else at)*1000), data=data)

    def native_events(self, *events, owner='owner', project=None):
        header = dict(type='session', id=owner, cwd=str(project or self.root),
                      createdAt=int((time.time()-86400)*1000), parentSession=None,
                      isSeeded=False, delegationDepth=0)
        self.events(header, *events)

    def native_snapshot(self, **kw):
        return self.snapshot(True, now=time.time()+1, **kw)

    def test_native_implicit_pm_repeated_turns_and_end_not_done(self):
        before = read(self.root)
        self.assertEqual(before['pm']['state'], 'unknown')
        self.assertEqual(before['assignments'], {})
        self.native_events(self.native('turn/start', turn=1))
        p = self.native_snapshot()
        self.assertTrue(self.actor(p, 'pm')['active'])
        self.assertFalse(self.actor(p, 'eng-a')['active'])
        self.native_events(self.native('turn/start', turn=1), self.native('turn/end', turn=1, reason='completed'))
        p = self.native_snapshot()
        self.assertFalse(self.actor(p, 'pm')['active'])
        self.assertEqual(p['status'], 'idle')
        self.assertNotEqual(p['status'], 'done')
        self.assertIn('not project done', self.actor(p, 'pm')['activity'])
        self.native_events(self.native('turn/start', turn=1), self.native('turn/end', turn=1),
                           self.native('turn/start', turn=2), self.native('turn/end', turn=1))
        self.assertTrue(self.actor(self.native_snapshot(), 'pm')['active'])
        activate(self.root, 'owner', 'pm-context', str(self.file))
        self.assertEqual(read(self.root)['assignments'], {})
        self.assertEqual(read(self.root)['activated_at'], before['activated_at'])

    def test_native_header_and_event_owner_enforced(self):
        self.bind()
        start = self.native('job/registered', owner='owner', jobId='eng-1-job',
                            kind='bash', label='do not infer verifier')
        skill = self.native('tool/call', name='skill', arguments={'name': 'must-not-count'})
        for owner, project in [('wrong', self.root), ('owner', self.root.parent)]:
            self.native_events(start, skill, owner=owner, project=project)
            p = self.native_snapshot()
            self.assertFalse(self.actor(p, 'eng-a')['active'])
            self.assertEqual(p['skillsUsed'], 0)
            self.assertIn('header', p['activity'])
        self.events(start, skill)
        self.assertIn('header', self.native_snapshot()['activity'])
        for owner in ('wrong', None):
            self.native_events(self.native('job/registered', owner=owner, jobId='eng-1-job'))
            self.assertFalse(self.actor(self.native_snapshot(), 'eng-a')['active'])
        self.native_events(start)
        self.assertTrue(self.actor(self.native_snapshot(), 'eng-a')['active'])

    def test_native_unregistered_history_bounded_not_poison_current(self):
        self.bind()
        history = []
        for n in range(120):
            history.extend([self.native('job/registered', at=time.time()-2000, owner='owner', jobId=f'old-{n}'),
                            self.native('job/settled', at=time.time()-1900, owner='owner', jobId=f'old-{n}', status='completed')])
        start = self.native('job/registered', owner='owner', jobId='eng-1-job')
        self.native_events(*history, start)
        p = self.native_snapshot()
        self.assertTrue(self.actor(p, 'eng-a')['active'])
        self.assertEqual(p['status'], 'implementing')
        self.assertLess(len(p['activity']), 300)
        self.native_events(*history, start, self.native('job/settled', owner='owner', jobId='eng-1-job', status='completed'))
        p = self.native_snapshot()
        self.assertFalse(self.actor(p, 'eng-a')['active'])
        self.assertEqual(p['status'], 'idle', 'delivered work is not a running verification')
        self.assertEqual(p['tasks'][0]['status'], 'queued')
        self.assertEqual(p['tasks'][0]['verification'], 'queued')
        self.assertFalse(self.actor(p, 'verifier')['active'])
        self.assertNotIn('unknown', self.actor(p, 'eng-a')['activity'])

    def test_native_questions_precise_call_id_and_human_only(self):
        ask = self.native('tool/call', callId='ask-1', name='ask_user_question',
                          arguments=json.dumps({'questions': [{'id': 'q1', 'question': 'First choice?'},
                                                              {'id': 'q2', 'question': 'Second choice?'}]}))
        other = self.native('tool/result', message={'toolCallId': 'unrelated', 'content': [{'type': 'text', 'text': 'SECRET'}]})
        system = self.native('user/message', role='user', source={'kind': 'system'}, content='not an answer')
        self.native_events(ask, other, system)
        p = self.native_snapshot()
        self.assertTrue(p['awaitingUser'])
        self.assertIn('First choice?', p['pendingQuestion']['question'])
        self.assertIn('Second choice?', p['pendingQuestion']['question'])
        d = read(self.root)
        reader = EventReader()
        apply(d, reader, time.time()+1)
        self.assertEqual(d['pending_question_count'], 2)
        self.assertNotIn('SECRET', repr(reader.cache))
        answer = self.native('tool/result', message={'toolCallId': 'ask-1', 'content': [{'text': 'SECRET'}]})
        self.native_events(ask, other, system, answer)
        self.assertFalse(self.native_snapshot()['awaitingUser'])
        self.native_events(ask, self.native('user/message', role='user', source={'kind': 'user'}, content='real answer'))
        self.assertIsNone(self.native_snapshot()['pendingQuestion'])
        second = self.native('tool/call', callId='ask-2', name='ask_user_question',
                             arguments={'questions': [{'id': 'q3', 'question': 'Another choice?'}]})
        self.native_events(ask, second, answer)
        self.assertEqual(self.native_snapshot()['pendingQuestion']['id'], 'ask-2')

    def test_native_skill_ms_day_and_no_catalog_count(self):
        today = self.native('tool/call', name='skill', arguments={'name': 'loaded'})
        yesterday_at = (datetime.now().replace(hour=12, minute=0, second=0)-timedelta(days=1)).timestamp()
        yesterday = self.native('tool/call', at=yesterday_at, name='skill', arguments={'name': 'yesterday'})
        self.native_events(today, today, yesterday,
                           self.native('request/header', tools=[{'name': 'skill', 'arguments': {'name': 'catalog'}}]),
                           self.native('tool/call', name='bash', arguments={'command': 'skill verifier build'}))
        reader = EventReader()
        p = self.native_snapshot(reader=reader)
        self.assertEqual(p['skillsUsed'], 1)
        self.assertFalse(any(a['active'] for a in p['actors']))
        self.native_snapshot(reader=reader)
        self.assertEqual(reader.loads, 1)

    def test_native_prebind_terminal_retained_but_no_retroactive_live_start(self):
        self.bind()
        registered = self.native('job/registered', at=time.time()-120, owner='owner', jobId='eng-1-job')
        settled = self.native('job/settled', at=time.time()-100, owner='owner', jobId='eng-1-job', status='completed')
        self.native_events(registered)
        self.assertFalse(self.actor(self.native_snapshot(), 'eng-a')['active'])
        self.assertIn('unknown', self.actor(self.native_snapshot(), 'eng-a')['activity'])
        self.native_events(registered, settled)
        p = self.native_snapshot()
        self.assertFalse(self.actor(p, 'eng-a')['active'])
        self.assertFalse(self.actor(p, 'verifier')['active'])
        self.assertEqual(p['tasks'][0]['verification'], 'queued')
        self.assertIn('pre-binding', p['tasks'][0]['activity'])
        self.assertIn('execution: completed (pre-binding)', p['tasks'][0]['evidence'])
        later = self.snapshot(True, now=time.time()+10000)
        self.assertEqual(later['tasks'][0]['verification'], 'queued')
        self.assertFalse(self.actor(later, 'eng-a')['active'])
        self.assertNotEqual(later['status'], 'idle')
        self.assertIsNone(later['tasks'][0]['verdict'])
        self.assertEqual(read(self.root)['assignments']['eng-1']['state'], 'unknown')

    def test_native_terminal_verifier_no_pass_and_expired_unsettled_unknown(self):
        self.bind('v', role='verifier', slot='verifier', policy='fresh', revision='target')
        self.native_events(self.native('job/registered', owner='owner', jobId='v-job'),
                           self.native('job/settled', owner='owner', jobId='v-job', status='completed'))
        p = self.native_snapshot()
        self.assertIsNone(p['tasks'][0]['verdict'])
        self.assertFalse(self.actor(p, 'verifier')['active'])
        update(self.root, 'v', state='completed')
        update(self.root, 'v', verdict='PASS', revision='target')
        later = self.snapshot(True, now=time.time()+10000)
        self.assertEqual(later['tasks'][0]['verdict'], 'PASS')
        self.assertEqual(later['tasks'][0]['verification'], 'passed')
        self.assertFalse(self.actor(later, 'verifier')['active'])
        self.bind()
        self.native_events(self.native('job/registered', owner='owner', jobId='eng-1-job'))
        later = self.snapshot(True, now=time.time()+10000)
        self.assertIn('unknown', self.actor(later, 'eng-a')['activity'])
        self.assertFalse(self.actor(later, 'eng-a')['active'])

    def test_native_pm_idle_does_not_certify_unregistered_live_bash_idle(self):
        self.native_events(self.native('turn/start', turn=1), self.native('turn/end', turn=1),
                           self.native('job/registered', owner='owner', jobId='ordinary-bash',
                                       kind='bash', label='verifier engineer build test'))
        p = self.native_snapshot()
        self.assertEqual(p['status'], 'dispatching')
        self.assertIn('unknown', p['activity'])
        self.assertFalse(any(a['active'] for a in p['actors']))
        self.assertIn('PM idle', self.actor(p, 'pm')['activity'])

    def test_schema_node_existing_validator(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('Node not installed')
        self.bind()
        update(self.root, 'eng-1', state='running', phase='testing')
        payload = build([self.root])
        validator = HERE.parent / 'desktop/observer-state.cjs'
        js = "const fs=require('fs');const assert=require('assert');const raw=JSON.parse(fs.readFileSync(0,'utf8'));const r=require(process.argv[1]).normalizeObserverState(raw);assert(r.ok,r.error);assert.equal(r.payload.projects.length,1);const p=r.payload.projects[0];assert.equal(p.actors.length,4);assert.equal(p.tasks.length,raw.projects[0].tasks.length);assert.equal(p.tasks[0].status,'implementing');assert.equal(p.actors[1].motion,'testing');console.log('existing Node schema: OK');"
        run = subprocess.run([node, '-e', js, str(validator)], input=json.dumps(payload), text=True, capture_output=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn('OK', run.stdout)


if __name__ == '__main__':
    unittest.main()
