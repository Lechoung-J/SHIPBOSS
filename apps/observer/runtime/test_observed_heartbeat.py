import unittest
import tempfile
from registry import read,atomic_write
from test_tool_activity import fixture,native,NOW


class ObservedHeartbeatTests(unittest.TestCase):
    def test_fresh_exact_worker_step_extends_expired_observation_without_writing_registry(self):
        with tempfile.TemporaryDirectory() as td:
            index,root,home=fixture(td);d=read(root);r=d['assignments']['eng-first'];r.update(bound_at=NOW-3000,updated_at=NOW-2000)
            atomic_write(root/'.delegate/observer/runtime.json',d);original=(root/'.delegate/observer/runtime.json').read_bytes()
            native(home/'sessions/encoded/eng-worker/session.jsonl','eng-worker',root,[('turn/start',NOW-100,{'turn':1}),('step/start',NOW-1,{'turn':1,'step':1})],'pm-owner')
            actor=index.build(now=NOW)['projects'][0]['actors'][1]
            self.assertTrue(actor['active']);self.assertFalse(actor['uncertain']);self.assertTrue(actor['toolActivity']['thinking'])
            self.assertEqual((root/'.delegate/observer/runtime.json').read_bytes(),original)
            actor=index.build(now=NOW+1000)['projects'][0]['actors'][1]
            self.assertFalse(actor['active']);self.assertTrue(actor['uncertain'],'true disconnection still expires')

    def test_terminal_and_foreign_session_never_extend_worker(self):
        with tempfile.TemporaryDirectory() as td:
            index,root,home=fixture(td);d=read(root);r=d['assignments']['eng-first'];r.update(bound_at=NOW-3000,updated_at=NOW-2000)
            atomic_write(root/'.delegate/observer/runtime.json',d)
            native(home/'sessions/encoded/eng-worker/session.jsonl','eng-worker',root,[('turn/start',NOW-10,{'turn':1}),('step/start',NOW-1,{'turn':1,'step':1,'source':{'sessionId':'foreign'}})],'pm-owner')
            self.assertTrue(index.build(now=NOW)['projects'][0]['actors'][1]['uncertain'])
            r.update(state='completed');atomic_write(root/'.delegate/observer/runtime.json',d)
            native(home/'sessions/encoded/eng-worker/session.jsonl','eng-worker',root,[('turn/start',NOW-10,{'turn':1}),('step/start',NOW-1,{'turn':1,'step':1})],'pm-owner')
            self.assertFalse(index.build(now=NOW)['projects'][0]['actors'][1]['active'])


if __name__=='__main__':unittest.main()
