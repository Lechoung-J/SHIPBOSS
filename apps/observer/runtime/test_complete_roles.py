import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

from registry import activate,bind,update,read,atomic_write
from discovery import DiscoveryIndex
from test_tool_activity import fixture,native,NOW
from dispatch import register,launch
from onboarding import record_external_activation


class CompleteRoleTests(unittest.TestCase):
    def test_recording_native_tool_and_thinking_share_lifecycle(self):
        with tempfile.TemporaryDirectory() as td:
            index,root,home=fixture(td)
            bind(root,assignment='scribe',task='notes',role='recording',slot='recording',policy='new',context_id='scribe-context',session_id='scribe-session',agent_id='scribe-agent')
            update(root,'scribe',state='running',phase='thinking')
            d=read(root);d['assignments']['scribe'].update(bound_at=NOW-10,updated_at=NOW-1);atomic_write(root/'.delegate/observer/runtime.json',d)
            path=home/'sessions/encoded/scribe-session/session.jsonl'
            events=[('turn/start',NOW-4,{'turn':1}),('step/start',NOW-3,{'turn':1,'step':1}),('tool/call',NOW-2,{'name':'read','callId':'scribe-call','arguments':{'file_path':'notes.md'}})]
            native(path,'scribe-session',root,events,'pm-owner')
            p=index.build(now=NOW)['projects'][0];a=p['recordingActor']
            self.assertTrue(p['recording']);self.assertEqual(a['id'],'recording');self.assertEqual(len(p['actors']),4)
            self.assertEqual(a['toolActivity']['calls'][0]['target'],'notes.md');self.assertFalse(a['toolActivity']['thinking'])
            events.append(('tool/result',NOW-1,{'message':{'toolCallId':'scribe-call','isError':False}}));native(path,'scribe-session',root,events,'pm-owner')
            self.assertTrue(index.build(now=NOW)['projects'][0]['recordingActor']['toolActivity']['thinking'])
            d['assignments']['scribe'].update(state='blocked');atomic_write(root/'.delegate/observer/runtime.json',d)
            p=index.build(now=NOW)['projects'][0];self.assertTrue(p['recordingUncertain']);self.assertNotIn('toolActivity',p['recordingActor'])

    def test_register_atomic_running_uuid_validation_and_receipt(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve();activate(root,'owner','context')
            args=dict(assignment='engineer',task='task',role='engineer',slot='eng-a',policy='new',context_id='ctx',session_id=str(uuid.uuid4()),agent_id='actual-agent')
            value=register(root,'owner',**args)
            self.assertEqual(value['state'],'running');self.assertIsNone(value['verdict']);self.assertTrue(value['launchId'])
            self.assertEqual(read(root)['dispatch_receipts'][-1],value)
            for owner,patch in [('other',{}),('owner',{'assignment':'bad','session_id':'agent-label','slot':'eng-b'})]:
                with self.assertRaises(ValueError): register(root,owner,**{**args,**patch})

    def test_launch_zero_and_failure_do_not_sign_verdict(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve();activate(root,'owner','context')
            args=dict(assignment='check',task='task',role='verifier',slot='verifier',policy='fresh',context_id='new-context',session_id=str(uuid.uuid4()),revision='source-hash')
            self.assertEqual(launch(root,'owner',[sys.executable,'-c','pass'],**args),0)
            r=read(root)['assignments']['check'];self.assertEqual(r['state'],'completed');self.assertIsNone(r['verdict'])
            self.assertEqual(read(root)['dispatch_receipts'][-1]['action'],'finished')
            args.update(assignment='check2',context_id='fresh-again',session_id=str(uuid.uuid4()))
            self.assertEqual(launch(root,'owner',['/missing-executable'],**args),127)
            self.assertEqual(read(root)['assignments']['check2']['state'],'failed')

    def test_new_external_project_firstload_then_three_registered_cli_roles(self):
        from cli_stream import StreamAdapter
        with tempfile.TemporaryDirectory() as td:
            base=Path(td).resolve();root=base/'brand-new';root.mkdir();sid=str(uuid.uuid4());directory=base/'service/activation-receipts'
            first=record_external_activation(root,'codex',sid,sid,directory)
            self.assertEqual(first['registryOwnerSessionId'],sid)
            for slot,role,policy in [('eng-a','engineer','new'),('verifier','verifier','fresh'),('recording','recording','new')]:
                register(root,sid,assignment='launch-'+slot,task='task-'+slot,role=role,slot=slot,policy=policy,context_id=str(uuid.uuid4()),session_id=str(uuid.uuid4()),job_id='job-'+slot,source='codex',revision='exact-input' if role=='verifier' else None)
                adapter=StreamAdapter(root,'launch-'+slot,'codex')
                adapter.feed({'type':'item.started','item':{'id':'same-item','type':'file_change','changes':[{'path':'src/app.ts','kind':'update'}]}})
            payload=DiscoveryIndex(base/'no-native-home',base/'index.json',activation_receipts=directory).build()
            project=payload['projects'][0]
            for actor in (project['actors'][1],project['actors'][3],project['recordingActor']):
                self.assertTrue(actor['active']);self.assertEqual(actor['toolActivity']['calls'][0]['category'],'edit')
                self.assertFalse(actor['toolActivity']['thinking'])
            self.assertFalse(project['actors'][0]['active'],'declared Skill load is not a running PM turn')
            self.assertTrue(all(t['verdict'] is None for t in project['tasks']))

    def test_new_projects_append_by_success_time_not_alphabetical_cwd(self):
        with tempfile.TemporaryDirectory() as td:
            base=Path(td).resolve();home=base/'home'
            native(home/'sessions/encoded/z/session.jsonl','z','/synthetic/z-first', [('user/message',NOW-5,{'source':{'kind':'skill-invocation','name':'shipboss','form':'instructions'}})])
            native(home/'sessions/encoded/a/session.jsonl','a','/synthetic/a-later', [('user/message',NOW-1,{'source':{'kind':'skill-invocation','name':'shipboss','form':'instructions'}})])
            index=DiscoveryIndex(home,base/'index.json');index.build(now=NOW)
            self.assertEqual(index.data['order'],['/synthetic/z-first','/synthetic/a-later'])
            native(home/'sessions/encoded/b/session.jsonl','b','/synthetic/b-discovered-next', [('user/message',NOW-100,{'source':{'kind':'skill-invocation','name':'shipboss','form':'instructions'}})])
            index.build(now=NOW)
            self.assertEqual(index.data['order'],['/synthetic/z-first','/synthetic/a-later','/synthetic/b-discovered-next'])

    def test_external_declared_activation_only_from_owned_receipt(self):
        with tempfile.TemporaryDirectory() as td:
            base=Path(td).resolve();home=base/'dsh';sid=str(uuid.uuid4());project=base/'external';project.mkdir()
            directory=base/'service/activation-receipts'
            r=record_external_activation(project,'codex',sid,sid,directory)
            self.assertEqual(r['source'],'external-declared')
            p=DiscoveryIndex(home,base/'index.json',activation_receipts=directory).build()['projects'][0]
            self.assertEqual(p['name'],'external');self.assertFalse(p['actors'][0]['active']);self.assertNotIn('toolActivity',p['actors'][0])
            self.assertEqual(read(project)['owner_session'],sid)
            original=read(project)['owner_session'];other=str(uuid.uuid4())
            again=record_external_activation(project,'claude',other,other,directory)
            self.assertEqual(again['registryOwnerSessionId'],original);self.assertEqual(read(project)['owner_session'],original)
            with self.assertRaises(ValueError): record_external_activation(project,'unknown',sid,sid,directory)
            with self.assertRaises(ValueError): record_external_activation(project,'codex','label',sid,directory)


if __name__=='__main__':unittest.main()
