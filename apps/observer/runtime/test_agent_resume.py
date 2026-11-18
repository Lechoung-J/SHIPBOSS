"""Resumable agent identity is not a per-launch execution identity."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from events import EventReader, apply
from observer_state import build_project
from registry import activate, bind, read, update

BASE = 1700000000.0


class AgentResumeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.log = self.root / 'session.jsonl'
        with patch('registry.time.time', return_value=BASE-1):
            activate(self.root, 'owner', 'pm-context', str(self.log))

    def tearDown(self):
        self.temp.cleanup()

    def launch(self, name, at, predecessor=None, **kw):
        args = dict(assignment=name, task='TASK-1', role='engineer', slot='eng-a',
                    policy='resume' if predecessor else 'new', context_id='engineer-context',
                    session_id='engineer-session', agent_id='durable-agent', predecessor=predecessor)
        args.update(kw)
        with patch('registry.time.time', return_value=at):
            bind(self.root, **args)

    def finish(self, name, at):
        with patch('registry.time.time', return_value=at):
            update(self.root, name, state='completed')

    def two_rounds(self, jobs=False):
        self.launch('round-1', BASE, **({'job_id': 'job-1'} if jobs else {}))
        self.finish('round-1', BASE+10)
        self.launch('round-2', BASE+20, 'round-1', **({'job_id': 'job-2'} if jobs else {}))

    def event(self, kind, at, **data):
        return dict(type=kind, time=int(at*1000), data=dict(owner='owner', **data))

    def observe(self, *events, now=BASE+100):
        header = dict(type='session', id='owner', cwd=str(self.root), createdAt=int((BASE-100)*1000))
        self.log.write_text('\n'.join(json.dumps(e) for e in (header, *events)))
        d = read(self.root)
        notes, _ = apply(d, EventReader(), now)
        return d, notes

    def test_same_agent_three_engineer_rounds_preserve_lineage(self):
        self.two_rounds()
        self.finish('round-2', BASE+30)
        self.launch('round-3', BASE+40, 'round-2')
        records = read(self.root)['assignments']
        self.assertEqual([r['agent_id'] for r in records.values()], ['durable-agent']*3)
        self.assertEqual({r['lineage'] for r in records.values()}, {'round-1'})
        self.assertEqual(records['round-3']['predecessor'], 'round-2')
        self.assertEqual(records['round-3']['slot'], 'eng-a')
        self.assertEqual(records['round-3']['state'], 'unknown')

    def test_reused_job_still_rejected_but_new_job_same_agent_allowed(self):
        self.launch('round-1', BASE, job_id='job-1')
        self.finish('round-1', BASE+10)
        with self.assertRaises(ValueError):
            self.launch('reused-job', BASE+20, 'round-1', job_id='job-1')
        self.launch('round-2', BASE+20, 'round-1', job_id='job-2')
        self.finish('round-2', BASE+30)
        self.launch('round-3', BASE+40, 'round-2', job_id='job-3')
        self.assertEqual(read(self.root)['assignments']['round-3']['agent_id'], 'durable-agent')

    def test_wrong_context_fork_handoff_and_active_predecessor_rejected(self):
        self.launch('round-1', BASE)
        with self.assertRaises(ValueError):
            self.launch('before-finish', BASE+5, 'round-1')
        self.finish('round-1', BASE+10)
        for name, kw in [('wrong-session', dict(session_id='different-session')),
                         ('wrong-context', dict(context_id='different-context')),
                         ('forked', dict(policy='fork')),
                         ('handoff', dict(policy='handoff', context_id='new-context', session_id='new-session'))]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.launch(name, BASE+20, 'round-1', **kw)
        with self.assertRaises(ValueError):
            self.launch('other-task', BASE+20, task='TASK-2', slot='eng-b', policy='new')
        self.launch('round-2', BASE+20, 'round-1')
        self.finish('round-2', BASE+30)
        with self.assertRaises(ValueError):
            self.launch('branch', BASE+40, 'round-1')

    def test_verifier_cannot_reuse_engineer_or_prior_verifier_agent(self):
        self.launch('round-1', BASE)
        self.finish('round-1', BASE+10)
        for policy in ('resume', 'fresh'):
            with self.subTest(policy=policy), self.assertRaises(ValueError):
                self.launch('verifier-invalid', BASE+20, role='verifier', slot='verifier', policy=policy,
                            context_id='verify-context', session_id='verify-session', revision='revision-1')
        self.launch('verify-1', BASE+20, role='verifier', slot='verifier', policy='fresh',
                    context_id='verify-context', session_id='verify-session', agent_id='verify-agent', revision='revision-1')
        self.finish('verify-1', BASE+30)
        with self.assertRaises(ValueError):
            self.launch('verify-2', BASE+40, role='verifier', slot='verifier', policy='fresh',
                        context_id='verify-context-2', session_id='verify-session-2', agent_id='verify-agent', revision='revision-2')
        with self.assertRaises(ValueError):
            self.launch('engineer-using-verifier', BASE+40, 'round-1', agent_id='verify-agent')

    def test_agent_only_old_settlement_does_not_end_current_round(self):
        self.two_rounds()
        old = self.event('agent/settled', BASE+9, agentId='durable-agent', status='completed')
        d, _ = self.observe(old)
        self.assertEqual(d['assignments']['round-2']['state'], 'unknown')
        with patch('registry.time.time', return_value=BASE+21):
            update(self.root, 'round-2', state='running')
        d, _ = self.observe(old)
        self.assertEqual(d['assignments']['round-2']['state'], 'running')
        self.assertNotIn('historical_terminal', d['assignments']['round-2'])

    def test_agent_only_new_start_and_settle_apply_to_second_and_third_rounds(self):
        self.two_rounds()
        old = self.event('agent/settled', BASE+9, agentId='durable-agent', status='completed')
        start2 = self.event('agent/started', BASE+21, agentId='durable-agent')
        end2 = self.event('agent/settled', BASE+25, agentId='durable-agent', status='completed')
        d, _ = self.observe(old, start2)
        self.assertEqual(d['assignments']['round-2']['state'], 'running')
        p = build_project(self.root, auto=True, now=BASE+22)
        self.assertTrue(next(a for a in p['actors'] if a['id'] == 'eng-a')['active'])
        d, _ = self.observe(old, start2, end2)
        self.assertEqual(d['assignments']['round-2']['state'], 'completed')
        self.finish('round-2', BASE+30)
        self.launch('round-3', BASE+40, 'round-2')
        d, _ = self.observe(old, start2, end2)
        self.assertEqual(d['assignments']['round-3']['state'], 'unknown')
        start3 = self.event('agent/started', BASE+41, agentId='durable-agent')
        end3 = self.event('agent/settled', BASE+45, agentId='durable-agent', status='completed')
        d, _ = self.observe(old, start2, end2, start3)
        self.assertEqual(d['assignments']['round-3']['state'], 'running')
        d, _ = self.observe(old, start2, end2, start3, end3)
        self.assertEqual(d['assignments']['round-3']['state'], 'completed')
        self.assertEqual(d['assignments']['round-3']['updated_at'], BASE+45)

    def test_job_id_priority_no_agent_fallback_or_previous_job_closing_resume(self):
        self.two_rounds(jobs=True)
        start = self.event('job/registered', BASE+21, jobId='job-2', agentId='durable-agent')
        old_end = self.event('job/settled', BASE+22, jobId='job-1', agentId='durable-agent', status='completed')
        unregistered = self.event('job/settled', BASE+23, jobId='not-registered', agentId='durable-agent', status='completed')
        d, _ = self.observe(start, old_end, unregistered)
        self.assertEqual(d['assignments']['round-2']['state'], 'running')
        end = self.event('job/settled', BASE+24, jobId='job-2', agentId='durable-agent', status='completed')
        d, _ = self.observe(start, old_end, unregistered, end)
        self.assertEqual(d['assignments']['round-2']['state'], 'completed')

    def test_prebinding_agent_only_event_cannot_import_historical_terminal(self):
        self.launch('round-1', BASE)
        d, notes = self.observe(self.event('agent/settled', BASE-5, agentId='durable-agent', status='completed'))
        self.assertEqual(d['assignments']['round-1']['state'], 'unknown')
        self.assertNotIn('historical_terminal', d['assignments']['round-1'])
        self.assertTrue(any('binding' in note for note in notes))

    def test_ambiguous_agent_chain_is_unknown_not_first_record_wins(self):
        self.two_rounds()
        start = self.event('agent/started', BASE+21, agentId='durable-agent')
        self.observe(start)
        d = read(self.root)
        alias = copy.deepcopy(d['assignments']['round-2'])
        alias.update(assignment='unrelated-alias', lineage='other-lineage', slot='eng-b',
                     task='TASK-2', context_id='other-context', state='running', updated_at=BASE+21)
        d['assignments']['unrelated-alias'] = alias
        self.observe(start, self.event('agent/settled', BASE+25, agentId='durable-agent', status='completed'))
        notes, _ = apply(d, EventReader(), BASE+30)
        self.assertEqual(d['assignments']['round-1']['state'], 'completed')
        self.assertEqual(d['assignments']['round-2']['state'], 'unknown')
        self.assertEqual(d['assignments']['unrelated-alias']['state'], 'unknown')
        self.assertTrue(any('ambiguous' in note for note in notes))

    def test_agent_binding_time_tie_is_unknown_not_guessed(self):
        self.two_rounds()
        self.observe(self.event('agent/settled', BASE+25, agentId='durable-agent', status='completed'))
        d = read(self.root)
        d['assignments']['round-2'].update(bound_at=BASE, updated_at=BASE+21, state='running')
        notes, _ = apply(d, EventReader(), BASE+30)
        self.assertEqual(d['assignments']['round-1']['state'], 'completed')
        self.assertEqual(d['assignments']['round-2']['state'], 'unknown')
        self.assertTrue(any('binding time' in note for note in notes))


if __name__ == '__main__':
    unittest.main()
