"""Receipt-only official Codex/Claude journal schemas, not paid model runs."""
from datetime import datetime,timezone
import json
from pathlib import Path
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

from discovery import DiscoveryIndex
from external_journal import OfficialJournalReader,source_key
from onboarding import queue_external_activation,record_external_activation
from registry import read,activate


def iso(at):return datetime.fromtimestamp(at,timezone.utc).isoformat().replace('+00:00','Z')


def save(path,rows):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(''.join(json.dumps(row)+'\n' for row in rows))


def codex_path(home,sid):return home/'.codex/sessions/2026/11/16'/('rollout-2026-11-16T21-37-41-'+sid+'.jsonl')


def codex_rows(root,sid,at,*,source='exec',origin='codex_exec',ended=False):
    turn=str(uuid.uuid4())
    rows=[dict(type='session_meta',timestamp=iso(at-20),payload=dict(id=sid,session_id=sid,cwd=str(root),source=source,originator=origin,thread_source='user',base_instructions='SECRET_PROMPT')),
          dict(type='event_msg',timestamp=iso(at-10),payload=dict(type='task_started',turn_id=turn,started_at=int(at-10))),
          dict(type='turn_context',timestamp=iso(at-10),payload=dict(cwd=str(root),turn_id=turn)),
          dict(type='response_item',timestamp=iso(at-1),payload=dict(type='function_call',name='exec_command',call_id='call|'+('a'*90),arguments=json.dumps({'cmd':'SECRET_COMMAND','workdir':str(root)})))]
    if ended:
        rows += [dict(type='response_item',timestamp=iso(at-.5),payload=dict(type='function_call_output',call_id='call|'+('a'*90),output='SECRET_RESULT')),
                 dict(type='event_msg',timestamp=iso(at-.1),payload=dict(type='task_complete',turn_id=turn,completed_at=int(at-.1),last_agent_message='SECRET_FINAL'))]
    return rows


def claude_path(home,root,sid):
    import re
    return home/'.claude/projects'/re.sub(r'[^A-Za-z0-9]','-',str(root))/(sid+'.jsonl')


def claude_rows(root,sid,at,*,ended=False):
    def row(kind,when,message):return dict(type=kind,sessionId=sid,cwd=str(root),isSidechain=False,uuid=str(uuid.uuid4()),timestamp=iso(when),message=message)
    rows=[row('user',at-10,{'role':'user','content':'SECRET_PROMPT'}),
          row('assistant',at-1,{'role':'assistant','stop_reason':'tool_use','content':[{'type':'thinking','thinking':'SECRET_REASONING'},{'type':'tool_use','id':'toolu|opaque','name':'Read','input':{'file_path':'src/app.ts','extra':'SECRET_EXTRA'}}]})]
    if ended:
        rows += [row('user',at-.5,{'role':'user','content':[{'type':'tool_result','tool_use_id':'toolu|opaque','is_error':True,'content':'SECRET_RESULT'}]}),
                 row('assistant',at-.1,{'role':'assistant','stop_reason':'end_turn','content':[{'type':'text','text':'SECRET_FINAL'}]})]
    return rows


class ExternalJournalTests(unittest.TestCase):
    def setup_case(self,td,harness='codex'):
        home=Path(td).resolve();root=home/'repo';root.mkdir();sid=str(uuid.uuid4());now=time.time()
        receipts=home/'service/activation-receipts'
        r=queue_external_activation(root,harness,sid,sid,receipts)
        path=codex_path(home,sid) if harness=='codex' else claude_path(home,root,sid)
        return home,root,sid,now,receipts,r,path

    def test_codex_real_schema_start_tool_result_complete_and_desktop_source(self):
        for source,origin in [('exec','codex_exec'),('vscode','Codex Desktop')]:
            with self.subTest(source=source),tempfile.TemporaryDirectory() as td:
                home,root,sid,now,directory,r,path=self.setup_case(td)
                rows=codex_rows(root,sid,now,source=source,origin=origin);save(path,rows)
                index=DiscoveryIndex(home/'no-dsh',home/'index.json',activation_receipts=directory)
                with patch('external_journal.Path.home',return_value=home):
                    p=index.build(now=now+.1)['projects'][0]
                self.assertTrue(p['actors'][0]['active']);self.assertEqual(p['actors'][0]['motion'],'working')
                self.assertEqual(p['actors'][0]['toolActivity']['runningCount'],1)
                self.assertEqual(p['actors'][0]['toolActivity']['calls'][0]['category'],'command')
                self.assertFalse(p['actors'][0]['toolActivity']['thinking'],'no speculative thinking')
                original=(root/'.delegate/observer/runtime.json').read_bytes()
                full=codex_rows(root,sid,now,source=source,origin=origin,ended=True)
                # Preserve exact original turn and append only its result/end.
                full[-1]['payload']['turn_id']=rows[1]['payload']['turn_id']
                with path.open('a') as stream:
                    for row in full[-2:]:stream.write(json.dumps(row)+'\n')
                with patch('external_journal.Path.home',return_value=home):p=index.build(now=now+.2)['projects'][0]
                self.assertFalse(p['actors'][0]['active']);self.assertEqual(p['actors'][0]['motion'],'idle');self.assertNotEqual(p['status'],'done')
                self.assertEqual((root/'.delegate/observer/runtime.json').read_bytes(),original)
                self.assertNotIn('SECRET',index.path.read_text())
                metadata=next(iter(index.data['externalJournals'].values()))
                self.assertEqual(metadata['state']['results'][next(iter(metadata['state']['results']))]['state'],'ended')

    def test_claude_primary_tool_use_result_end_turn_and_nonterminal_chunk(self):
        with tempfile.TemporaryDirectory() as td:
            home,root,sid,now,directory,r,path=self.setup_case(td,'claude');rows=claude_rows(root,sid,now);save(path,rows)
            reader=OfficialJournalReader(home=home)
            value,error=reader.read(r,now=now);self.assertIsNone(error)
            self.assertEqual(value['tools'][0]['category'],'read');self.assertEqual(value['tools'][0]['target'],'app.ts')
            self.assertEqual(value['activity'][-1]['type'],'tool','tool_use stop is not end_turn')
            with path.open('a') as f:
                for row in claude_rows(root,sid,now,ended=True)[-2:]:f.write(json.dumps(row)+'\n')
            value,error=reader.read(r,now=now)
            self.assertIsNone(error);self.assertEqual(value['tools'][0]['state'],'error');self.assertEqual(value['activity'][-1]['type'],'turn/end')
            self.assertNotIn('SECRET',json.dumps(reader.cache))
            with patch('external_journal.Path.home',return_value=home):p=DiscoveryIndex(home/'empty',home/'index',activation_receipts=directory).build(now=now+.1)['projects'][0]
            self.assertFalse(p['actors'][0]['active']);self.assertNotEqual(p['status'],'done')

    def test_queue_writes_only_service_metadata_and_verified_firstload_show(self):
        with tempfile.TemporaryDirectory() as td:
            home,root,sid,now,directory,r,path=self.setup_case(td)
            self.assertFalse((root/'.delegate').exists())
            again=queue_external_activation(root,'codex',sid,sid,directory)
            self.assertEqual(again['showRequestId'],r['receiptId']);self.assertEqual(again['activatedAt'],r['activatedAt'])
            explicit=queue_external_activation(root,'codex',sid,sid,directory,action='show')
            self.assertNotEqual(explicit['showRequestId'],r['receiptId'])
            index=DiscoveryIndex(home/'empty',home/'index.json',activation_receipts=directory)
            with patch('external_journal.Path.home',return_value=home):missing=index.build(now=now+.1)
            self.assertFalse(missing['projects'][0]['actors'][0]['active']);self.assertEqual(missing['presentation']['requests'],[]);self.assertFalse((root/'.delegate').exists())
            save(path,codex_rows(root,sid,now))
            with patch('external_journal.Path.home',return_value=home):verified=index.build(now=now+.1)
            self.assertTrue(verified['projects'][0]['actors'][0]['active']);self.assertEqual(read(root)['owner_session'],sid)
            self.assertEqual(verified['presentation']['requests'],[dict(id=explicit['showRequestId'],at=explicit['showRequestedAt'],action='show')])
            with patch('external_journal.Path.home',return_value=home):stale=index.build(now=now+1000)
            self.assertFalse(stale['projects'][0]['actors'][0]['active']);self.assertEqual(stale['presentation']['requests'],[])

    def test_no_receipt_no_lookup_and_other_sessions_never_opened(self):
        with tempfile.TemporaryDirectory() as td:
            home=Path(td).resolve();index=DiscoveryIndex(home/'dsh',home/'index.json')
            with patch('external_journal.locate',side_effect=AssertionError('must not discover personal journals')):
                self.assertEqual(index.build()['projects'],[])
            home,root,sid,now,directory,r,path=self.setup_case(td)
            other=codex_path(home,str(uuid.uuid4()));save(other,[{'this':'not a journal to inspect'}]);save(path,codex_rows(root,sid,now))
            reader=OfficialJournalReader(home=home);original=Path.open;opened=[]
            def guard(p,*args,**kwargs):
                if p==other:raise AssertionError('unrelated journal opened')
                opened.append(str(p));return original(p,*args,**kwargs)
            with patch.object(Path,'open',guard):value,error=reader.read(r,now=now)
            self.assertIsNone(error);self.assertIsNotNone(value)

    def test_wrong_root_session_sidechain_and_codex_subagent_never_activate(self):
        cases=['cwd','session','sidechain','source','parent']
        for harness in ('codex','claude'):
            for case in cases:
                if harness=='claude' and case in ('source','parent'):continue
                if harness=='codex' and case=='sidechain':continue
                with self.subTest(harness=harness,case=case),tempfile.TemporaryDirectory() as td:
                    home,root,sid,now,directory,r,path=self.setup_case(td,harness)
                    rows=codex_rows(root,sid,now) if harness=='codex' else claude_rows(root,sid,now)
                    if harness=='codex':
                        p=rows[0]['payload']
                        if case=='cwd':p['cwd']=str(root/'foreign')
                        elif case=='session':p['id']=str(uuid.uuid4())
                        elif case=='source':p['source']={'subagent':{'parent_thread_id':str(uuid.uuid4())}}
                        else:p['parent_thread_id']=str(uuid.uuid4())
                    else:
                        for row in rows:
                            if case=='cwd':row['cwd']=str(root/'foreign')
                            elif case=='session':row['sessionId']=str(uuid.uuid4())
                            else:row['isSidechain']=True
                    save(path,rows)
                    with patch('external_journal.Path.home',return_value=home):state=DiscoveryIndex(home/'empty',home/'index',activation_receipts=directory).build(now=now+.1)
                    self.assertFalse(state['projects'][0]['actors'][0]['active']);self.assertEqual(state['presentation']['requests'],[])
                    self.assertFalse((root/'.delegate').exists())

    def test_same_root_same_uuid_cross_harness_tools_are_not_mixed_and_owner_immutable(self):
        with tempfile.TemporaryDirectory() as td:
            home,root,sid,now,directory,r,path=self.setup_case(td)
            original_owner=str(uuid.uuid4());record_external_activation(root,'codex',original_owner,'original-context',directory)
            before=(root/'.delegate/observer/runtime.json').read_bytes()
            queue_external_activation(root,'claude',sid,'claude-context',directory)
            save(path,codex_rows(root,sid,now-1));save(claude_path(home,root,sid),claude_rows(root,sid,now))
            index=DiscoveryIndex(home/'empty',home/'index',activation_receipts=directory)
            with patch('external_journal.Path.home',return_value=home):p=index.build(now=now+.1)['projects'][0]
            value=p['actors'][0]['toolActivity'];self.assertEqual(value['calls'][0]['category'],'read');self.assertEqual(len(value['calls']),1)
            self.assertTrue(value['sessionId'].startswith('external-claude-'))
            self.assertEqual((root/'.delegate/observer/runtime.json').read_bytes(),before);self.assertEqual(p['ownerSessionId'],original_owner)
            self.assertTrue(all(not a['active'] for a in p['actors'][1:]))
            keys=list(index.data['externalJournals']);self.assertEqual(len(keys),2);self.assertNotEqual(*keys)

    def test_append_checkpoint_corrupt_replace_partial_line_and_budget(self):
        with tempfile.TemporaryDirectory() as td:
            home,root,sid,now,directory,r,path=self.setup_case(td);rows=codex_rows(root,sid,now);save(path,rows)
            reader=OfficialJournalReader(home=home);value,error=reader.read(r,now=now);self.assertIsNone(error)
            offset=reader.cache[source_key(r)]['offset']
            with path.open('ab') as f:f.write(b'{incomplete')
            self.assertEqual(reader.read(r,now=now)[1],'journal-scan-pending');self.assertEqual(reader.cache[source_key(r)]['offset'],offset)
            with path.open('ab') as f:f.write(b'}\n')
            self.assertEqual(reader.read(r,now=now)[1],'journal-invalid')
            other=path.with_name('replace');save(other,codex_rows(root,str(uuid.uuid4()),now));other.replace(path)
            self.assertEqual(reader.read(r,now=now)[1],'journal-identity-invalid')
            save(path,rows)
            with patch('external_journal.MAX_TICK',len(json.dumps(rows[0]))+30):self.assertEqual(reader.read(r,now=now)[1],'journal-scan-pending')
            value,error=reader.read(r,now=now);self.assertIsNone(error);self.assertEqual(len(value['tools']),1)
            self.assertNotIn('SECRET',json.dumps(reader.cache))

    def test_many_tool_events_keep_open_lifecycle_and_desktop_foreign_turn_filtered(self):
        with tempfile.TemporaryDirectory() as td:
            home,root,sid,now,directory,r,path=self.setup_case(td);rows=codex_rows(root,sid,now,source='vscode',origin='arbitrary-origin-label')
            turn=rows[1]['payload']['turn_id']
            for n in range(40):
                at=now-.9+n*.01
                rows += [dict(type='response_item',timestamp=iso(at),payload=dict(type='function_call',name='read_file',call_id='i-'+str(n),arguments=json.dumps({'file_path':'app.ts'}))),dict(type='response_item',timestamp=iso(at+.001),payload=dict(type='function_call_output',call_id='i-'+str(n),output='SECRET'))]
            save(path,rows);reader=OfficialJournalReader(home=home);value,error=reader.read(r,now=now)
            self.assertIsNone(error);self.assertEqual(value['activity'][0]['type'],'turn/start');self.assertLessEqual(len(value['activity']),32)
            self.assertEqual(value['header']['source'],'official-codex-journal','origin text does not grant or veto identity')
            bad=codex_rows(root,sid,now,source='vscode');bad[1]['payload']['root_turn_id']='foreign-turn';save(path,bad)
            value,error=OfficialJournalReader(home=home).read(r,now=now);self.assertIsNone(value);self.assertEqual(error,'journal-identity-invalid')

    def test_symlinked_journal_and_ambiguous_codex_uuid_are_not_trusted(self):
        with tempfile.TemporaryDirectory() as td:
            home,root,sid,now,directory,r,path=self.setup_case(td);rows=codex_rows(root,sid,now);save(path,rows)
            duplicate=path.parent/('rollout-another-'+sid+'.jsonl');save(duplicate,rows)
            with self.assertRaises(ValueError):OfficialJournalReader(home=home).read(r,now=now)
            duplicate.unlink();saved=path.with_name('actual');path.rename(saved);path.symlink_to(saved)
            value,error=OfficialJournalReader(home=home).read(r,now=now);self.assertIsNone(value);self.assertEqual(error,'journal-missing')


if __name__=='__main__':unittest.main()
