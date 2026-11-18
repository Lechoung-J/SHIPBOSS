"""Bounded opaque native call IDs, including real DSH 83/91-char pipe shapes."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from discovery import DiscoveryIndex, extract
from registry import read, atomic_write
from test_tool_activity import NOW, fixture, native
from tool_activity import native_call_id, valid_id, HASH_PREFIX

ID83 = 'call_' + 'a'*74 + '|end'  # 83 ASCII characters
ID91 = 'call_' + 'b'*82 + '|end'  # 91 ASCII characters


class NativeCallIdTests(unittest.TestCase):
    def test_opaque_mapping_bounds_namespace_and_session_scope(self):
        self.assertEqual((len(ID83),len(ID91)),(83,91))
        for value in (ID83,ID91,'x'*81,'x'*512,'call|short'):
            wire = native_call_id(value,'worker')
            self.assertTrue(valid_id(wire))
            self.assertTrue(wire.startswith(HASH_PREFIX))
            self.assertEqual(wire,native_call_id(value,'worker'))
            self.assertNotEqual(wire,native_call_id(value,'other-worker'))
            self.assertNotEqual(wire,native_call_id(wire,'worker'),'reserved namespace cannot alias raw simple ID')
        for value in ('simple-id','a'*80):
            self.assertEqual(native_call_id(value,'worker'),value)
        self.assertNotEqual(native_call_id('a'*82+'|A','worker'),native_call_id('a'*82+'|B','worker'))
        for value in (None,42,False,[],{},'', 'x'*513,'bad\n','bad\t','bad\x00','bad\x7f','has space','非ASCII'):
            self.assertIsNone(native_call_id(value,'worker'),repr(value))

    def test_native_call_result_replay_out_of_order_and_parallel(self):
        with tempfile.TemporaryDirectory() as td:
            index,root,home=fixture(td)
            path=home/'sessions/encoded/eng-worker/session.jsonl'
            events=[('tool/result',NOW-.2,{'message':{'toolCallId':ID83,'isError':True}}),
                    ('tool/call',NOW-2,{'name':'read','callId':ID83,'arguments':{'file_path':'app.ts'}}),
                    ('tool/call',NOW-1,{'name':'edit','callId':ID91,'arguments':{'file_path':'app.ts'}})]
            events += [events[1],events[2]]
            native(path,'eng-worker',root,events,'pm-owner')
            metadata=extract(path,{})
            self.assertFalse(metadata['toolOverflow'])
            for _ in range(2):
                project=index.build(now=NOW)['projects'][0]
                actor=project['actors'][1]
                self.assertEqual(actor['toolActivity']['runningCount'],1)
                states={c['callId']:c['state'] for c in actor['toolActivity']['calls']}
                self.assertEqual(states,{native_call_id(ID83,'eng-worker'):'error',native_call_id(ID91,'eng-worker'):'started'})
                self.assertTrue(all(t['verdict'] is None for t in project['tasks']))
                self.assertNotIn(ID83,json.dumps(index.data)+json.dumps(project))
                self.assertNotIn(ID91,json.dumps(index.data)+json.dumps(project))
            events.append(('tool/result',NOW-.1,{'message':{'toolCallId':ID91,'isError':False}}))
            native(path,'eng-worker',root,events,'pm-owner')
            value=index.build(now=NOW)['projects'][0]['actors'][1]['toolActivity']
            self.assertEqual(value['runningCount'],0)
            self.assertEqual({c['state'] for c in value['calls']},{'ended','error'})

    def test_same_prefix_distinct_suffix_and_half_open_assignment_boundary(self):
        with tempfile.TemporaryDirectory() as td:
            index,root,home=fixture(td)
            registry=read(root); old=registry['assignments']['eng-first']; new=copy.deepcopy(old)
            new.update(assignment='second',slot='eng-b',task='task-2',bound_at=NOW-1,updated_at=NOW-.1)
            registry['assignments']['second']=new
            atomic_write(root/'.delegate/observer/runtime.json',registry)
            raw_old='same_'+ 'z'*76+'|A'
            raw_new='same_'+ 'z'*76+'|B'
            events=[('tool/call',NOW-1-.001,{'name':'read','callId':raw_old,'arguments':{'file_path':'old.ts'}}),
                    ('tool/call',NOW-1,{'name':'edit','callId':raw_new,'arguments':{'file_path':'new.ts'}}),
                    ('tool/result',NOW-.1,{'message':{'toolCallId':raw_old,'isError':False}})]
            native(home/'sessions/encoded/eng-worker/session.jsonl','eng-worker',root,events,'pm-owner')
            project=index.build(now=NOW)['projects'][0]
            self.assertEqual([(c['callId'],c['state']) for c in project['actors'][1]['toolActivity']['calls']],[(native_call_id(raw_old,'eng-worker'),'ended')])
            self.assertEqual([(c['callId'],c['state']) for c in project['actors'][2]['toolActivity']['calls']],[(native_call_id(raw_new,'eng-worker'),'started')])

    def test_long_skill_and_question_pairing_preserves_existing_logic(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'session.jsonl'
            events=[('tool/call',NOW-4,{'name':'skill','callId':ID83,'arguments':{'name':'shipboss'}}),
                    ('tool/result',NOW-3,{'message':{'toolCallId':ID83,'isError':False}}),
                    ('tool/call',NOW-2,{'name':'ask_user_question','callId':ID91,'arguments':{'questions':[]}})]
            native(path,'worker','/synthetic/project',events)
            value=extract(path,{})
            self.assertEqual(value['usages'][0]['name'],'shipboss')
            self.assertEqual(value['questions'][0]['id'],native_call_id(ID91,'worker'))
            events.append(('tool/result',NOW-1,{'message':{'toolCallId':ID91,'isError':False}}))
            native(path,'worker','/synthetic/project',events)
            self.assertEqual(extract(path,{})['questions'],[])

    def test_invalid_raw_input_remains_bounded_and_strict_foreign_source_survives(self):
        for value in (None,42,'x'*513,'bad\n'):
            for kind in ('tool/call','tool/result'):
                with self.subTest(valueType=type(value).__name__,kind=kind), tempfile.TemporaryDirectory() as td:
                    path=Path(td)/'session.jsonl'
                    body=({'name':'read','callId':value,'arguments':{'file_path':'app.ts'}} if kind=='tool/call' else
                          {'message':{'toolCallId':value,'isError':False}})
                    native(path,'worker','/synthetic/project',[(kind,NOW-1,body)])
                    self.assertTrue(extract(path,{})['toolOverflow'])
        with tempfile.TemporaryDirectory() as td:
            index,root,home=fixture(td)
            events=[('turn/start',NOW-3,{'turn':1}),('step/start',NOW-2,{'turn':1,'step':1}),
                    ('tool/call',NOW-1,{'source':42,'name':'read','callId':ID91,'arguments':{'file_path':'app.ts'}})]
            native(home/'sessions/encoded/eng-worker/session.jsonl','eng-worker',root,events,'pm-owner')
            value=index.build(now=NOW)['projects'][0]['actors'][1]['toolActivity']
            self.assertTrue(value['suppressed']);self.assertFalse(value['thinking']);self.assertEqual(value['calls'],[])

    def test_v2_suppressed_cache_reparses_native_ids_without_room_order_reset(self):
        with tempfile.TemporaryDirectory() as td:
            index,root,home=fixture(td)
            path=home/'sessions/encoded/eng-worker/session.jsonl'
            native(path,'eng-worker',root,[('tool/call',NOW-1,{'name':'read','callId':ID91,'arguments':{'file_path':'app.ts'}})],'pm-owner')
            index.build(now=NOW);order=list(index.data['order'])
            key=str(path.relative_to(home));entry=index.data['files'][key]
            entry['signature'][-1]='activity-v2-half-open-strict-source'
            entry['metadata'].update(tools=[],toolOverflow=True)
            atomic_write(index.path,index.data)
            upgraded=DiscoveryIndex(home,index.path)
            value=upgraded.build(now=NOW)['projects'][0]['actors'][1]['toolActivity']
            self.assertFalse(value.get('suppressed',False));self.assertEqual(value['runningCount'],1)
            self.assertEqual(value['calls'][0]['callId'],native_call_id(ID91,'eng-worker'))
            self.assertGreater(upgraded.loads,0);self.assertEqual(upgraded.data['order'],order)


if __name__=='__main__':
    unittest.main()
