"""Current PM lifecycle selects activity; immutable registry owner is not a cursor."""
import json
import tempfile
import unittest
from pathlib import Path

from registry import read, atomic_write
from test_tool_activity import NOW, fixture, native


class PMActivitySourceTests(unittest.TestCase):
    def save(self, home, root, sid, *, at=NOW-1, opened_at=NOW-4, activation=True, parent=None, ended=False, call=False, result=False, step=True):
        events=[]
        if activation:
            events.append(('user/message',NOW-10,{'source':{'kind':'skill-invocation','name':'shipboss','form':'instructions'}}))
        events.append(('turn/start',opened_at,{'turn':24}))
        if step: events.append(('step/start',at,{'turn':24,'step':55}))
        if call: events.append(('tool/call',at+.1,{'name':'read','callId':'same-call','arguments':{'file_path':'current.ts'}}))
        if result: events.append(('tool/result',at+.2,{'message':{'toolCallId':'same-call','isError':False}}))
        if ended: events.append(('turn/end',at+.3,{'turn':24}))
        native(home/'sessions/encoded'/sid/'session.jsonl',sid,root,events,parent)

    def end_owner(self, home, root):
        self.save(home,root,'pm-owner',at=NOW-1000,opened_at=NOW-1001,ended=True)

    def test_old_registry_owner_ended_new_pm_step_call_result_stays_same_source(self):
        with tempfile.TemporaryDirectory() as td:
            index,root,home=fixture(td);self.end_owner(home,root)
            original=(root/'.delegate/observer/runtime.json').read_bytes()
            for call,result,thinking in ((False,False,True),(True,False,False),(True,True,True)):
                self.save(home,root,'current-pm',call=call,result=result)
                p=index.build(now=NOW)['projects'][0];a=p['actors'][0];value=a['toolActivity']
                self.assertTrue(a['active']);self.assertEqual(a['motion'],'working')
                self.assertEqual(p['ownerSessionId'],'pm-owner')
                self.assertEqual(value['sessionId'],'current-pm');self.assertEqual(value['thinking'],thinking)
                if call: self.assertEqual(value['calls'][0]['state'],'ended' if result else 'started')
                self.assertEqual((root/'.delegate/observer/runtime.json').read_bytes(),original)
                self.assertEqual(p['actors'][1]['toolActivity']['sessionId'],'eng-worker','worker ownership remains registry-bound')

    def test_new_session_result_cannot_close_old_session_call_or_merge_old_summary(self):
        with tempfile.TemporaryDirectory() as td:
            index,root,home=fixture(td)
            self.save(home,root,'pm-owner',at=NOW-2,call=True)
            self.save(home,root,'current-pm',result=True)
            p=index.build(now=NOW)['projects'][0]
            self.assertEqual(p['actors'][0]['toolActivity']['sessionId'],'current-pm')
            self.assertEqual(p['actors'][0]['toolActivity']['calls'],[])
            self.assertTrue(p['actors'][0]['toolActivity']['thinking'])

    def test_stale_unactivated_child_and_foreign_project_cannot_take_over(self):
        with tempfile.TemporaryDirectory() as td:
            index,root,home=fixture(td)
            self.save(home,root,'valid-pm',at=NOW-3)
            self.save(home,root,'stale-pm',at=NOW-400,opened_at=NOW-401)
            self.save(home,root,'unactivated-pm',at=NOW-.1,activation=False)
            self.save(home,root,'child-pm',at=NOW-.1,parent='pm-owner')
            self.save(home,root/'different-project','foreign-pm',at=NOW-.1)
            p=next(p for p in index.build(now=NOW)['projects'] if p.get('ownerSessionId')=='pm-owner')
            self.assertEqual(p['actors'][0]['toolActivity']['sessionId'],'pm-owner','newer current owner lifecycle remains the representative')
            self.end_owner(home,root)
            p=next(p for p in index.build(now=NOW)['projects'] if p.get('ownerSessionId')=='pm-owner')
            self.assertEqual(p['actors'][0]['toolActivity']['sessionId'],'valid-pm')

    def test_multiple_active_order_independent_heartbeat_then_turn_start_then_sid(self):
        with tempfile.TemporaryDirectory() as td:
            index,root,home=fixture(td);self.end_owner(home,root)
            for sid,at,start in [('pm-a',NOW-2,NOW-4),('pm-b',NOW-1,NOW-5),('pm-c',NOW-1,NOW-3),('pm-z',NOW-1,NOW-3)]:
                self.save(home,root,sid,at=at,opened_at=start)
            sessions,order,warnings=index.scan()
            for reverse in (False,True):
                ordered=list(reversed(sessions)) if reverse else sessions
                index.scan=lambda:(ordered,list(order),list(warnings))
                p=index.build(now=NOW)['projects'][0]
                self.assertEqual(p['actors'][0]['toolActivity']['sessionId'],'pm-z')
            # A newer ended source cannot displace the fresh open representative.
            index.scan=lambda:(sessions,order,warnings)
            ended=next(s for s in sessions if s['header']['id']=='pm-z')
            ended['activity'].append(dict(type='turn/end',at=NOW-.1,turn=24,step=None))
            p=index.build(now=NOW)['projects'][0]
            self.assertEqual(p['actors'][0]['toolActivity']['sessionId'],'pm-c')

    def test_no_fresh_trusted_pm_source_does_not_fall_back_to_registry_or_background(self):
        with tempfile.TemporaryDirectory() as td:
            index,root,home=fixture(td);self.end_owner(home,root)
            self.save(home,root,'stale-pm',at=NOW-400,opened_at=NOW-401)
            self.save(home,root,'child-pm',at=NOW-1,parent='pm-owner')
            p=index.build(now=NOW)['projects'][0]
            self.assertEqual(p['actors'][0]['motion'],'waiting','registered background stays coarse waiting')
            self.assertNotIn('toolActivity',p['actors'][0])

    def test_pending_question_priority_survives_current_pm_selection(self):
        with tempfile.TemporaryDirectory() as td:
            index,root,home=fixture(td);self.end_owner(home,root)
            self.save(home,root,'current-pm',call=True)
            path=home/'sessions/encoded/pm-owner/session.jsonl'
            rows=[json.loads(line) for line in path.read_text().splitlines()]
            rows.append(dict(type='tool/call',seq=len(rows)-1,time=(NOW-.5)*1000,data={'name':'ask_user_question','callId':'question','arguments':{'questions':[]}}))
            path.write_text('\n'.join(json.dumps(row) for row in rows)+'\n')
            p=index.build(now=NOW)['projects'][0]
            self.assertTrue(p['awaitingUser']);self.assertEqual(p['actors'][0]['motion'],'waiting')
            self.assertEqual(p['pendingQuestion']['sessionId'],'pm-owner')
            self.assertEqual(p['actors'][0]['toolActivity']['sessionId'],'current-pm')
            self.assertFalse(p['actors'][0]['toolActivity']['thinking'])

    def test_selected_invalid_source_stays_suppressed_instead_of_falling_back(self):
        with tempfile.TemporaryDirectory() as td:
            index,root,home=fixture(td)
            self.save(home,root,'current-pm',at=NOW-.1,call=True)
            path=home/'sessions/encoded/current-pm/session.jsonl'
            rows=[json.loads(line) for line in path.read_text().splitlines()]
            rows[-1]['data']['source']=42
            path.write_text('\n'.join(json.dumps(row) for row in rows)+'\n')
            a=index.build(now=NOW)['projects'][0]['actors'][0]
            self.assertEqual(a['toolActivity']['sessionId'],'current-pm')
            self.assertTrue(a['toolActivity']['suppressed']);self.assertFalse(a['toolActivity']['thinking'])


if __name__=='__main__':
    unittest.main()
