"""Native fixtures only; no host logs, real projects or preferences are touched."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from discovery import DiscoveryIndex, extract
from registry import activate, bind, update, read, atomic_write
from tool_activity import summarize, call_metadata

NOW = 1794790000


def native(path, sid, cwd, events, parent=None, seeded=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    header = dict(type='session', id=sid, cwd=str(cwd), isSeeded=seeded,
                  parentSession=parent, delegationDepth=1 if parent else 0)
    rows = [header] + [dict(type=kind, seq=i, time=at*1000, data=body) for i, (kind, at, body) in enumerate(events)]
    path.write_text('\n'.join(json.dumps(r) for r in rows)+'\n')


def fixture(directory, *, native_ids=False):
    base = Path(directory).resolve()
    root, home = base/'project', base/'dsh'
    root.mkdir(parents=True, exist_ok=True)
    activate(root, 'pm-owner', 'pm-context')
    bind(root, assignment='eng-first', task='task-1', role='engineer', slot='eng-a', policy='new', context_id='eng-context', session_id='eng-worker', agent_id='engineer')
    update(root, 'eng-first', state='running', phase='working')
    d = read(root)
    d['activated_at'] = NOW-30
    d['assignments']['eng-first'].update(bound_at=NOW-20, updated_at=NOW-1)
    atomic_write(root/'.delegate/observer/runtime.json', d)
    pm_call = 'call_' + 'a'*74 + '|end' if native_ids else 'pm-read'
    eng_call = 'call_' + 'b'*82 + '|end' if native_ids else 'eng-edit'
    events = [('user/message', NOW-25, {'source': {'kind': 'skill-invocation', 'name': 'shipboss', 'form': 'instructions'}}),
              ('turn/start', NOW-10, {'turn': 1}), ('step/start', NOW-1, {'turn': 1, 'step': 1}),
              ('tool/call', NOW-.8, {'name': 'read', 'callId': pm_call, 'arguments': {'file_path': '/tmp/app.ts', 'secret': 'SECRET_BODY'}})]
    native(home/'sessions/encoded/pm-owner/session.jsonl', 'pm-owner', root, events)
    worker_events = [('subagent/descriptor', NOW-15, {'name': 'worker'}), ('turn/start', NOW-10, {'turn': 2}), ('step/start', NOW-1, {'turn': 2, 'step': 1}),
                     ('tool/call', NOW-.6, {'name': 'edit', 'callId': eng_call, 'arguments': json.dumps({'file_path': '/tmp/index.ts', 'old_string': 'SECRET_BODY', 'new_string': 'SECRET_CODE'})})]
    native(home/'sessions/encoded/eng-worker/session.jsonl', 'eng-worker', root, worker_events, parent='pm-owner')
    index = DiscoveryIndex(home, base/'index.json')
    return index, root, home


class ToolActivityTests(unittest.TestCase):
    def test_display_basename_allowlist(self):
        for name in ('.env', 'client.pem', 'api-key.json', 'accessToken.ts', 'credentials.yaml', 'private-key.txt', 'customer.bin', 'id_rsa', 'secret.js'):
            self.assertEqual(call_metadata({'name':'read','callId':'c'}, {'file_path':'/tmp/'+name})['target'], '', name)
        for name in ('app.ts', 'package.json', 'Dockerfile', 'README.md'):
            self.assertEqual(call_metadata({'name':'read','callId':'c'}, {'file_path':'/tmp/'+name})['target'], name)

    def test_native_writer_identity_and_no_bodies(self):
        with tempfile.TemporaryDirectory() as td:
            index, root, home = fixture(td)
            payload = index.build(now=NOW)
            actors = payload['projects'][0]['actors']
            self.assertEqual(actors[0]['toolActivity']['calls'][0]['category'], 'read')
            self.assertEqual(actors[1]['toolActivity']['calls'][0]['category'], 'edit')
            self.assertEqual(actors[1]['toolActivity']['sessionId'], 'eng-worker')
            self.assertEqual(actors[1]['role'], 'engineer')
            self.assertNotIn('toolActivity', actors[2])
            self.assertNotIn('SECRET', json.dumps(index.data)+json.dumps(payload))
            self.assertNotIn('/tmp/', json.dumps(index.data))
            self.assertIsNone(payload['projects'][0]['tasks'][0]['verdict'])
            loads = index.loads
            index.build(now=NOW)
            self.assertEqual(index.loads, loads)

    def test_concurrent_dedup_out_of_order_error(self):
        def call(cid, seq):
            return dict(type='tool/call', seq=seq, time=NOW*1000, data={'tool':dict(callId=cid, category='command', target='')})
        def result(cid, seq, err=False):
            return dict(type='tool/result', seq=seq, time=NOW*1000+10, data={'message':dict(toolCallId=cid, isError=err)})
        events = [call('old', 1), call('new', 2), result('old', 3, True)]
        tools, overflow = summarize(events+events[::-1])
        self.assertFalse(overflow)
        self.assertEqual({c['callId']:c['state'] for c in tools}, {'old':'error', 'new':'started'})
        self.assertEqual(summarize([result('old', 3), call('old', 1)])[0][0]['state'], 'ended')
        self.assertTrue(summarize([call('call-'+str(i), i) for i in range(33)])[1])

    def test_unregistered_wrong_owner_expired_and_foreign(self):
        with tempfile.TemporaryDirectory() as td:
            index, root, home = fixture(td)
            p = index.build(now=NOW)['projects'][0]
            self.assertTrue(p['actors'][1].get('toolActivity'))
            d = read(root)
            d['assignments']['eng-first']['owner_session'] = 'wrong'
            atomic_write(root/'.delegate/observer/runtime.json', d)
            p = index.build(now=NOW)['projects'][0]
            self.assertNotIn('toolActivity', p['actors'][1])
            d['assignments'] = {}
            atomic_write(root/'.delegate/observer/runtime.json', d)
            p = index.build(now=NOW)['projects'][0]
            self.assertNotIn('toolActivity', p['actors'][1])
            path = home/'sessions/encoded/pm-owner/session.jsonl'
            data = [json.loads(line) for line in path.read_text().splitlines()]
            data[-1]['data']['source'] = {'sessionId': 'foreign'}
            path.write_text('\n'.join(json.dumps(r) for r in data)+'\n')
            p = index.build(now=NOW)['projects'][0]
            self.assertEqual(p['actors'][0]['toolActivity']['calls'], [])
            p = index.build(now=NOW+1000)['projects'][0]
            self.assertFalse(any(a.get('toolActivity') for a in p['actors']))

    def test_step_pairing_and_explicit_testing(self):
        with tempfile.TemporaryDirectory() as td:
            index, root, home = fixture(td)
            path = home/'sessions/encoded/eng-worker/session.jsonl'
            events = [('turn/start', NOW-4, {'turn': 2}), ('step/start', NOW-3, {'turn': 2, 'step': 'a'}),
                      ('step/end', NOW-2, {'turn': 2, 'step': 'other'})]
            native(path, 'eng-worker', root, events, 'pm-owner')
            p = index.build(now=NOW)['projects'][0]
            self.assertTrue(p['actors'][1]['toolActivity']['thinking'])
            events.append(('step/end', NOW-1, {'turn': 2, 'step': 'a'}))
            native(path, 'eng-worker', root, events, 'pm-owner')
            self.assertFalse(index.build(now=NOW)['projects'][0]['actors'][1]['toolActivity']['thinking'])
            events.append(('tool/call', NOW-.5, {'name': 'bash', 'callId': 'cmd', 'arguments': {'command': 'SECRET_CMD'}}))
            native(path, 'eng-worker', root, events, 'pm-owner')
            self.assertEqual(index.build(now=NOW)['projects'][0]['actors'][1]['toolActivity']['calls'][0]['category'], 'command')
            d = read(root); d['assignments']['eng-first']['phase'] = 'testing'; atomic_write(root/'.delegate/observer/runtime.json', d)
            self.assertEqual(index.build(now=NOW)['projects'][0]['actors'][1]['toolActivity']['calls'][0]['category'], 'test')

    def test_upgrade_reparses_preserves_order_and_corrupt_clears(self):
        with tempfile.TemporaryDirectory() as td:
            index, root, home = fixture(td)
            index.build(now=NOW)
            order = list(index.data['order'])
            for entry in index.data['files'].values():
                entry['signature'][-1] = 'presence-v3-exact-job-owner'
                entry['metadata'].pop('tools', None)
            atomic_write(index.path, index.data)
            upgraded = DiscoveryIndex(home, index.path)
            self.assertEqual(upgraded.build(now=NOW)['projects'][0]['actors'][0]['toolActivity']['calls'][0]['category'], 'read')
            self.assertEqual(upgraded.data['order'], order)
            path = home/'sessions/encoded/pm-owner/session.jsonl'
            with path.open('a') as f: f.write('{broken\n')
            p = upgraded.build(now=NOW)['projects'][0]
            self.assertNotIn('toolActivity', p['actors'][0])

    def test_inherited_prefix_and_foreign_owner_never_surface(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td)/'session.jsonl'
            events = [('tool/call', NOW-20, {'name':'read', 'callId':'inherited', 'arguments':{'file_path':'old.ts'}}),
                      ('session/end-seed', NOW-19, {'inherited':True}),
                      ('tool/call', NOW-2, {'name':'read', 'callId':'fresh', 'arguments':{'file_path':'new.ts'}}),
                      ('tool/call', NOW-1, {'name':'edit', 'callId':'wrong', 'owner':'foreign-owner', 'arguments':{'file_path':'wrong.ts'}})]
            native(p, 'child', '/synthetic/project', events, 'pm', seeded=True)
            data = extract(p, {'inheritedEventCount':1})
            self.assertEqual([c['callId'] for c in data['tools']], ['fresh'])
            self.assertNotIn('old.ts', json.dumps(data))

    def test_overflow_malformed_and_stale_pending_suppress_thinking(self):
        with tempfile.TemporaryDirectory() as td:
            index, root, home = fixture(td)
            path = home/'sessions/encoded/eng-worker/session.jsonl'
            events = [('turn/start', NOW-3, {'turn':1}), ('step/start', NOW-2, {'turn':1, 'step':0})]
            native(path, 'eng-worker', root, events, 'pm-owner')
            self.assertTrue(index.build(now=NOW)['projects'][0]['actors'][1]['toolActivity']['thinking'], 'step zero is valid')
            for i in range(33):
                events.append(('tool/call', NOW-1, {'name':'bash', 'callId':'call-'+str(i), 'arguments':{'command':'SECRET'}}))
            native(path, 'eng-worker', root, events, 'pm-owner')
            value = index.build(now=NOW)['projects'][0]['actors'][1]['toolActivity']
            self.assertTrue(value['suppressed']); self.assertFalse(value['thinking']); self.assertEqual(value['calls'], [])
            events = events[:2] + [('tool/call', NOW-1, {'name':'bash', 'callId':'x'*513, 'arguments':{}})]
            native(path, 'eng-worker', root, events, 'pm-owner')
            self.assertTrue(index.build(now=NOW)['projects'][0]['actors'][1]['toolActivity']['suppressed'])
            events = [('turn/start', NOW-600, {'turn':1}), ('step/start', NOW-599, {'turn':1, 'step':'old'}),
                      ('step/end', NOW-1, {'turn':1, 'step':'different'})]
            native(path, 'eng-worker', root, events, 'pm-owner')
            self.assertFalse(index.build(now=NOW)['projects'][0]['actors'][1]['toolActivity']['thinking'])
            d = read(root); d['assignments']['eng-first']['bound_at'] = NOW-1000; atomic_write(root/'.delegate/observer/runtime.json', d)
            events = [('turn/start', NOW-700, {'turn':1}), ('tool/call', NOW-600, {'name':'bash','callId':'old-tool','arguments':{}}),
                      ('step/start', NOW-1, {'turn':1, 'step':'current'})]
            native(path, 'eng-worker', root, events, 'pm-owner')
            self.assertTrue(index.build(now=NOW)['projects'][0]['actors'][1]['toolActivity']['suppressed'])

    def test_same_session_assignment_window(self):
        with tempfile.TemporaryDirectory() as td:
            index, root, home = fixture(td)
            d = read(root)
            original = d['assignments']['eng-first']
            original.update(state='completed', updated_at=NOW-3)
            later = copy.deepcopy(original)
            later.update(assignment='eng-next', predecessor='eng-first', bound_at=NOW-.3, updated_at=NOW-.1, state='running')
            d['assignments']['eng-next'] = later
            atomic_write(root/'.delegate/observer/runtime.json', d)
            p = index.build(now=NOW)['projects'][0]
            self.assertEqual(p['actors'][1]['toolActivity']['calls'], [], 'previous assignment calls cannot leak into resumed execution')


if __name__ == '__main__':
    import sys
    if len(sys.argv) == 3 and sys.argv[1] == '--fixture':
        with tempfile.TemporaryDirectory() as td:
            index, _, _ = fixture(td, native_ids=True)
            state = index.build(now=NOW)
            Path(sys.argv[2]).write_text(json.dumps(state))
    else:
        unittest.main()
