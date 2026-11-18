"""EXAMPLE-055 isolated integration tests. Native files are synthetic; PIDs are real."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

APP = Path(__file__).resolve().parents[1]
REPO = APP.parents[1]
RUNTIME_SOURCE = Path(os.environ.get('SHIPBOSS_TEST_RUNTIME_SOURCE', str(APP / 'runtime')))


def encoded(root):
    return '--' + ''.join('-' if c == '/' else c if c.isalnum() or c in '-._' else '~%04X' % ord(c)
                          for c in str(root).lstrip('/')) + '--'


def native(home, root, sid, *, success=True, child=False, usage=True):
    now = time.time()
    header = {'type': 'session', 'id': sid, 'cwd': str(root), 'delegationDepth': 1 if child else 0}
    if child:
        header['parentSession'] = 'actual-parent'
    rows = [header]
    events = [('turn/start', {'turn': 'turn-1'}), ('step/start', {'turn': 'turn-1', 'step': 'step-1'})]
    if usage:
        events += [('tool/call', {'name': 'skill', 'callId': 'load-shipboss', 'arguments': {'name': 'shipboss'}}),
                   ('tool/result', {'message': {'toolCallId': 'load-shipboss', 'isError': not success}})]
    for seq, (kind, data) in enumerate(events):
        rows.append({'type': kind, 'seq': seq, 'time': (now - .1 + seq * .01) * 1000, 'data': data})
    path = home / 'sessions' / encoded(root) / sid / 'session.v4.jsonl.zstd'
    path.parent.mkdir(parents=True, exist_ok=True)
    compressed = subprocess.run(['zstd', '-q', '-c'], input='\n'.join(json.dumps(row) for row in rows).encode()+b'\n', capture_output=True, check=True)
    path.write_bytes(compressed.stdout)
    identity = home / 'storages/session_projcache/sessions' / (sid + '.json')
    identity.parent.mkdir(parents=True, exist_ok=True)
    identity.write_text(json.dumps({'record': {'identity': {'cwd': str(root), 'isSeeded': False}}}))
    return path


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='shipboss onboarding ')
        self.root = Path(self.temp.name).resolve()
        self.bundle = self.root / 'portable bundle/apps/observer'
        self.bundle.mkdir(parents=True)
        shutil.copytree(APP / 'scripts', self.bundle / 'scripts', ignore=shutil.ignore_patterns('__pycache__'))
        shutil.copytree(RUNTIME_SOURCE, self.bundle / 'runtime', ignore=shutil.ignore_patterns('__pycache__'))
        (self.bundle / 'desktop').mkdir()
        (self.bundle / 'desktop/main.cjs').write_text('// process substitute, not GUI')
        (self.bundle / 'desktop/trayTemplate.png').write_bytes(b'fixture')
        (self.bundle / 'dist').mkdir()
        (self.bundle / 'dist/widget.html').write_text('<p>fixture</p>')
        self.home, self.service = self.root / 'DSH home', self.root / 'own service'
        self.project = self.root / 'repo A with spaces'
        self.project.mkdir()
        self.sid = str(uuid.uuid4())
        self.fake = self.root / 'electron substitute'
        self.fake.write_text('''#!/usr/bin/env python3
import os, pathlib, time
p=pathlib.Path(os.environ['SHIPBOSS_OBSERVER_STATE']).parent
count=p/'app-start-count'
if count.exists():
    (p/'show-request').write_text('second-instance')
    raise SystemExit(0)
count.write_text('1')
while True: time.sleep(.1)
''')
        self.fake.chmod(0o755)
        self.env = {**os.environ, 'DSH_HOME': str(self.home), 'DSH_SESSION_ID': self.sid,
                    'SHIPBOSS_ELECTRON_BINARY': str(self.fake), 'PYTHONDONTWRITEBYTECODE': '1'}
        self.env.pop('SHIPBOSS_OBSERVER_HOME', None)
        self.env.pop('SHIPBOSS_OBSERVER_SERVICE_DIR', None)
        self.source = native(self.home, self.project, self.sid)
        self.entry = self.bundle / 'scripts/observer-bootstrap.py'

    def run_entry(self, action='start', *, project=None, sid=None, extra=(), ok=True):
        command = [sys.executable, str(self.entry), action, '--project', str(project or self.project),
                   '--service-dir', str(self.service), '--owner-session', self.sid if sid is None else sid, '--direct', *extra]
        result = subprocess.run(command, env=self.env, capture_output=True, text=True, timeout=40)
        if ok:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        return result

    def tearDown(self):
        try:
            self.run_entry('stop')
        finally:
            self.temp.cleanup()

    def registry_bytes(self):
        return (self.project / '.delegate/observer/runtime.json').read_bytes()

    def test_A_B_duplicate_newsession_and_immutable_owner(self):
        first = self.run_entry()
        self.assertEqual(first['started'], ['writer', 'app'])
        self.assertTrue(first['first_show_requested'])
        original = self.registry_bytes()
        duplicate = self.run_entry()
        self.assertEqual(duplicate['started'], [])
        self.assertFalse(duplicate['first_show_requested'])
        self.assertEqual(first['app_pid'], duplicate['app_pid'])
        ignored_context = self.run_entry(extra=['--context-id', 'not-a-native-context'])
        self.assertFalse(ignored_context['first_show_requested'])
        self.assertEqual(self.registry_bytes(), original)
        project_b = self.root / 'repo B'
        project_b.mkdir()
        b_sid = str(uuid.uuid4())
        native(self.home, project_b, b_sid)
        b = self.run_entry(project=project_b, sid=b_sid)
        self.assertEqual(b['started'], [])
        self.assertEqual(first['writer_pid'], b['writer_pid'])
        self.assertTrue(b['first_load'])
        self.assertTrue(b['first_show_requested'])
        self.assertTrue((self.service / 'show-request').exists())
        state = json.loads(Path(b['state']).read_text())
        self.assertEqual({p['name'] for p in state['projects']}, {self.project.name, project_b.name})
        original_order = [p['id'] for p in state['projects']]
        new_sid = str(uuid.uuid4())
        native(self.home, self.project, new_sid)
        new = self.run_entry(sid=new_sid)
        self.assertEqual(new['activation']['registry'], 'reused')
        self.assertTrue(new['first_show_requested'])
        self.assertFalse(self.run_entry(sid=new_sid)['first_show_requested'])
        processes = json.loads((self.service / 'processes.json').read_text())
        self.assertEqual(len(processes['seen_activations']), 3)
        self.assertEqual(self.registry_bytes(), original)
        state = json.loads(Path(new['state']).read_text())
        self.assertEqual([p['id'] for p in state['projects']], original_order)
        project = next(p for p in state['projects'] if p['name'] == self.project.name)
        self.assertEqual(project['ownerSessionId'], self.sid)
        self.assertIn(new_sid, project['sessionIds'])

    def test_explicit_show_reuses_pid_and_repeat_preserves_hide(self):
        first = self.run_entry()
        (self.service / 'hidden-fixture').write_text('hidden')
        self.run_entry()
        self.assertFalse((self.service / 'show-request').exists())
        shown = self.run_entry('show')
        self.assertEqual(shown['app_pid'], first['app_pid'])
        self.assertTrue(shown['show_requested'])
        self.assertTrue((self.service / 'show-request').exists())

    def test_failed_skill_missing_session_child_wrong_project_untrusted(self):
        for kind in ('failed', 'no-usage', 'child', 'no-session', 'wrong-project', 'untrusted-file'):
            with self.subTest(kind=kind):
                sid = str(uuid.uuid4())
                root = self.root / kind
                root.mkdir()
                source = native(self.home, root, sid, success=kind != 'failed', usage=kind != 'no-usage', child=kind == 'child')
                extra = []
                if kind == 'untrusted-file':
                    fake = self.root / 'untrusted/session.jsonl'
                    fake.parent.mkdir()
                    fake.write_text('{}')
                    extra = ['--session-file', str(fake)]
                result = self.run_entry(project=root, sid='' if kind == 'no-session' else self.sid if kind == 'wrong-project' else sid, extra=extra, ok=False)
                self.assertTrue(result.stderr)
                self.assertFalse((root / '.delegate/observer/runtime.json').exists())
                self.assertFalse((self.service / 'processes.json').exists())

    def test_missing_runtime_dependency_before_project_write(self):
        self.env['SHIPBOSS_ELECTRON_BINARY'] = str(self.root / 'missing binary')
        result = self.run_entry(ok=False)
        self.assertIn('not ready', result.stderr)
        self.assertFalse((self.project / '.delegate').exists())
        self.assertFalse((self.service / 'processes.json').exists())

    def test_missing_project(self):
        result = self.run_entry(project=self.root / 'missing root', ok=False)
        self.assertIn('directory is missing', result.stderr)

    def test_stale_pid_identity_never_signals_other_process(self):
        self.service.mkdir()
        bogus = {'pid': os.getpid(), 'identity': 'not the current process identity', 'argv': []}
        (self.service / 'processes.json').write_text(json.dumps({'app': bogus, 'writer': bogus}))
        started = self.run_entry()
        self.assertEqual(started['started'], ['writer', 'app'])
        self.assertNotEqual(started['app_pid'], os.getpid())

    def test_launch_exit_reports_real_code_and_rolls_back_own_writer(self):
        self.fake.write_text('#!/usr/bin/env python3\nraise SystemExit(9)\n')
        failed = self.run_entry(ok=False)
        self.assertIn('exited 9', failed.stderr)
        status = self.run_entry('status')
        self.assertFalse(status['app'])
        self.assertFalse(status['writer'])
        self.assertEqual(json.loads((self.service / 'processes.json').read_text()), {})

    def test_status_does_not_create_state_or_project_registry(self):
        status = self.run_entry('status')
        self.assertFalse(status['app'])
        self.assertFalse(self.service.exists())
        self.assertFalse((self.project / '.delegate').exists())

    def test_explicit_home_missing_does_not_fallback(self):
        result = self.run_entry('check', extra=['--observer-home', str(self.root / 'bad home')], ok=False)
        self.assertIn('observer-home', result.stderr)

    def test_external_requires_real_context_and_no_inferred_role(self):
        result = self.run_entry(extra=['--harness', 'codex', '--context-id', 'invented-context'], sid='invented-session', ok=False)
        self.assertTrue(result.stderr)
        self.assertFalse((self.project / '.delegate/observer/runtime.json').exists())

    def test_external_receipt_creates_declared_owner_without_active_pm(self):
        external = self.root / 'external repo'
        external.mkdir()
        actual = str(uuid.uuid4())
        context = str(uuid.uuid4())
        result = self.run_entry(project=external, sid=actual,
                                extra=['--harness', 'codex', '--context-id', context])
        self.assertEqual(result['activation']['source'], 'external-declared')
        registry = json.loads((external / '.delegate/observer/runtime.json').read_text())
        self.assertEqual(registry['owner_session'], actual)
        self.assertEqual(registry['pm_context'], context)
        self.assertIsNone(registry['session_file'])
        self.assertEqual(result['activation']['registryOwnerSessionId'], actual)
        receipts = list((self.service / 'activation-receipts').glob('*.json'))
        self.assertEqual(len(receipts), 1)
        receipt = json.loads(receipts[0].read_text())
        self.assertEqual(receipt['contextId'], context)
        state = json.loads(Path(result['state']).read_text())
        project = next(p for p in state['projects'] if p['name'] == external.name)
        self.assertFalse(any(a['active'] for a in project['actors']))
        again = self.run_entry(project=external, sid=actual,
                              extra=['--harness', 'codex', '--context-id', context])
        self.assertEqual(again['started'], [])
        self.assertEqual(len(list((self.service / 'activation-receipts').glob('*.json'))), 1)

    def test_excluded_projects_precede_native_reads_and_external_receipts(self):
        for label, exclusion in (('ExcludedProject', []), ('CustomExcluded', ['--exclude-project', 'CustomExcluded']),
                                  ('ExactExcluded', ['--exclude-project', str(self.root / 'ExactExcluded')])):
            project = self.root / label
            registry = project / '.delegate/observer/runtime.json'
            registry.parent.mkdir(parents=True)
            original = b'preexisting excluded registry must remain unread and unchanged'
            registry.write_bytes(original)
            for harness in ('dsh', 'codex'):
                with self.subTest(project=label, harness=harness):
                    argv = ['start', '--project', str(project), '--service-dir', str(self.service),
                            '--owner-session', self.sid, '--harness', harness, '--context-id', str(uuid.uuid4()), *exclusion]
                    code = f'''import importlib.util, json, sys
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('service', {str(self.bundle / 'scripts/observer-service.py')!r})
service=importlib.util.module_from_spec(spec);spec.loader.exec_module(service)
with patch('onboarding.validate_native_activation',side_effect=AssertionError('native read before exclusion')) as native, patch('onboarding.record_external_activation',side_effect=AssertionError('receipt before exclusion')) as external, patch('incremental.IncrementalNative.parse',side_effect=AssertionError('decode before exclusion')) as decode:
    code=service.main({argv!r})
    assert code==0
    assert native.call_count==external.call_count==decode.call_count==0
    print(json.dumps({{'nativeReads':native.call_count,'externalWrites':external.call_count,'decodeCount':decode.call_count}}))
'''
                    result = subprocess.run([sys.executable, '-c', code], env=self.env, capture_output=True, text=True, timeout=15)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    output = [json.loads(line) for line in result.stdout.splitlines()]
                    self.assertTrue(output[0]['excluded'])
                    self.assertEqual(output[1], {'nativeReads': 0, 'externalWrites': 0, 'decodeCount': 0})
                    self.assertEqual(registry.read_bytes(), original)
                    self.assertFalse(self.service.exists())

    def test_new_external_bootstrap_launches_explicit_roles_and_preserves_owner(self):
        project = self.root / 'brand new external repo'
        project.mkdir()
        actual, context = str(uuid.uuid4()), str(uuid.uuid4())
        first = self.run_entry(project=project, sid=actual, extra=['--harness', 'codex', '--context-id', context])
        owner = first['activation']['registryOwnerSessionId']
        self.assertEqual(owner, actual)
        runtime = self.bundle / 'runtime/runtime.py'
        writer = self.bundle / 'runtime/observer_state.py'
        for role, slot, policy in (('engineer', 'eng-a', 'new'), ('verifier', 'verifier', 'fresh'), ('recording', 'recording', 'new')):
            during = self.root / (slot + '-during.json')
            writer_argv = [sys.executable, str(writer), '--dsh-home', str(self.home), '--index', str(self.service / (slot + '-index.json')),
                           '--activation-receipts', str(self.service / 'activation-receipts'), '--out', str(during)]
            child = 'import subprocess;subprocess.run(' + repr(writer_argv) + ',check=True)'
            command = [sys.executable, str(runtime), '--root', str(project), 'launch', '--owner-session', owner,
                       '--assignment', 'external-' + slot, '--task', 'external-' + slot, '--role', role, '--slot', slot,
                       '--policy', policy, '--context-id', str(uuid.uuid4()), '--session-id', str(uuid.uuid4()), '--source', 'process']
            if role == 'verifier':
                command += ['--revision', 'fixture-revision']
            result = subprocess.run([*command, '--', sys.executable, '-c', child], env=self.env, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            receipts = [json.loads(line) for line in result.stderr.splitlines()]
            self.assertEqual([r['action'] for r in receipts], ['registered', 'finished'])
            self.assertEqual(receipts[0]['ownerSessionId'], owner)
            self.assertIsNone(receipts[-1]['verdict'])
            p = next(p for p in json.loads(during.read_text())['projects'] if p['name'] == project.name)
            actor = p['recordingActor'] if role == 'recording' else next(a for a in p['actors'] if a['id'] == slot)
            self.assertTrue(actor['active'], p)
            self.assertFalse(p['actors'][0]['active'], 'external load must not invent an active PM')
        registry = project / '.delegate/observer/runtime.json'
        original = registry.read_bytes()
        stored = json.loads(original)
        self.assertEqual(len(stored['assignments']), 3)
        self.assertTrue(all(r['state'] == 'completed' and r['exit_code'] == 0 and r['verdict'] is None for r in stored['assignments'].values()))
        next_load = self.run_entry(project=project, sid=str(uuid.uuid4()),
                        extra=['--harness', 'claude', '--context-id', str(uuid.uuid4())])
        self.assertEqual(next_load['activation']['registryOwnerSessionId'], owner)
        self.assertEqual(registry.read_bytes(), original)

    def test_install_verified_start_invalid_session_and_absent_session(self):
        for label, session, attempted, expected_exit in (
                ('valid', self.sid, True, 0), ('invalid', str(uuid.uuid4()), True, 1),
                ('absent', None, False, None)):
            dest = self.root / ('install ' + label)
            env = {**self.env, 'SHIPBOSS_OBSERVER_SERVICE_DIR': str(self.service)}
            if session:
                env['DSH_SESSION_ID'] = session
            else:
                env.pop('DSH_SESSION_ID', None)
            result = subprocess.run(['bash', str(REPO / 'install.sh'), str(dest),
                    '--observer-home', str(self.bundle), '--project', str(self.project)],
                    env=env, capture_output=True, text=True, timeout=40)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            receipt = json.loads((dest / 'observer-install-manifest.json').read_text())
            self.assertTrue(receipt['readiness']['ready'])
            self.assertEqual(receipt['startup']['attempted'], attempted)
            self.assertEqual(receipt['startup'].get('exit_code'), expected_exit)
            self.assertTrue((dest / 'PROTOCOL.md').is_file())
        self.assertTrue(self.run_entry('status')['app'])

    def test_offline_install_legacy_force_and_no_start(self):
        dest = self.root / 'protocol kit'
        for args, expected in (([], 0), (['--no-start'], 1), (['--force', '--no-start'], 0)):
            result = subprocess.run(['bash', str(REPO / 'install.sh'), str(dest), *args],
                                    env=self.env, capture_output=True, text=True, timeout=25)
            self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        self.assertTrue((dest / 'PROTOCOL.md').is_file())
        self.assertTrue((dest / 'scripts/observer.sh').is_file())
        receipt = json.loads((dest / 'observer-install-manifest.json').read_text())
        self.assertFalse(receipt['readiness']['ready'])
        self.assertFalse(receipt['startup']['attempted'])
        self.assertFalse((self.project / '.delegate').exists())
        self.assertFalse((dest / 'observer/node_modules').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
