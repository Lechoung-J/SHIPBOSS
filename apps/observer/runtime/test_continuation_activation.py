"""Native main continuation inherits membership, never events or skill usage."""
import json
import tempfile
import unittest
from pathlib import Path

from discovery import DiscoveryIndex

NOW = 1794844100
CWD = '/synthetic/continuity-project'


class ContinuationActivationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)/'home'
        self.index = DiscoveryIndex(self.home, Path(self.tmp.name)/'index.json', max_files=100)

    def save(self, sid, *, parent=None, seeded=False, depth=0, cwd=CWD,
             activation=False, ended=False, prefix=(), suffix=(), marker=True):
        events = list(prefix)
        if seeded and marker:
            events.append(('session/end-seed', NOW-20, {'inherited': True}))
        if activation:
            events.append(('user/message', NOW-100, {'source': {'kind': 'skill-invocation', 'form': 'instructions', 'name': 'shipboss'}}))
        events += [('turn/start', NOW-10, {'turn': 18}), ('step/start', NOW-1, {'turn': 18, 'step': 50})]
        events += list(suffix)
        if ended:
            events.append(('turn/end', NOW-.1, {'turn': 18}))
        rows = [dict(type='session', id=sid, cwd=cwd, parentSession=parent, isSeeded=seeded, delegationDepth=depth)]
        rows += [dict(type=kind, time=at*1000, seq=i, data=data) for i, (kind, at, data) in enumerate(events)]
        path = self.home/'sessions/encoded'/sid/'session.jsonl'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('\n'.join(json.dumps(row) for row in rows)+'\n')
        return path

    def project(self, **kwargs):
        return self.index.build(now=NOW, **kwargs)['projects'][0]

    def test_old_success_ended_new_seeded_fresh_open_without_skill(self):
        self.save('old', activation=True, ended=True)
        self.save('new', parent='old', seeded=True)
        p = self.project()
        self.assertTrue(p['actors'][0]['active'])
        self.assertEqual(p['actors'][0]['motion'], 'working')
        self.assertEqual(p['actors'][0]['toolActivity']['sessionId'], 'new')
        self.assertTrue(p['actors'][0]['toolActivity']['thinking'])
        self.assertEqual(p['skillsUsed'], 0)
        self.assertIn('new', p['sessionIds'])
        sessions, _, _ = self.index.scan()
        self.assertEqual(next(s for s in sessions if s['header']['id']=='new')['usages'], [])

    def test_multigeneration_bounded_provenance_and_cache_restart(self):
        self.save('old', activation=True, ended=True)
        self.save('mid', parent='old', seeded=True, ended=True)
        self.save('new', parent='mid', seeded=True)
        p = self.project()
        self.assertEqual(p['activationProvenance']['new']['rootActivationSession'], 'old')
        self.assertEqual(p['activationProvenance']['new']['inheritedActivationFrom'], 'mid')
        self.assertEqual(p['actors'][0]['toolActivity']['sessionId'], 'new')
        restarted = DiscoveryIndex(self.home, self.index.path)
        self.assertEqual(restarted.build(now=NOW)['projects'][0]['activationProvenance'], p['activationProvenance'])
        self.assertEqual(restarted.loads, 0)

    def test_invalid_native_chains_do_not_grant_membership(self):
        self.save('old', activation=True, ended=True)
        cases = [
            ('missing-parent', dict(parent='missing', seeded=True)),
            ('wrong-cwd', dict(parent='old', seeded=True, cwd='/synthetic/other')),
            ('depth-one', dict(parent='old', seeded=True, depth=1)),
            ('unknown-depth', dict(parent='old', seeded=True, depth=None)),
            ('descriptor', dict(parent='old', seeded=True, suffix=[('subagent/descriptor', NOW-1, {'name':'worker'})])),
            ('bad-seed', dict(parent='old', seeded=True, marker=False)),
            ('unseeded', dict(parent='old')),
            ('no-link', dict(seeded=True)),
            ('plain-new', dict()),
        ]
        for sid, kwargs in cases:
            with self.subTest(sid=sid):
                self.save(sid, **kwargs)
                p = self.project()
                self.assertNotIn(sid, p['sessionIds'])
                self.assertNotEqual(p['actors'][0]['motion'], 'working')
                self.assertNotIn('toolActivity', p['actors'][0])

    def test_cycle_unactivated_and_depth_limit_fail_closed(self):
        self.save('old', activation=True, ended=True)
        self.save('cycle-a', parent='cycle-b', seeded=True)
        self.save('cycle-b', parent='cycle-a', seeded=True)
        self.save('unactivated', ended=True)
        self.save('bad-child', parent='unactivated', seeded=True)
        parent = 'old'
        for i in range(65):
            self.save('generation-'+str(i), parent=parent, seeded=True, ended=True)
            parent = 'generation-'+str(i)
        p = self.project()
        for sid in ('cycle-a', 'cycle-b', 'bad-child', 'generation-64'):
            self.assertNotIn(sid, p['sessionIds'])
        self.assertIn('generation-63', p['sessionIds'])

    def test_prefix_old_pending_and_tool_do_not_replay_or_count(self):
        pending = ('tool/call', NOW-11, {'name':'ask_user_question', 'callId':'question', 'arguments':{'questions':[]}})
        oldtool = ('tool/call', NOW-11, {'name':'read', 'callId':'oldcall', 'arguments':{'file_path':'old.py'}})
        skill = ('user/message', NOW-11, {'source':{'kind':'skill-invocation','form':'instructions','name':'prefix-only'}})
        self.save('old', activation=True, ended=True, suffix=[pending, oldtool])
        self.save('new', parent='old', seeded=True, prefix=[pending, oldtool, skill])
        p = self.project()
        self.assertFalse(p['awaitingUser'])
        self.assertEqual(p['skillsUsed'], 0)
        self.assertEqual(p['actors'][0]['toolActivity']['sessionId'], 'new')
        self.assertEqual(p['actors'][0]['toolActivity']['calls'], [])
        self.assertTrue(p['actors'][0]['toolActivity']['thinking'])

    def test_new_suffix_tool_result_stays_session_local_and_end_exits(self):
        call = ('tool/call', NOW-1, {'name':'read', 'callId':'shared', 'arguments':{'file_path':'old.py'}})
        result = ('tool/result', NOW-.5, {'message':{'toolCallId':'shared','isError':False}})
        self.save('old', activation=True, ended=True, suffix=[call])
        self.save('new', parent='old', seeded=True, suffix=[result])
        self.assertEqual(self.project()['actors'][0]['toolActivity']['calls'], [])
        newcall = ('tool/call', NOW-.4, {'name':'read','callId':'newcall','arguments':{'file_path':'new.py'}})
        self.save('new', parent='old', seeded=True, suffix=[result, newcall])
        value = self.project()['actors'][0]['toolActivity']
        self.assertEqual(value['calls'][0]['target'], 'new.py')
        self.assertEqual(value['sessionId'], 'new')
        self.save('new', parent='old', seeded=True, ended=True)
        p = self.project()
        self.assertFalse(p['actors'][0]['active'])
        self.assertNotEqual(p['status'], 'done')
        self.assertNotIn('toolActivity', p['actors'][0])
        self.save('new', parent='old', seeded=True)
        p = self.index.build(now=NOW+301)['projects'][0]
        self.assertFalse(p['actors'][0]['active'])

    def test_parent_later_real_fresh_turn_question_and_job_remain_valid(self):
        self.save('old', activation=True, ended=True)
        self.save('new', parent='old', seeded=True)
        self.save('old', activation=True, ended=True, suffix=[
            ('turn/start', NOW-.8, {'turn':19}),
            ('step/start', NOW-.7, {'turn':19,'step':1}),
            ('tool/call', NOW-.6, {'name':'ask_user_question','callId':'new-question','arguments':{'questions':[]}}),
            ('job/registered', NOW-.5, {'jobId':'later-job','owner':'old'})])
        # save's final end is for turn 18, so later turn 19 remains open.
        p = self.project()
        self.assertTrue(p['awaitingUser'])
        self.assertEqual(p['pendingQuestion']['sessionId'], 'old')
        self.assertEqual(p['actors'][0]['toolActivity']['sessionId'], 'old')

    def test_external_and_duplicate_identity_cannot_anchor_native_chain(self):
        from discovery import continuation_activations
        self.save('old', activation=True, ended=True)
        self.save('new', parent='old', seeded=True)
        sessions, _, _ = self.index.scan()
        old = next(s for s in sessions if s['header']['id']=='old')
        new = next(s for s in sessions if s['header']['id']=='new')
        for changed in (dict(old, sourceKey='external:old'), dict(old, activationUntrusted=True),
                        dict(old, header=dict(old['header'], source='external-declared'))):
            self.assertEqual(continuation_activations([changed, new], NOW), {})
        self.assertEqual(continuation_activations(sessions+[old], NOW), {})

    def test_duplicate_successor_files_fail_closed_in_both_orders(self):
        self.save('root', activation=True, ended=True)
        source = self.save('next', parent='root', seeded=True)
        duplicate = self.home/'sessions/other/next/session.jsonl'
        duplicate.parent.mkdir(parents=True)
        duplicate.write_bytes(source.read_bytes())
        sessions, order, warnings = self.index.scan()
        self.assertEqual(sum(s['header']['id']=='next' for s in sessions), 2)
        for reverse in (False, True):
            with self.subTest(reverse=reverse):
                self.index.scan = lambda: (list(reversed(sessions)) if reverse else sessions, order, warnings)
                p = self.project()
                self.assertEqual(p['sessionIds'], ['root'])
                self.assertEqual(p['activationProvenance'], {})
                self.assertFalse(p['actors'][0]['active'])
                self.assertNotIn('toolActivity', p['actors'][0])

    def test_duplicate_successor_cwd_and_source_variants_fail_closed(self):
        import copy
        from discovery import continuation_activations
        self.save('root', activation=True, ended=True)
        self.save('next', parent='root', seeded=True)
        sessions, _, _ = self.index.scan()
        successor = next(s for s in sessions if s['header']['id']=='next')
        for variant in ('same', 'cwd', 'external', 'child'):
            duplicate = copy.deepcopy(successor)
            if variant == 'cwd': duplicate['header']['cwd'] = '/synthetic/other'
            if variant == 'external': duplicate['sourceKey'] = 'external:next'
            if variant == 'child': duplicate['header']['depth'] = 1
            for ordered in (sessions+[duplicate], [duplicate]+list(reversed(sessions))):
                with self.subTest(variant=variant):
                    self.assertEqual(continuation_activations(ordered, NOW), {})

    def test_duplicate_root_and_intermediate_files_never_anchor_successor(self):
        from discovery import continuation_activations
        self.save('root', activation=True, ended=True)
        self.save('mid', parent='root', seeded=True, ended=True)
        self.save('next', parent='mid', seeded=True)
        sessions, order, warnings = self.index.scan()
        for sid in ('root', 'mid'):
            duplicate = next(s for s in sessions if s['header']['id']==sid)
            for ordered in (sessions+[duplicate], [duplicate]+list(reversed(sessions))):
                with self.subTest(sid=sid):
                    self.assertNotIn('next', continuation_activations(ordered, NOW))
                    self.index.scan = lambda: (ordered, order, warnings)
                    p = self.project()
                    self.assertNotIn('next', p['sessionIds'])
                    self.assertFalse(p['actors'][0]['active'])
                    self.assertNotIn('toolActivity', p['actors'][0])

    def test_registry_owner_and_worker_bindings_remain_read_only(self):
        from unittest.mock import patch
        from test_tool_activity import fixture, NOW as FIXTURE_NOW
        self.index, root, self.home = fixture(self.tmp.name)
        registry_path = root/'.delegate/observer/runtime.json'
        before = registry_path.read_bytes()
        with patch(__name__+'.NOW', FIXTURE_NOW):
            self.save('pm-owner', cwd=str(root), activation=True, ended=True)
            self.save('new', cwd=str(root), parent='pm-owner', seeded=True)
        p = self.index.build(now=FIXTURE_NOW)['projects'][0]
        self.assertEqual(p['ownerSessionId'], 'pm-owner')
        self.assertEqual(p['actors'][0]['toolActivity']['sessionId'], 'new')
        self.assertEqual(p['actors'][1]['toolActivity']['sessionId'], 'eng-worker')
        self.assertEqual(registry_path.read_bytes(), before)

    def test_parent_corruption_revokes_inheritance_not_history(self):
        path = self.save('old', activation=True, ended=True)
        self.save('new', parent='old', seeded=True)
        self.assertTrue(self.project()['actors'][0]['active'])
        path.write_text('{broken')
        p = self.project()
        self.assertNotIn('new', p['sessionIds'])
        self.assertFalse(p['actors'][0]['active'])


if __name__ == '__main__':
    unittest.main()
