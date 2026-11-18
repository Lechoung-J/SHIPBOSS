"""EXAMPLE-052 ownership rework: exact start-time ownership and strict native sources."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from discovery import DiscoveryIndex, extract
from registry import read, atomic_write
from test_tool_activity import NOW, fixture, native


class ActivityOwnershipTests(unittest.TestCase):
    def two_assignments(self, directory, *, equal=False):
        index, root, home = fixture(directory)
        registry = read(root)
        old = registry['assignments']['eng-first']
        new = copy.deepcopy(old)
        new.update(assignment='second', slot='eng-b', task='task-2', bound_at=old['bound_at'] if equal else NOW-1, updated_at=NOW-.1)
        registry['assignments']['second'] = new
        atomic_write(root/'.delegate/observer/runtime.json', registry)
        return index, root, home

    def test_half_open_start_exact_millisecond_boundary(self):
        with tempfile.TemporaryDirectory() as td:
            index, root, home = self.two_assignments(td)
            calls = [('tool/call', at, dict(name='read', callId=cid, arguments={'file_path':'app.ts'}))
                     for cid, at in [('before', NOW-1-.001), ('exact', NOW-1), ('after', NOW-1+.001), ('now', NOW)]]
            native(home/'sessions/encoded/eng-worker/session.jsonl', 'eng-worker', root, calls, 'pm-owner')
            project = index.build(now=NOW)['projects'][0]
            owners = {cid: [a['id'] for a in project['actors'] if any(c['callId'] == cid for c in a.get('toolActivity', {}).get('calls', []))]
                      for cid in ('before','exact','after','now')}
            self.assertEqual(owners, dict(before=['eng-a'], exact=['eng-b'], after=['eng-b'], now=['eng-b']))
            self.assertTrue(all(t['verdict'] is None for t in project['tasks']))

    def test_equal_bound_is_unknown_for_both_roles_and_explicit_thinking(self):
        with tempfile.TemporaryDirectory() as td:
            index, root, home = self.two_assignments(td, equal=True)
            registry = read(root)
            for r in registry['assignments'].values(): r['phase'] = 'thinking'
            atomic_write(root/'.delegate/observer/runtime.json', registry)
            events = [('turn/start', NOW-3, {'turn':1}), ('step/start', NOW-2, {'turn':1,'step':1}),
                      ('tool/call', NOW-1, {'name':'read','callId':'ambiguous','arguments':{'file_path':'app.ts'}})]
            native(home/'sessions/encoded/eng-worker/session.jsonl', 'eng-worker', root, events, 'pm-owner')
            project = index.build(now=NOW)['projects'][0]
            for actor in project['actors'][1:3]:
                self.assertTrue(actor['toolActivity']['suppressed'])
                self.assertFalse(actor['toolActivity']['thinking'])
                self.assertEqual(actor['toolActivity']['calls'], [])
                self.assertEqual(actor['role'], 'engineer')

    def test_late_result_stays_with_start_window_and_does_not_clear_new_call(self):
        with tempfile.TemporaryDirectory() as td:
            index, root, home = self.two_assignments(td)
            events = [('tool/call', NOW-2, {'name':'read','callId':'old','arguments':{'file_path':'old.ts'}}),
                      ('tool/call', NOW-1, {'name':'edit','callId':'new','arguments':{'file_path':'new.ts'}}),
                      ('tool/result', NOW-.1, {'message':{'toolCallId':'old','isError':True}})]
            native(home/'sessions/encoded/eng-worker/session.jsonl', 'eng-worker', root, events, 'pm-owner')
            for _ in range(2):
                project = index.build(now=NOW)['projects'][0]
                self.assertEqual([(c['callId'],c['state']) for c in project['actors'][1]['toolActivity']['calls']], [('old','error')])
                self.assertEqual([(c['callId'],c['state']) for c in project['actors'][2]['toolActivity']['calls']], [('new','started')])
                self.assertEqual(project['actors'][2]['toolActivity']['runningCount'], 1)
                self.assertTrue(all(t['verdict'] is None for t in project['tasks']))
            # Explicit terminal/expired lifecycle still wins over cached tool data.
            registry = read(root)
            registry['assignments']['eng-first'].update(state='completed', updated_at=NOW)
            registry['assignments']['second'].update(updated_at=NOW-1000)
            atomic_write(root/'.delegate/observer/runtime.json', registry)
            project = index.build(now=NOW)['projects'][0]
            self.assertFalse(project['actors'][1]['active'])
            self.assertNotIn('toolActivity', project['actors'][1])
            self.assertTrue(project['actors'][2]['uncertain'])
            self.assertNotIn('toolActivity', project['actors'][2])

    def test_step_boundary_qualifies_only_latest_window(self):
        with tempfile.TemporaryDirectory() as td:
            index, root, home = self.two_assignments(td)
            events = [('turn/start', NOW-3, {'turn':1}), ('step/start', NOW-1, {'turn':1,'step':0})]
            native(home/'sessions/encoded/eng-worker/session.jsonl', 'eng-worker', root, events, 'pm-owner')
            actors = index.build(now=NOW)['projects'][0]['actors']
            self.assertFalse(actors[1]['toolActivity']['thinking'])
            self.assertTrue(actors[2]['toolActivity']['thinking'])

    def test_explicit_invalid_sources_suppress_call_result_and_step_paths(self):
        invalid = ['foreign-source', 42, None, [], {'sessionId':None}, {'sessionId':42}, {'sessionId':False}, {'sessionId':'foreign'}]
        for kind in ('tool/call','tool/result','step/start','step/end','turn/start','turn/end'):
            for source in invalid:
                with self.subTest(kind=kind, source=source), tempfile.TemporaryDirectory() as td:
                    index, root, home = fixture(td)
                    registry = read(root); registry['assignments']['eng-first']['phase'] = 'thinking'
                    atomic_write(root/'.delegate/observer/runtime.json', registry)
                    data = {'turn':1,'step':1,'source':source}
                    if kind == 'tool/call': data.update(name='read',callId='foreign',arguments={'file_path':'bad.ts'})
                    if kind == 'tool/result': data['message'] = {'toolCallId':'local','isError':False}
                    events = [('turn/start', NOW-4, {'turn':1}), ('step/start', NOW-3, {'turn':1,'step':1}),
                              ('tool/call', NOW-2, {'name':'read','callId':'local','arguments':{'file_path':'app.ts'}}), (kind,NOW-1,data)]
                    path = home/'sessions/encoded/eng-worker/session.jsonl'
                    native(path,'eng-worker',root,events,'pm-owner')
                    metadata = extract(path,{})
                    self.assertEqual(metadata['tools'], [])
                    self.assertTrue(metadata['activitySourceInvalid'])
                    actor = index.build(now=NOW)['projects'][0]['actors'][1]
                    self.assertTrue(actor['toolActivity']['suppressed'])
                    self.assertFalse(actor['toolActivity']['thinking'])
                    self.assertEqual(actor['toolActivity']['calls'], [])

    def test_missing_and_valid_object_sources_preserve_local_call_result_step(self):
        for source in ('absent', {}, {'sessionId':'eng-worker'}):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as td:
                index, root, home = fixture(td)
                events = [('turn/start',NOW-4,{'turn':1}),('step/start',NOW-3,{'turn':1,'step':1}),
                          ('tool/call',NOW-2,{'name':'read','callId':'local','arguments':{'file_path':'app.ts'}}),
                          ('tool/result',NOW-1,{'message':{'toolCallId':'local','isError':False}})]
                if source != 'absent':
                    for _,_,data in events: data['source'] = source
                native(home/'sessions/encoded/eng-worker/session.jsonl','eng-worker',root,events,'pm-owner')
                value = index.build(now=NOW)['projects'][0]['actors'][1]['toolActivity']
                self.assertEqual(value['calls'][0]['state'],'ended')
                self.assertTrue(value['thinking'])

    def test_inherited_invalid_source_does_not_poison_local_suffix(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td)/'session.jsonl'
            events = [('tool/call',NOW-3,{'source':42,'name':'read','callId':'old','arguments':{}}),
                      ('session/end-seed',NOW-2,{'inherited':True}),
                      ('tool/call',NOW-1,{'name':'read','callId':'fresh','arguments':{'file_path':'app.ts'}})]
            native(path,'worker','/synthetic/project',events,'pm',seeded=True)
            value = extract(path,{'inheritedEventCount':1})
            self.assertFalse(value['activitySourceInvalid'])
            self.assertEqual([c['callId'] for c in value['tools']],['fresh'])

    def test_cache_trust_upgrade_reparses_wide_source_without_losing_order(self):
        with tempfile.TemporaryDirectory() as td:
            index, root, home = fixture(td)
            index.build(now=NOW)
            order = list(index.data['order'])
            path = home/'sessions/encoded/eng-worker/session.jsonl'
            rows = [json.loads(row) for row in path.read_text().splitlines()]
            rows[-1]['data']['source'] = 42
            path.write_text('\n'.join(json.dumps(row) for row in rows)+'\n')
            st = path.stat()
            key = str(path.relative_to(home))
            entry = index.data['files'][key]
            entry['signature'] = [st.st_dev,st.st_ino,st.st_mtime_ns,st.st_size,None,None,None,'activity-v1-bounded-tools']
            entry['metadata'].pop('activitySourceInvalid',None)
            atomic_write(index.path,index.data)
            upgraded = DiscoveryIndex(home,index.path)
            actor = upgraded.build(now=NOW)['projects'][0]['actors'][1]
            self.assertTrue(actor['toolActivity']['suppressed'])
            self.assertEqual(actor['toolActivity']['calls'],[])
            self.assertGreater(upgraded.loads,0)
            self.assertEqual(upgraded.data['order'],order)
            self.assertEqual(upgraded.data['files'][key]['signature'][-1],'roles-v4-incremental-native')


if __name__ == '__main__':
    unittest.main()
