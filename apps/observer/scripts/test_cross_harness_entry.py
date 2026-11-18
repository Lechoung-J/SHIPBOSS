"""EXAMPLE-056 engineering fixtures. EPERM is simulated; no real model sandbox claim."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest
import uuid

from test_observer_bootstrap import BootstrapTests, REPO


class QueueTests(unittest.TestCase):
    setUp = BootstrapTests.setUp
    tearDown = BootstrapTests.tearDown
    run_entry = BootstrapTests.run_entry

    def helper(self, **delta):
        self.service.mkdir(exist_ok=True)
        value = dict(version=1, kind='shipboss-observer-helper', updatedAt=time.time(),
                     appPid=12345, statePath=str(self.service/'observer-state.json'),
                     status='ready', capabilities=['activation-queue-v1'], seenRequestIds=[])
        value.update(delta)
        (self.service/'helper-status.json').write_text(json.dumps(value))

    def restricted(self, argv, *, env=None, success=True):
        environment = {**self.env, **(env or {})}
        code = f'''import importlib.util, json, os
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('service', {str(self.bundle/'scripts/observer-service.py')!r})
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
with patch('subprocess.run',side_effect=PermissionError(1,'Operation not permitted','ps')) as probe, patch('subprocess.Popen',side_effect=AssertionError('process launch in metadata queue')) as launch:
    try:
        result=s.main({list(argv)!r})
        print(json.dumps({{'exit':result,'ps_calls':probe.call_count,'launch_calls':launch.call_count}}))
    except (ValueError,OSError) as exc:
        print(json.dumps({{'error':str(exc),'ps_calls':probe.call_count,'launch_calls':launch.call_count}}))
        raise SystemExit(1)
'''
        p=subprocess.run([sys.executable,'-c',code],env=environment,capture_output=True,text=True,timeout=20)
        self.assertEqual(p.returncode, 0 if success else 1, p.stdout+p.stderr)
        lines=[json.loads(line) for line in p.stdout.splitlines()]
        self.assertEqual(lines[-1]['ps_calls'],0)
        self.assertEqual(lines[-1]['launch_calls'],0)
        return lines

    def args(self, *extra):
        return ['start','--harness','codex','--project',str(self.project),'--service-dir',str(self.service),*extra]

    def test_default_codex_context_only_uses_official_env_not_dsh(self):
        self.helper()
        official=str(uuid.uuid4())
        output=self.restricted(self.args('--context-id',official),env={'CODEX_THREAD_ID':official,'DSH_SESSION_ID':'session-wrong-dsh'})
        self.assertTrue(output[0]['queued']);self.assertFalse(output[0]['shown'])
        self.assertEqual(output[0]['activation']['sessionId'],official)
        self.assertFalse((self.project/'.delegate').exists())
        receipt=list((self.service/'activation-receipts').glob('*.json'))
        self.assertEqual(len(receipt),1)
        again=self.restricted(self.args('--context-id',official),env={'CODEX_THREAD_ID':official})
        self.assertEqual(output[0]['activation']['showRequestId'],again[0]['activation']['showRequestId'])
        self.assertEqual(output[0]['activation']['activatedAt'],again[0]['activation']['activatedAt'])

    def test_explicit_external_missing_identity_never_inherits_dsh(self):
        self.helper()
        out=self.restricted(self.args('--context-id',str(uuid.uuid4())),env={'CODEX_THREAD_ID':'','CLAUDE_SESSION_ID':''},success=False)
        self.assertIn('actual session UUID',out[-1]['error'])
        self.assertFalse((self.service/'activation-receipts').exists())

    def test_explicit_owner_beats_env_and_show_uses_unique_id(self):
        self.helper();sid=str(uuid.uuid4())
        values=self.args('--owner-session',sid,'--context-id',sid)
        first=self.restricted(values,env={'CODEX_THREAD_ID':str(uuid.uuid4())})[0]['activation']
        values[0]='show'
        second=self.restricted(values)[0]['activation']
        third=self.restricted(values)[0]['activation']
        self.assertEqual(second['sessionId'],sid)
        self.assertNotEqual(first['showRequestId'],second['showRequestId'])
        self.assertNotEqual(second['showRequestId'],third['showRequestId'])

    def test_cold_stale_wrong_partial_oversized_symlink_helper_are_honest(self):
        for kind in ('cold','stale','wrongstate','partial','oversize','symlink'):
            with self.subTest(kind=kind):
                if kind!='cold':
                    self.helper(**({'updatedAt':time.time()-90} if kind=='stale' else {'statePath':'/other/state.json'} if kind=='wrongstate' else {}))
                p=self.service/'helper-status.json'
                if kind=='partial':p.write_text('{')
                if kind=='oversize':p.write_text(' '*25000)
                if kind=='symlink':
                    target=self.service/'untrusted-helper.json';target.write_bytes(p.read_bytes());p.unlink();p.symlink_to(target)
                out=self.restricted(self.args('--owner-session',self.sid),success=False)
                self.assertIn('no ready existing observer helper',out[-1]['error'])
                self.assertFalse((self.service/'activation-receipts').exists())
                self.assertFalse((self.project/'.delegate').exists())
                if p.is_symlink() or p.exists():p.unlink()

    def test_excluded_request_writes_neither_receipt_nor_registry(self):
        self.helper()
        output=self.restricted(self.args('--owner-session',self.sid,'--exclude-project',self.project.name))
        self.assertTrue(output[0]['excluded'])
        self.assertFalse((self.service/'activation-receipts').exists())
        self.assertFalse((self.project/'.delegate').exists())

    def test_status_uses_only_helper_metadata(self):
        self.helper();args=self.args('--owner-session',self.sid);args[0]='status'
        output=self.restricted(args)
        self.assertFalse(output[0]['process_probe']);self.assertIsNotNone(output[0]['helper'])

    def test_internal_candidate_installs_complete_project_local_shipboss(self):
        source=Path(__file__).resolve().parents[3]
        for harness,folder in (('codex','.agents'),('claude','.claude')):
            project=self.root/('release '+harness)
            project.mkdir()
            command=[sys.executable,str(self.bundle/'scripts/observer-install.py'),
                     '--skill-source',str(source),'--project-skill',harness,'--project',str(project),
                     '--observer-home',str(self.bundle),'--no-start']
            result=subprocess.run(command,env=self.env,capture_output=True,text=True,timeout=25)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            receipt=json.loads(result.stdout);dest=project/folder/'skills/shipboss'
            text=(dest/'SKILL.md').read_text()
            self.assertIn('name: shipboss',text)
            self.assertIn('# Shipboss —',text)
            for heading in ('## 流程（六阶段）','## 派发后待命与汇报纪律','## PM 换班与上下文管理'):
                self.assertIn(heading,text)
            self.assertTrue((dest/'scripts/observer-install.py').is_file())
            self.assertTrue((dest/'references/observer-bootstrap.md').is_file())
            self.assertEqual(receipt['release']['name'],'shipboss')
            self.assertFalse(receipt['release']['public_release'])
            self.assertEqual(receipt['release']['edition'], 'public')
            self.assertFalse(receipt['startup']['attempted'])
            if harness=='claude':self.assertIn("--owner-session '${CLAUDE_SESSION_ID}'",text)
            else:self.assertIn('--owner-session "$CODEX_THREAD_ID"',text)

    def test_queue_missing_journal_stays_unverified_without_project_writes(self):
        self.helper();sid=str(uuid.uuid4())
        self.restricted(self.args('--owner-session',sid))
        code=f'''import sys,time
sys.path.insert(0,{str(self.bundle/'runtime')!r})
from external_journal import OfficialJournalReader
from onboarding import external_sessions
from pathlib import Path
requests=[]
sessions=external_sessions({str(self.service/'activation-receipts')!r},now=time.time(),reader=OfficialJournalReader(home=Path({str(self.root/'no journal home')!r})),requests=requests)
assert len(sessions)==1 and not requests
assert sessions[0]['header']['source']=='external-declared'
'''
        result=subprocess.run([sys.executable,'-c',code],env=self.env,capture_output=True,text=True,timeout=15)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertFalse((self.project/'.delegate').exists())


if __name__=='__main__':
    unittest.main(verbosity=2)
