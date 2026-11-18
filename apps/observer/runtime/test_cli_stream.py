"""Protocol-shape fixtures + executable wrapper stubs, not paid model runs.

Codex exec JSONL 0.144.1 item events; Claude 2.1.251 stream-json SDK
assistant/user/stream_event envelopes. Versioned event shapes are synthetic fixtures.
"""
import contextlib
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

from registry import activate,read,update
from dispatch import register,launch
from cli_stream import StreamAdapter,load_activity
from observer_state import build_project


class CLIStreamTests(unittest.TestCase):
    def setup_launch(self,root,source):
        activate(root,'owner','ctx')
        register(root,'owner',assignment='worker',task='task',role='engineer',slot='eng-a',policy='new',context_id='fresh',session_id=str(uuid.uuid4()),job_id='actual-job',source=source)
        return StreamAdapter(root,'worker',source)

    def test_codex_actual_item_shapes_metadata_only_and_order(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve();a=self.setup_launch(root,'codex')
            rows=[{'type':'thread.started','thread_id':str(uuid.uuid4())},
                  {'type':'item.started','item':{'id':'cmd','type':'command_execution','command':'SECRET_COMMAND','status':'in_progress'}},
                  {'type':'item.started','item':{'id':'edit','type':'file_change','changes':[{'path':'src/app.ts','kind':'update'}]}},
                  {'type':'item.completed','item':{'id':'cmd','type':'command_execution','command':'SECRET_COMMAND','aggregated_output':'SECRET_RESULT','exit_code':1,'status':'completed'}},
                  {'type':'item.completed','item':{'id':'reasoning','type':'reasoning','text':'SECRET_THINKING'}}]
            for row in rows+rows[1:]:a.feed(row)
            d=read(root);value=load_activity(root,d,d['assignments']['worker'],now=time.time())
            self.assertEqual(value['runningCount'],1);self.assertEqual({c['state'] for c in value['calls']},{'started','error'})
            self.assertEqual({c['category'] for c in value['calls']},{'edit','command'});self.assertFalse(value['thinking'])
            metadata=json.loads(a.path.read_text())
            self.assertEqual(metadata['transport']['transportSessionId'],rows[0]['thread_id'])
            self.assertEqual(metadata['transport']['hostSessionId'],d['assignments']['worker']['session_id'])
            self.assertNotEqual(metadata['transport']['hostSessionId'],metadata['transport']['transportSessionId'])
            self.assertEqual(metadata['transport']['launchId'],d['assignments']['worker']['launch_id'])
            self.assertNotIn('SECRET',a.path.read_text())
            p=build_project(root);self.assertEqual(p['actors'][1]['toolActivity']['runningCount'],1)

    def test_claude_partial_tool_and_full_tool_result_and_child_exclusion(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve();a=self.setup_launch(root,'claude');sid=str(uuid.uuid4())
            rows=[{'type':'system','subtype':'init','session_id':sid},
                  {'type':'stream_event','session_id':sid,'event':{'type':'content_block_start','index':0,'content_block':{'type':'tool_use','id':'toolu_01','name':'Read','input':{}}}},
                  {'type':'assistant','session_id':sid,'parent_tool_use_id':None,'message':{'role':'assistant','content':[{'type':'tool_use','id':'toolu_01','name':'Read','input':{'file_path':'src/app.ts'}}]}},
                  {'type':'stream_event','session_id':sid,'event':{'type':'content_block_delta','delta':{'type':'thinking_delta','thinking':'SECRET_THINKING'}}},
                  {'type':'assistant','session_id':sid,'parent_tool_use_id':'child','message':{'content':[{'type':'tool_use','id':'child','name':'Bash','input':{'command':'SECRET_CHILD'}}]}},
                  {'type':'user','session_id':sid,'message':{'role':'user','content':[{'type':'tool_result','tool_use_id':'toolu_01','content':'SECRET_RESULT','is_error':False}]}}]
            for r in rows:a.feed(r)
            value=json.loads(a.path.read_text());self.assertEqual(len(value['calls']),1);self.assertEqual(value['calls'][0]['state'],'ended')
            self.assertEqual(value['calls'][0]['category'],'read');self.assertNotIn('SECRET',a.path.read_text());self.assertFalse(value['thinking'])

    def test_source_identity_and_launch_scope_cannot_merge_and_terminal_not_revived(self):
        outputs=[]
        for source in ('codex','claude'):
            with tempfile.TemporaryDirectory() as td:
                root=Path(td).resolve();a=self.setup_launch(root,source);a.tool('same-id','read');a.persist()
                outputs.append(json.loads(a.path.read_text())['calls'][0]['callId'])
                d=read(root);d['assignments']['worker']['launch_id']='other-launch'
                self.assertIsNone(load_activity(root,d,d['assignments']['worker'],now=time.time()))
                update(root,'worker',state='completed',exit_code=0)
                self.assertIsNone(build_project(root)['actors'][1].get('toolActivity'))
        self.assertNotEqual(*outputs)

    def test_stdout_bytes_bad_lines_oversize_and_exitcode_preserved(self):
        for source,flags in [('codex',['exec','--json']),('claude',['--print','--verbose','--output-format','stream-json'])]:
            with self.subTest(source=source),tempfile.TemporaryDirectory() as td:
                root=Path(td).resolve();activate(root,'owner','ctx')
                data=b'{bad json\n'+b'x'*(1024*1024+10)+b'\n'+json.dumps({'type':'item.started','item':{'id':'i','type':'command_execution','command':'SECRET'}}).encode()+b'\n'
                script=root/'stub.py';script.write_text('import sys\nsys.stdout.buffer.write('+repr(data)+')\nsys.stderr.write("CLI stderr stays separate\\n")\nsys.exit(7)\n')
                cmd=[sys.executable,str(Path(__file__).with_name('runtime.py')),'--root',str(root),'launch','--owner-session','owner','--assignment','worker','--task','task','--role','engineer','--slot','eng-a','--policy','new','--context-id','ctx-new','--session-id',str(uuid.uuid4()),'--source',source,'--',sys.executable,str(script),*flags]
                r=subprocess.run(cmd,capture_output=True)
                self.assertEqual(r.returncode,7);self.assertEqual(r.stdout,data);self.assertIn(b'CLI stderr',r.stderr)
                registry=read(root);self.assertEqual(registry['assignments']['worker']['state'],'failed');self.assertIsNone(registry['assignments']['worker']['verdict'])
                self.assertEqual(registry['dispatch_receipts'][-1]['action'],'finished')
                metadata=(root/'.delegate/observer/streams/worker.json').read_text();self.assertNotIn('SECRET',metadata);self.assertLess(len(metadata),32768)

    def test_adapter_setup_failure_finishes_without_spawning_command(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve();activate(root,'owner','ctx')
            args=dict(assignment='w',task='t',role='engineer',slot='eng-a',policy='new',context_id='new',session_id=str(uuid.uuid4()))
            with patch('cli_stream.StreamAdapter',side_effect=ValueError('fixture adapter error')):
                code=launch(root,'owner',[sys.executable,'-c','raise Exception("must not execute")','exec','--json'],source='codex',**args)
            self.assertEqual(code,125);self.assertEqual(read(root)['assignments']['w']['state'],'failed')
            self.assertEqual(read(root)['dispatch_receipts'][-1]['action'],'finished')

    def test_runtime_sidecar_failure_does_not_replace_original_stdout_or_exit(self):
        from cli_stream import forward_stream
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve();adapter=self.setup_launch(root,'codex')
            data=b'{"type":"item.started","item":{"id":"i","type":"command_execution"}}\n'
            child=subprocess.Popen([sys.executable,'-c','import sys;sys.stdout.buffer.write('+repr(data)+');sys.exit(9)'],stdout=subprocess.PIPE)
            output=io.BytesIO();wrapper=io.TextIOWrapper(output,encoding='utf8')
            with patch.object(adapter,'feed',side_effect=OSError('sidecar full')),patch.object(adapter,'persist',side_effect=OSError('sidecar full')),contextlib.redirect_stdout(wrapper):
                self.assertEqual(forward_stream(child,adapter),9)
            wrapper.flush();self.assertEqual(output.getvalue(),data);wrapper.detach()

    def test_oversized_line_and_broken_metadata_sink_preserve_all_bytes_and_exit(self):
        from cli_stream import forward_stream
        class BrokenSink:
            suppressed=False
            def persist(self): raise OSError('synthetic metadata sink full')
            def feed(self,row): raise AssertionError('oversized line must not be parsed')
        class StdoutSink:
            def __init__(self): self.buffer=io.BytesIO()
        sink=StdoutSink();adapter=BrokenSink()
        data=b'x'*(1024*1024+32)+b'\n'
        child=subprocess.Popen([sys.executable,'-c','import sys,time;sys.stdout.write("x"*(1024*1024+32)+"\\n");sys.stdout.flush();time.sleep(.05);sys.exit(7)'],stdout=subprocess.PIPE)
        with contextlib.redirect_stdout(sink): self.assertEqual(forward_stream(child,adapter),7)
        self.assertTrue(adapter.suppressed);self.assertEqual(sink.buffer.getvalue(),data)
        self.assertIsNotNone(child.poll());self.assertTrue(child.stdout.closed)
        # The managed wrapper must also retain the actual code and finish audit.
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve();activate(root,'owner','ctx');sink=StdoutSink()
            binding=dict(assignment='w',task='t',role='engineer',slot='eng-a',policy='new',context_id='new',session_id=str(uuid.uuid4()))
            with patch('cli_stream.StreamAdapter',return_value=BrokenSink()),contextlib.redirect_stdout(sink),contextlib.redirect_stderr(io.StringIO()):
                code=launch(root,'owner',[sys.executable,'-c','import sys;sys.stdout.write("x"*(1024*1024+32)+"\\n");sys.exit(7)','exec','--json'],source='codex',**binding)
            self.assertEqual(code,7);self.assertEqual(sink.buffer.getvalue(),data)
            d=read(root);self.assertEqual(d['assignments']['w']['exit_code'],7);self.assertEqual(d['assignments']['w']['state'],'failed')
            self.assertEqual(d['dispatch_receipts'][-1]['action'],'finished');self.assertIsNone(d['assignments']['w']['verdict'])

    def test_real_stdout_failure_reaps_started_child_and_emits_finish_receipt(self):
        class BrokenStdout:
            @property
            def buffer(self): return self
            def write(self,data): raise OSError('synthetic output pipe failure')
            def flush(self): pass
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve();activate(root,'owner','ctx');children=[];real_popen=subprocess.Popen
            def capture(*args,**kwargs):
                child=real_popen(*args,**kwargs);children.append(child);return child
            binding=dict(assignment='w',task='t',role='engineer',slot='eng-a',policy='new',context_id='new',session_id=str(uuid.uuid4()))
            with patch('dispatch.subprocess.Popen',side_effect=capture),contextlib.redirect_stdout(BrokenStdout()),contextlib.redirect_stderr(io.StringIO()):
                code=launch(root,'owner',[sys.executable,'-c','import sys,time;print("ready",flush=True);time.sleep(30)','exec','--json'],source='codex',**binding)
            self.assertEqual(code,125);self.assertIsNotNone(children[0].poll());self.assertTrue(children[0].stdout.closed)
            d=read(root);self.assertEqual(d['assignments']['w']['state'],'failed');self.assertEqual(d['dispatch_receipts'][-1]['action'],'finished')
            with self.assertRaises(ProcessLookupError):os.kill(children[0].pid,0)

    def test_real_read_failure_kills_unresponsive_child_and_finishes(self):
        import cli_stream
        real_forward=cli_stream.forward_stream;children=[]
        def broken_read(child,adapter):
            children.append(child)
            self.assertEqual(child.stdout.readline(),b'ready\n')
            with patch('cli_stream.os.read',side_effect=OSError('synthetic read failure')):
                return real_forward(child,adapter)
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve();activate(root,'owner','ctx')
            binding=dict(assignment='w',task='t',role='engineer',slot='eng-a',policy='new',context_id='new',session_id=str(uuid.uuid4()))
            with patch('cli_stream.forward_stream',side_effect=broken_read),patch('dispatch.REAP_TIMEOUT',.1),contextlib.redirect_stderr(io.StringIO()):
                code=launch(root,'owner',[sys.executable,'-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print("ready",flush=True);time.sleep(30)','exec','--json'],source='codex',**binding)
            self.assertEqual(code,125);self.assertEqual(children[0].returncode,-signal.SIGKILL);self.assertTrue(children[0].stdout.closed)
            d=read(root);self.assertEqual(d['assignments']['w']['exit_code'],125);self.assertEqual(d['dispatch_receipts'][-1]['action'],'finished')
            with self.assertRaises(ProcessLookupError):os.kill(children[0].pid,0)

    def test_interrupt_finishes_and_reaps_own_child(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve();activate(root,'owner','ctx')
            cmd=[sys.executable,str(Path(__file__).with_name('runtime.py')),'--root',str(root),'launch','--owner-session','owner','--assignment','w','--task','t','--role','engineer','--slot','eng-a','--policy','new','--context-id','new','--session-id',str(uuid.uuid4()),'--',sys.executable,'-c','import os,time;print(os.getpid(),flush=True);time.sleep(30)']
            child=subprocess.Popen(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            pid=int(child.stdout.readline());child.send_signal(signal.SIGTERM);child.communicate(timeout=10)
            self.assertEqual(child.returncode,130);self.assertEqual(read(root)['assignments']['w']['state'],'cancelled')
            with self.assertRaises(ProcessLookupError):os.kill(pid,0)


if __name__=='__main__':unittest.main()
