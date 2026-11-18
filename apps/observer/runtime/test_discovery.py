"""EXAMPLE-046 native metadata fixtures: no installed skill or foreign project trees."""
from datetime import datetime, timedelta
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from discovery import DiscoveryIndex, extract
from registry import activate, bind, update


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root/'dsh'
        self.now = time.time()
        self.index = DiscoveryIndex(self.home, self.root/'index.json', max_files=100)

    def event(self, kind, at=None, **data):
        # Native DSH stores integer milliseconds; fractional fixtures can round
        # a same-instant event a fraction into the future after float conversion.
        return dict(type=kind, time=int((self.now if at is None else at)*1000), data=data)

    def skill(self, name, at=None, success=True, call='call'):
        return [self.event('tool/call', at, name='skill', callId=call, arguments=json.dumps(dict(name=name))),
                self.event('tool/result', at, message=dict(toolCallId=call, isError=not success))]

    def session(self, sid, cwd='/not-read/project-a', events=(), seeded=False, inherited=None):
        p = self.home/'sessions/encoded'/sid/'session.jsonl'
        p.parent.mkdir(parents=True, exist_ok=True)
        if seeded and inherited is not None:
            events = list(events)
            events.insert(inherited, self.event('session/end-seed', inherited=True))
        data = [dict(type='session', id=sid, cwd=cwd, createdAt=(self.now-1000)*1000,
                     isSeeded=seeded, parentSession='parent' if seeded else None)] + list(events)
        for i, e in enumerate(data[1:]):
            e['seq'] = i
        p.write_text('\n'.join(json.dumps(e) for e in data)+'\n')
        if inherited is not None:
            q = self.home/'storages/session_projcache/sessions'/f'{sid}.json'
            q.parent.mkdir(parents=True, exist_ok=True)
            q.write_text(json.dumps(dict(record=dict(identity=dict(cwd=cwd, inheritedEventCount=inherited)))))
        return p

    def build(self, **kwargs):
        return self.index.build(now=self.now, **kwargs)

    def test_two_projects_three_sessions_and_cross_session_unique_skills(self):
        self.session('a', events=self.skill('shipboss')+self.skill('pdf'))
        self.session('b', events=self.skill('shipboss')+self.skill('pdf')+self.skill('sheet'))
        self.session('c', '/not-read/project-b', self.skill('shipboss'))
        x = self.build()
        self.assertEqual(len(x['projects']), 2)
        self.assertEqual(x['projects'][0]['skillsUsed'], 2)
        self.assertEqual(x['projects'][0]['sessionIds'], ['a', 'b'])

    def test_only_successful_calls_not_install_mentions_or_pending(self):
        self.session('a', events=[self.event('skills/catalog', names=['shipboss']),
            self.event('user/message', text='shipboss'), *self.skill('shipboss', success=False),
            self.skill('shipboss')[0]])
        self.assertEqual(self.build()['projects'], [])

    def test_seeded_prefix_is_not_usage_but_native_suffix_is(self):
        self.session('parent', events=self.skill('shipboss'))
        self.session('child', '/not-read/project-b', self.skill('shipboss')+self.skill('pdf'), seeded=True, inherited=2)
        self.assertEqual(len(self.build()['projects']), 1)
        self.session('child', '/not-read/project-b', self.skill('shipboss')+self.skill('shipboss'), seeded=True, inherited=2)
        self.assertEqual(len(self.build()['projects']), 2)

    def test_seeded_without_boundary_is_candidate_only(self):
        self.session('child', events=self.skill('shipboss'), seeded=True)
        self.assertEqual(self.build()['projects'], [])

    def test_fresh_running_pm_wins_over_newer_ended_session(self):
        self.session('a', events=self.skill('shipboss')+[self.event('turn/start', self.now-5, turn='1')])
        self.session('b', events=self.skill('shipboss')+[self.event('turn/end', self.now-1, turn='1')])
        p = self.build()['projects'][0]
        self.assertEqual(p['status'], 'implementing')
        self.assertTrue(p['actors'][0]['active'])
        self.assertFalse(p['isIdle'])

    def test_no_activation_no_pm_source_and_no_guessed_worker(self):
        self.session('a', events=self.skill('shipboss', self.now-1000))
        self.session('b', events=[self.event('turn/start', turn='1'),
            self.event('job/registered', jobId='job', label='engineer verifier', owner='b')])
        p = self.build()['projects'][0]
        self.assertTrue(p['isIdle'])
        self.assertFalse(any(a['active'] for a in p['actors']))

    def test_unknown_background_not_idle_or_complete(self):
        self.session('a', events=self.skill('shipboss', self.now-1000)+[
            self.event('job/registered', self.now-900, jobId='job', owner='a'),
            self.event('turn/end', self.now-800, turn='1')])
        p = self.build()['projects'][0]
        self.assertEqual(p['status'], 'dispatching')
        self.assertEqual(p['observation']['status'], 'unknown')
        self.assertTrue(p['isIdle'])
        self.assertFalse(any(a['active'] for a in p['actors'][1:]))

    def test_refresh_is_not_activity_dim_and_recovery(self):
        old = self.now-301
        path = self.session('a', events=self.skill('shipboss', old)+[self.event('turn/start', old, turn='1')])
        p = self.build()['projects'][0]
        self.assertTrue(p['isIdle']); self.assertGreaterEqual(p['idleForSeconds'], 301)
        self.assertEqual(self.build()['projects'][0]['lastActivityAt'], p['lastActivityAt'])
        with path.open('a') as f:
            f.write(json.dumps(self.event('step/start', turn='1'))+'\n')
        self.assertFalse(self.build()['projects'][0]['isIdle'])

    def test_today_reset_alias_exclusion_and_more_than_fourteen(self):
        midnight = datetime.fromtimestamp(self.now).replace(hour=0, minute=0, second=0, microsecond=0)
        yesterday = (midnight-timedelta(seconds=1)).timestamp()
        events = self.skill('shipboss')+self.skill('shipboss-dsh-plugin')+self.skill('old', yesterday)
        events += self.skill('delegate-build')
        for i in range(19):
            events += self.skill('other-'+str(i), call=str(i))
        self.session('a', events=events)
        p = self.build()['projects'][0]
        self.assertEqual(p['skillsUsed'], 20)
        self.assertEqual(p['skillPeriod'], '今天用过的其它技能')
        tomorrow = (midnight+timedelta(days=1, seconds=1)).timestamp()
        self.assertEqual(self.index.build(now=tomorrow)['projects'][0]['skillsUsed'], 0)

    def test_cache_restart_stable_order_new_file_corruption(self):
        self.session('z', '/not-read/z', self.skill('shipboss'))
        before = self.build(); self.assertEqual(self.index.loads, 1)
        self.build(); self.assertEqual(self.index.loads, 1)
        restarted = DiscoveryIndex(self.home, self.root/'index.json')
        self.assertEqual(restarted.build(now=self.now)['projects'][0]['id'], before['projects'][0]['id'])
        self.assertEqual(restarted.loads, 0)
        self.session('a', '/not-read/a', self.skill('shipboss'))
        p = self.session('bad'); p.write_text('{broken\n')
        x = self.build()
        self.assertEqual([p['name'] for p in x['projects']], ['z', 'a'])
        self.assertFalse(x['coverage']['complete'])
        loads = self.index.loads; self.build(); self.assertEqual(loads, self.index.loads)

    def test_bounded_scan_catches_up(self):
        self.index.max_files = 1
        self.session('a', events=self.skill('shipboss'))
        self.session('b', '/not-read/b', self.skill('shipboss'))
        self.assertFalse(self.build()['coverage']['complete'])
        self.assertEqual(len(self.build()['projects']), 2)
        self.assertTrue(self.build()['coverage']['complete'])

    def test_explicit_registry_keeps_role_and_review_status_when_dim(self):
        project = self.root/'explicit'; project.mkdir()
        activate(project, 'pm', 'pm')
        bind(project, assignment='eng', task='T', role='engineer', slot='eng-a', policy='new',
             context_id='eng', session_id='eng', job_id='j')
        update(project, 'eng', state='completed', exit_code=0)
        self.session('pm', str(project), self.skill('shipboss', self.now-2000))
        p = self.index.build(now=self.now+2000, explicit_roots=[project])['projects'][0]
        self.assertTrue(p['isIdle'])
        self.assertNotEqual(p['status'], 'done')
        self.assertEqual(p['tasks'][0]['verification'], 'queued')
        self.assertFalse(p['actors'][3]['active'])

    def test_decode_size_and_timeout_visible_not_blocking(self):
        self.session('a', events=self.skill('shipboss'))
        self.session('bad')
        from discovery import extract as real_extract
        def fail(path, identity):
            if path.parent.name == 'bad':
                raise ValueError('decode-timeout')
            return real_extract(path, identity)
        with patch('discovery.extract', side_effect=fail):
            x = self.build()
        self.assertEqual(len(x['projects']), 1)
        self.assertTrue(any('decode-timeout' in w for w in x['coverage']['warnings']))

    def test_question_waiting_is_independent_of_inactivity(self):
        self.session('a', events=self.skill('shipboss', self.now-600)+[
            self.event('tool/call', self.now-400, name='ask_user_question', callId='q',
                       arguments=dict(questions=[dict(id='q1', question='not persisted')]))])
        p = self.build()['projects'][0]
        self.assertEqual(p['status'], 'needs-human')
        # Confirmed waiting presence overrides inactivity; attention dimming is
        # a separate renderer policy, not an assertion that the room is empty.
        self.assertFalse(p['isIdle'])
        self.assertGreaterEqual(p['idleForSeconds'], 400)
        self.assertTrue(p['awaitingUser'])
        self.assertEqual(p['actors'][0]['motion'], 'waiting')
        self.assertNotIn('not persisted', (self.root/'index.json').read_text())

    def test_nonactivated_background_does_not_grant_role_or_fake_idle(self):
        self.session('a', events=self.skill('shipboss')+[self.event('turn/end', turn='1')])
        self.session('b', events=[self.event('job/registered', jobId='j', owner='b')])
        p = self.build()['projects'][0]
        self.assertEqual(p['status'], 'dispatching')
        self.assertFalse(any(a['active'] for a in p['actors']))

    def test_package_install_name_is_not_a_skill_activation(self):
        self.session('a', events=self.skill('shipboss-dsh-plugin'))
        self.assertEqual(self.build()['projects'], [])

    def test_unchanged_index_not_rewritten(self):
        self.session('a', events=self.skill('shipboss'))
        self.build()
        stamp = self.index.path.stat().st_mtime_ns
        self.build()
        self.assertEqual(self.index.path.stat().st_mtime_ns, stamp)

    def test_real_stream_limit_and_corrupt_json_leave_other_room(self):
        self.session('a', events=self.skill('shipboss'))
        self.build()
        p = self.session('big', '/not-read/big')
        p.write_bytes(b'x'*1024)
        with patch('discovery.MAX_BYTES', 512):
            x = self.build()
        self.assertEqual(len(x['projects']), 1)
        self.assertTrue(any('size-limit' in w for w in x['coverage']['warnings']))

    def test_corrupt_updated_file_preserves_history_not_live_pm(self):
        p = self.session('a', events=self.skill('shipboss', self.now-1000)+[
            self.event('turn/start', turn='1')])
        before = self.build()['projects'][0]
        self.assertTrue(before['actors'][0]['active'])
        p.write_text('{broken')
        after = self.build()['projects'][0]
        self.assertEqual(after['id'], before['id'])
        self.assertFalse(after['actors'][0]['active'])
        self.assertTrue(after['isIdle'])
        self.assertEqual(after['observation']['status'], 'unknown')

    def direct(self, name, **source):
        return self.event('user/message', source=dict(kind='skill-invocation', name=name,
                          form='instructions', **source))

    def test_direct_injection_activates_and_deduplicates_other_skills(self):
        self.session('a', events=[self.direct('shipboss'), self.direct('pdf')]+self.skill('pdf'))
        self.session('b', events=[self.direct('shipboss'), self.direct('pdf')])
        p = self.build()['projects'][0]
        self.assertEqual(p['skillsUsed'], 1)
        self.assertEqual(p['sessionIds'], ['a', 'b'])

    def test_direct_invalid_catalog_missing_form_and_prose_not_usage(self):
        events = [self.event('user/message', source=dict(kind='skill-catalog', name='shipboss', form='instructions')),
                  self.event('user/message', source=dict(kind='skill-invocation', name='shipboss')),
                  self.event('user/message', source=dict(kind='skill-invocation', name='shipboss', form='catalog')),
                  self.event('user/message', content='/shipboss', source=dict(kind='user'))]
        self.session('a', events=events)
        self.assertEqual(self.build()['projects'], [])

    def test_root_restore_empty_marker_keeps_success_and_pending_call(self):
        call, result = self.skill('shipboss')
        self.session('a', events=[call, self.event('session/end-seed'), result,
                                  self.event('session/end-seed')], inherited=0)
        self.assertEqual(len(self.build()['projects']), 1)

    def test_seed_marker_without_index_and_later_empty_markers(self):
        events = [self.direct('shipboss'), self.event('session/end-seed', inherited=True),
                  self.event('session/end-seed'), self.direct('shipboss'), self.direct('pdf'),
                  self.event('session/end-seed')]
        self.session('a', events=events, seeded=True)
        p = self.build()['projects'][0]
        self.assertEqual(p['skillsUsed'], 1)

    def test_seed_index_conflict_is_unknown_and_does_not_retain_cached_room(self):
        self.session('a', events=self.skill('shipboss')+self.skill('shipboss'), seeded=True, inherited=2)
        self.assertEqual(len(self.build()['projects']), 1)
        identity = self.home/'storages/session_projcache/sessions/a.json'
        d = json.loads(identity.read_text()); d['record']['identity']['inheritedEventCount'] = 3
        identity.write_text(json.dumps(d))
        x = self.build()
        self.assertEqual(x['projects'], [])
        self.assertTrue(any('seed-boundary' in w for w in x['coverage']['warnings']))

    def test_final_true_marker_cuts_earlier_success_and_cross_cut_result(self):
        call, result = self.skill('shipboss')
        self.session('a', events=[self.event('session/end-seed', inherited=True),
            self.direct('shipboss'), call, self.event('session/end-seed', inherited=True), result,
            self.direct('pdf'), self.event('session/end-seed')], seeded=True)
        self.assertEqual(self.build()['projects'], [])

    def test_incomplete_eof_cannot_confirm_seed_usage(self):
        self.session('a', events=[self.event('session/end-seed', inherited=True), self.direct('shipboss')], seeded=True)
        from discovery import lines as real_lines
        def incomplete(path):
            yield from real_lines(path)
            raise ValueError('decode-failed-before-confirmed-eof')
        with patch('discovery.lines', side_effect=incomplete):
            x = self.build()
        self.assertEqual(x['projects'], [])
        self.assertFalse(x['coverage']['complete'])

    def test_fresh_parent_without_cut_is_not_inherited(self):
        p = self.session('a', events=self.skill('shipboss'))
        data = [json.loads(line) for line in p.read_text().splitlines()]
        data[0]['parentSession'] = 'parent'
        p.write_text('\n'.join(json.dumps(e) for e in data)+'\n')
        self.assertEqual(len(self.build()['projects']), 1)

    def test_unseeded_true_marker_or_nonzero_cut_is_unknown(self):
        self.session('a', events=self.skill('shipboss')+[self.event('session/end-seed', inherited=True)])
        self.session('b', events=self.skill('shipboss'), inherited=2)
        x = self.build()
        self.assertEqual(x['projects'], [])
        self.assertEqual(len(x['coverage']['warnings']), 2)

    def test_seed_fallback_requires_dense_seq_and_matching_header_id(self):
        p = self.session('a', events=[self.event('session/end-seed', inherited=True), self.direct('shipboss')], seeded=True)
        data = [json.loads(line) for line in p.read_text().splitlines()]
        data[-1]['seq'] = 99
        p.write_text('\n'.join(json.dumps(e) for e in data)+'\n')
        self.assertEqual(self.build()['projects'], [])

    def test_default_exclude_before_extract_by_identity_and_encoded_directory(self):
        self.session('restricted', '/not-read/ExcludedProject', self.skill('shipboss'), inherited=0)
        p = self.session('encoded', events=self.skill('shipboss'))
        target = self.home/'sessions/--not-read-ExcludedProject--/encoded/session.jsonl'
        target.parent.mkdir(parents=True); p.rename(target)
        self.session('allowed', events=self.skill('shipboss'))
        from discovery import extract as real_extract
        def guarded(path, identity):
            self.assertEqual(path.parent.name, 'allowed')
            return real_extract(path, identity)
        with patch('discovery.extract', side_effect=guarded):
            x = self.build()
        self.assertEqual(len(x['projects']), 1)
        self.assertEqual(x['coverage']['excluded_count'], 2)
        self.assertFalse(x['coverage']['complete'])

    def test_exclude_purges_old_cache_and_new_restricted_session(self):
        self.session('restricted', '/not-read/ExcludedProject', self.skill('shipboss'), inherited=0)
        initial = DiscoveryIndex(self.home, self.root/'index.json', exclude=())
        self.assertEqual(len(initial.build(now=self.now)['projects']), 1)
        restricted = DiscoveryIndex(self.home, self.root/'index.json')
        with patch('discovery.extract', side_effect=AssertionError('restricted log opened')):
            self.assertEqual(restricted.build(now=self.now)['projects'], [])
            self.session('new', '/not-read/ExcludedProject', self.skill('shipboss'), inherited=0)
            x = restricted.build(now=self.now)
        self.assertEqual(x['coverage']['excluded_count'], 2)
        self.assertEqual(restricted.data['files'], {})
        self.assertEqual(restricted.data['order'], [])

    def test_configured_extra_exclude(self):
        self.session('a', '/not-read/private', self.skill('shipboss'), inherited=0)
        index = DiscoveryIndex(self.home, self.root/'other-index.json', exclude=('ExcludedProject', '/not-read/private'))
        with patch('discovery.extract', side_effect=AssertionError('excluded log opened')):
            x = index.build(now=self.now)
        self.assertEqual(x['coverage']['excluded_count'], 1)
        self.assertEqual(x['projects'], [])

    def test_child_question_cannot_occupy_ended_parent_pm(self):
        self.session('parent', events=self.skill('shipboss', self.now-700)+[
            self.event('turn/start', self.now-650, turn='1'),
            self.event('turn/end', self.now-600, turn='1')])
        path = self.session('child', events=[self.direct('shipboss'),
            self.event('tool/call', name='ask_user_question', callId='child-q',
                       arguments=dict(questions=[dict(id='q', question='child question')]))])
        data = [json.loads(line) for line in path.read_text().splitlines()]
        data[0]['parentSession'] = 'parent'
        path.write_text('\n'.join(json.dumps(e) for e in data)+'\n')
        p = self.build()['projects'][0]
        self.assertFalse(p['actors'][0]['active'])
        self.assertEqual(p['actors'][0]['motion'], 'idle')
        self.assertFalse(p['needsAttention'])
        self.assertFalse(p['awaitingUser'])
        self.assertIsNone(p.get('pendingQuestion'))
        self.assertNotEqual(p['status'], 'needs-human')
        self.assertFalse(any(a['active'] for a in p['actors'][1:]))

    def test_root_and_explicit_child_owner_questions_keep_pm_question_mark(self):
        for explicit_child in (False, True):
            with self.subTest(explicit_child=explicit_child):
                sid = 'explicit-pm' if explicit_child else 'root-pm'
                project = self.root/sid
                project.mkdir()
                path = self.session(sid, str(project), [self.direct('shipboss'),
                    self.event('tool/call', name='ask_user_question', callId=sid+'-q',
                               arguments=dict(questions=[dict(id='q', question='PM question')]))])
                if explicit_child:
                    data = [json.loads(line) for line in path.read_text().splitlines()]
                    data[0]['parentSession'] = 'parent'
                    path.write_text('\n'.join(json.dumps(e) for e in data)+'\n')
                    activate(project, sid, sid)
                x = self.build(explicit_roots=[project] if explicit_child else [])
                p = next(p for p in x['projects'] if p['name'] == sid)
                self.assertTrue(p['actors'][0]['active'])
                self.assertEqual(p['actors'][0]['motion'], 'waiting')
                self.assertTrue(p['needsAttention'])
                self.assertTrue(p['awaitingUser'])
                self.assertEqual(p['pendingQuestion']['sessionId'], sid)
                self.assertEqual(p['status'], 'needs-human')

    def test_successful_delegate_build_is_other_skill_on_both_paths(self):
        for direct in (False, True):
            with self.subTest(direct=direct):
                cwd = '/not-read/direct-spelling' if direct else '/not-read/tool-spelling'
                events = [self.direct('delegate-build')] if direct else self.skill('delegate-build')
                self.session('direct' if direct else 'tool', cwd,
                             [self.direct('shipboss')]+events)
                p = next(p for p in self.build()['projects'] if p['name'] == cwd.rsplit('/', 1)[-1])
                self.assertEqual(p['skillsUsed'], 1)
                self.assertEqual(p['skillNames'], ['delegate-build'])

    def test_delegate_build_failed_not_counted_success_dedup_across_paths_sessions(self):
        self.session('a', events=[self.direct('shipboss')]+self.skill('delegate-build', success=False))
        self.assertEqual(self.build()['projects'][0]['skillsUsed'], 0)
        self.session('b', events=self.skill('delegate-build')+[self.direct('delegate-build')])
        self.session('c', events=[self.direct('delegate-build')])
        p = self.build()['projects'][0]
        self.assertEqual(p['skillsUsed'], 1)
        self.assertEqual(p['skillNames'], ['delegate-build'])
        self.assertEqual(p['sessionIds'], ['a'])

    def test_excluded_discovered_project_never_reads_tree_or_registry(self):
        self.session('a', '/unreadable/ExcludedProject', self.skill('shipboss'))
        from pathlib import Path as P
        read_text = P.read_text
        def guarded(path, *args, **kwargs):
            self.assertFalse(str(path).startswith('/unreadable'))
            return read_text(path, *args, **kwargs)
        with patch.object(P, 'read_text', guarded), patch('discovery.discovered_registry', side_effect=AssertionError('excluded registry')):
            self.assertEqual(len(self.build()['projects']), 0)


if __name__ == '__main__':
    unittest.main()
