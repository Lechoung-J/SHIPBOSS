#!/usr/bin/env python3
"""Synthetic temporary repositories only; never uses the caller's repository."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SOURCE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('resources', SOURCE / 'scripts/shipboss-resources.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name).resolve() / 'repo'; self.root.mkdir()
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.name', 'Resource Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        (self.root / 'tracked').write_bytes(b'original\x00binary')
        (self.root / 'removed').write_text('remove me')
        (self.root / '.gitignore').write_text('ignored\nnode_modules\n')
        self.git('add', '.'); self.git('commit', '-qm', 'synthetic fixture')
        self.manager = m.Manager(self.root, probe=lambda _: 'idle')
    def tearDown(self): self.tmp.cleanup()
    def git(self, *args): return m.git(self.root, *args)
    def own(self, key='old', kind='artifact', retention='reclaim', owner_state='inactive', links=None):
        path = self.root / key
        if kind == 'worktree': self.git('worktree', 'add', '-qb', 'fixture-' + key, str(path))
        else:
            path.mkdir(); (path / 'file').write_bytes(b'shared large content' * 1000)
        item = dict(id=key, path=key, kind=kind, task='fixture', owner='engineer',
                    owner_state=owner_state, lease_until=0, retention=retention, archive_not_integrated=True)
        if links: item['dependency_links'] = links
        self.manager.adopt({'resources': [item]})
        return path
    def apply(self, *ids):
        p = self.manager.plan(list(ids) or None)
        return self.manager.apply(p, p['digest'])
    def assert_acl_protected(self, source, plan=None):
        sentinel = self.root / 'outside-sentinel'; sentinel.write_bytes(b'untouched')
        before = (source / 'file').read_bytes()
        if plan is None:
            plan = self.manager.plan([source.name])
            self.assertEqual(plan['resources'][0]['action'], 'blocked', plan)
        result = self.manager.apply(plan, plan['digest'])
        self.assertTrue(all(row['status'] == 'blocked' for row in result['resources']), result)
        self.assertEqual((source / 'file').read_bytes(), before)
        self.assertEqual(sentinel.read_bytes(), b'untouched')
        self.assertTrue(source.is_dir())
        return result
    @unittest.skipUnless(sys.platform == 'darwin', 'native macOS ACL fixture')
    def test_file_acl_is_protected(self):
        source = self.own()
        m.run(['/bin/chmod', '+a', 'everyone allow read', str(source / 'file')])
        self.assertEqual(m.acl_status(source / 'file'), 'present')
        self.assert_acl_protected(source)
        self.assertEqual(m.acl_status(source / 'file'), 'present')
    @unittest.skipUnless(sys.platform == 'darwin', 'native macOS ACL fixture')
    def test_directory_acl_is_protected(self):
        source = self.own(); directory = source / 'nested'; directory.mkdir()
        m.run(['/bin/chmod', '+a', 'everyone allow read', str(directory)])
        self.assert_acl_protected(source)
        self.assertEqual(m.acl_status(directory), 'present')
    @unittest.skipUnless(sys.platform == 'darwin', 'native macOS ACL fixture')
    def test_acl_added_after_plan_blocks_apply(self):
        source = self.own(); plan = self.manager.plan(['old'])
        self.assertEqual(plan['resources'][0]['action'], 'archive-release')
        m.run(['/bin/chmod', '+a', 'everyone allow read', str(source / 'file')])
        result = self.assert_acl_protected(source, plan)
        self.assertEqual(result['resources'][0]['reason'], 'unsupported-acl')
    def test_acl_probe_failure_protects_source(self):
        source = self.own(); plan = self.manager.plan(['old'])
        with mock.patch.object(m, '_ACL_LIBRARY', None), mock.patch.object(m.ctypes, 'CDLL', side_effect=OSError('synthetic missing native API')):
            self.assertEqual(m.acl_status(source / 'file'), 'unknown')
            self.assert_acl_protected(source)
            result = self.assert_acl_protected(source, plan)
            self.assertEqual(result['resources'][0]['reason'], 'acl-probe-unknown')
    def test_symlink_acl_probe_is_not_skipped(self):
        source = self.own(); link = source / 'link'; link.symlink_to('file')
        native = m.acl_status
        for verdict in ('present', 'unknown'):
            with mock.patch.object(m, 'acl_status', side_effect=lambda p: verdict if p == link else native(p)):
                self.assert_acl_protected(source)
        self.assertEqual(os.readlink(link), 'file')
    @unittest.skipUnless(sys.platform == 'darwin', 'native macOS ACL fixture')
    def test_acl_on_restore_blocks_release(self):
        source = self.own(); real_setattrs = m.setattrs
        def injected_restore_acl(path, attrs):
            real_setattrs(path, attrs)
            if path.name == 'file': m.run(['/bin/chmod', '+a', 'everyone allow read', str(path)])
        plan = self.manager.plan(['old'])
        with mock.patch.object(m, 'setattrs', side_effect=injected_restore_acl):
            result = self.assert_acl_protected(source, plan)
        self.assertEqual(result['resources'][0]['reason'], 'unsupported-acl')
        self.assertEqual(m.acl_status(source / 'file'), 'absent')
    def test_readonly_inventory_plan(self):
        self.manager.inventory(); self.manager.plan()
        self.assertFalse(self.manager.home.exists())
    def test_dedup_restore_modes_symlink_xattrs(self):
        a = self.own('a.app'); b = self.own('b.app')
        for p in (a, b):
            (p / 'file').chmod(0o751); (p / 'dir').mkdir(); os.symlink('../file', p / 'dir/link')
            if hasattr(os, 'setxattr'):
                try: os.setxattr(p / 'file', 'user.fixture', b'attribute')
                except OSError: pass
        receipt = self.apply('a.app', 'b.app')
        self.assertTrue(all(x['status'] == 'workspace-released' for x in receipt['resources']), receipt)
        self.assertEqual(len(list((self.manager.home / 'objects').iterdir())), 1)
        key = receipt['resources'][0]['archive']
        self.manager.restore(key, 'restored.app')
        self.assertEqual((self.root / 'restored.app/file').stat().st_mode & 0o777, 0o751)
        self.assertEqual(os.readlink(self.root / 'restored.app/dir/link'), '../file')
        self.assertEqual((self.root / 'restored.app/file').read_bytes(), b'shared large content' * 1000)
    def test_dirty_worktree_restore_git_state_and_ignored(self):
        p = self.own('work', 'worktree')
        (p / 'tracked').write_bytes(b'staged\x00change'); m.git(p, 'add', 'tracked')
        (p / 'tracked').write_bytes(b'unstaged\x00change')
        m.git(p, 'mv', 'removed', 'renamed'); (p / 'renamed').unlink()
        (p / 'untracked').write_text('unique evidence'); (p / 'ignored').write_bytes(b'unique ignored')
        deps = self.root / 'cache/node_modules'; deps.mkdir(parents=True); (deps / 'shared').write_text('cached')
        os.symlink('../cache/node_modules', p / 'node_modules')
        registry = self.manager.registry(); registry['resources']['work']['dependency_links'] = {'node_modules': 'cache/node_modules'}
        m.atomic(self.manager.home / 'registry.json', registry)
        before = self.manager.git_state(p)
        result = self.apply('work')['resources'][0]
        self.assertEqual(result['status'], 'workspace-released', result)
        self.assertFalse(p.exists()); self.assertTrue(self.git('show-ref', result['archive_ref']))
        self.manager.restore(result['archive'], 'work')
        after = self.manager.git_state(p)
        for name in ('head', 'branch', 'index', 'status', 'stages', 'staged', 'unstaged'): self.assertEqual(before[name], after[name], name)
        self.assertEqual((p / 'ignored').read_bytes(), b'unique ignored')
        self.assertEqual((p / 'untracked').read_text(), 'unique evidence')
        self.assertEqual((p / 'node_modules').resolve(), deps)
        self.assertEqual(self.manager.registry()['resources']['work']['archive_state'], 'archived-not-integrated')
    def test_accept_is_not_integration_or_close(self):
        p = self.own(); (self.root / 'evidence').write_text('independent result')
        self.manager.accept('old', 'evidence')
        with self.assertRaisesRegex(m.Blocked, 'integration-pending'): self.manager.close('old')
        self.assertTrue(p.exists())
    def test_integrated_uncommitted_closes_and_target_stale_blocks(self):
        p = self.own('work', 'worktree'); (self.root / 'proof').write_text('independent proof')
        scope = {'files': [{'source': 'tracked', 'target': 'tracked'}]}
        self.manager.accept('work', 'proof', scope)
        self.manager.integrate('work', scope, 'proof')
        self.manager.verify_integration('work', 'proof')
        self.assertEqual(self.apply('work')['resources'][0]['status'], 'workspace-released')
        (self.root / 'tracked').write_text('changed combination')
        with self.assertRaisesRegex(m.Blocked, 'integration-stale'): self.manager.close('work')
        (self.root / 'tracked').write_bytes(b'original\x00binary')
        self.assertEqual(self.manager.close('work')['lifecycle'], 'closed')
        self.assertEqual(self.manager.registry()['resources']['work']['integration']['kind'], 'integrated-uncommitted')
    def test_active_unknown_and_retention(self):
        self.own('active', owner_state='active'); self.own('current', retention='current'); self.own('rollback', retention='rollback'); self.own('evidence', retention='evidence')
        self.own('idle')
        self.manager.probe = lambda _: 'unknown'
        plan = self.manager.plan()
        self.assertTrue(all(row['action'] == 'blocked' for row in plan['resources']))
        self.manager.probe = lambda _: 'active'
        self.assertEqual(self.manager.plan(['idle'])['resources'][0]['reason'], 'process-active')
    def test_source_change_owner_change_and_symlink_swap(self):
        p = self.own(); plan = self.manager.plan(['old'])
        (p / 'file').write_text('new')
        self.assertEqual(self.manager.apply(plan, plan['digest'])['resources'][0]['status'], 'blocked')
        self.assertTrue(p.exists())
        plan = self.manager.plan(['old']); registry = self.manager.registry(); registry['resources']['old']['owner'] = 'other'
        m.atomic(self.manager.home / 'registry.json', registry)
        with self.assertRaisesRegex(m.Blocked, 'plan-stale-registry'): self.manager.apply(plan, plan['digest'])
        plan = self.manager.plan(['old']); held = self.root / 'held'; p.rename(held); os.symlink(held, p)
        self.assertEqual(self.manager.apply(plan, plan['digest'])['resources'][0]['status'], 'blocked'); self.assertTrue((held / 'file').exists())
    def test_digest_wrong_root_and_concurrency(self):
        self.own(); plan = self.manager.plan(['old'])
        with self.assertRaisesRegex(m.Blocked, 'plan-digest'): self.manager.apply(plan, '0' * 64)
        altered = json.loads(json.dumps(plan)); altered['root']['ino'] += 1; altered['digest'] = m.digest({k:v for k,v in altered.items() if k != 'digest'})
        with self.assertRaisesRegex(m.Blocked, 'wrong-root'): self.manager.apply(altered, altered['digest'])
        with self.manager.locked():
            with self.assertRaisesRegex(m.Blocked, 'concurrent'): self.manager.apply(plan, plan['digest'])
    def test_repeat_apply_does_not_touch_new_path(self):
        p = self.own(); plan = self.manager.plan(['old']); a = self.manager.apply(plan, plan['digest'])
        p.mkdir(); (p / 'new').write_text('new owner data')
        self.assertEqual(self.manager.apply(plan, plan['digest']), a)
        self.assertTrue((p / 'new').exists())
    def test_external_link_and_protected_path(self):
        p = self.own(); os.symlink('/tmp', p / 'outside')
        self.assertEqual(self.manager.plan(['old'])['resources'][0]['action'], 'blocked')
        (p / 'outside').unlink()
        registry = self.manager.registry(); registry['protected'] = ['old/file']; m.atomic(self.manager.home / 'registry.json', registry)
        self.assertEqual(self.manager.plan(['old'])['resources'][0]['reason'], 'protected-path')
        for invalid in ('../other', '/tmp/other', 'a/../b'):
            with self.assertRaises(m.Blocked): self.manager.checked(invalid)
    def test_blob_corruption_and_manifest_tamper(self):
        p = self.own(); item = self.manager.registry()['resources']['old']; key, _ = self.manager.archive(item)
        manifest = self.manager.read_archive(key); blob = next(e['blob'] for e in manifest['snapshot']['tree'] if e['type'] == 'file')
        (self.manager.home / 'objects' / blob).write_bytes(b'corrupt')
        plan = self.manager.plan(['old']); result = self.manager.apply(plan, plan['digest'])
        self.assertEqual(result['resources'][0]['status'], 'blocked'); self.assertTrue(p.exists())
        with self.assertRaises(m.Blocked): self.manager.restore(key, 'corrupt-restore')
        manifest['snapshot']['tree'][1]['path'] = '../escape'; m.atomic(self.manager.home / 'archives' / (key + '.json'), manifest)
        with self.assertRaisesRegex(m.Blocked, 'archive-tampered'): self.manager.restore(key, 'tamper-restore')
        with self.assertRaisesRegex(m.Blocked, 'malformed-blob'): self.manager.blob('../bad')
    def test_manifest_links_parent_and_absolute_entries(self):
        p = self.own(); key, _ = self.manager.archive(self.manager.registry()['resources']['old']); original = self.manager.read_archive(key)
        for invalid in ('../escape', '/absolute'):
            value = json.loads(json.dumps(original)); value['snapshot']['tree'][1]['path'] = invalid
            with self.assertRaises(m.Blocked): self.manager.validate_entries(value)
        value = json.loads(json.dumps(original)); value['snapshot']['tree'].insert(1, {'path':'link', 'mode':0o777, 'type':'symlink','target':'file','xattrs':{}})
        value['snapshot']['tree'][2]['path'] = 'link/nested'
        with self.assertRaises(m.Blocked): self.manager.validate_entries(value)
    def test_partial_receipt(self):
        self.own('a'); self.own('b', retention='current')
        receipt = self.apply('a', 'b'); self.assertTrue(receipt['complete'])
        self.assertEqual([r['status'] for r in receipt['resources']], ['workspace-released', 'blocked'])
        self.assertTrue((self.root / 'b').exists())
    def test_process_becomes_active_after_archive(self):
        p = self.own(); plan = self.manager.plan(['old']); calls = []
        def probe(_):
            calls.append(1); return 'idle' if len(calls) == 1 else 'active'
        self.manager.probe = probe
        self.assertEqual(self.manager.apply(plan, plan['digest'])['resources'][0]['reason'], 'process-active')
        self.assertTrue(p.exists())
    def test_pause_checkpoint_resume_same_session(self):
        p = self.own('work', 'worktree'); (self.root / 'host-proof').write_text('fixture host stopped')
        record = {'session_id':'11111111-2222-4333-8444-555555555555', 'assignment':'fixture-role',
                  'workspace':'work', 'state':'paused', 'reason_code':'tool-exit', 'next_action':'retry-tested-step',
                  'pending_jobs':[], 'verified_stage':'source-saved'}
        checkpoint = self.manager.checkpoint('work', record)
        reopened = m.Manager(self.root, probe=lambda _: 'idle')
        self.assertEqual(reopened.registry()['resources']['work']['checkpoint'], checkpoint)
        self.assertEqual(reopened.plan(['work'])['resources'][0]['reason'], 'owner-paused')
        resume = {k: checkpoint[k] for k in ('session_id','workspace','assignment')}
        resume.update(checkpoint_digest=checkpoint['digest'], host_state='failed', host_evidence='host-proof')
        preparation = reopened.prepare_resume('work', resume)
        self.assertEqual(preparation['action'], 'pm-resume-same-session'); self.assertFalse(preparation['executed'])
        for field, value in [('session_id','wrong'), ('workspace','other'), ('checkpoint_digest','stale'), ('host_state','unknown')]:
            with self.assertRaises(m.Blocked): reopened.prepare_resume('work', {**resume, field:value})
        self.assertEqual(reopened.prepare_resume('work', {**resume,'host_state':'running'})['action'], 'keep-existing-writer')
        self.assertEqual(reopened.prepare_resume('work', {**resume,'host_state':'completed'})['action'], 'collect-existing-delivery')
        reopened.probe = lambda _: 'active'
        with self.assertRaisesRegex(m.Blocked, 'writer-not-proven-idle'): reopened.prepare_resume('work', resume)
        (p / 'new').write_text('new checkpoint required')
        with self.assertRaisesRegex(m.Blocked, 'source-stale'): reopened.prepare_resume('work', resume)
        self.assertTrue((p / 'tracked').exists())
    @unittest.skipUnless(sys.platform == 'darwin' and Path('/usr/bin/codesign').exists(), 'local macOS codesign fixture')
    def test_signed_app_restoration(self):
        import plistlib
        app = self.own('signed.app')
        (app / 'file').unlink(); contents = app / 'Contents'; executable = contents / 'MacOS/Fixture'
        executable.parent.mkdir(parents=True); shutil.copyfile('/bin/echo', executable); executable.chmod(0o755)
        (contents / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleExecutable':'Fixture','CFBundleIdentifier':'local.fixture.resource','CFBundleName':'Fixture','CFBundleVersion':'1','CFBundlePackageType':'APPL'}))
        vendor = contents / 'Resources/Vendor.framework/Versions/A'; vendor.mkdir(parents=True); (vendor / 'data').write_bytes(b'vendor fixture')
        os.symlink('A', vendor.parent / 'Current'); os.symlink('Versions/Current/data', vendor.parent.parent / 'data')
        m.run(['/usr/bin/codesign','--force','--deep','--sign','-',str(app)])
        m.run(['/usr/bin/codesign','--verify','--deep',str(app)])
        receipt = self.apply('signed.app')['resources'][0]
        self.assertEqual(receipt['status'],'workspace-released',receipt)
        self.assertTrue(receipt['proof']['codesign_verified'])
        self.manager.restore(receipt['archive'],'restored/signed.app')
        m.run(['/usr/bin/codesign','--verify','--deep',str(self.root/'restored/signed.app')])
        self.assertEqual(os.readlink(self.root/'restored/signed.app/Contents/Resources/Vendor.framework/Versions/Current'),'A')
    def test_actual_local_installer_copies_cli(self):
        install = self.root / 'installed-kit'
        result = subprocess.run(['bash',str(SOURCE/'install.sh'),str(install),'--no-start','--project',str(self.root)],cwd=self.root,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        entry = install/'scripts/shipboss-resources.py'
        self.assertTrue(entry.is_file())
        self.assertTrue((install/'references/resource-lifecycle.md').is_file())
        for args in (['--help'],['--root',str(self.root),'plan']):
            result = subprocess.run([sys.executable,str(entry),*args],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
    def test_paused_blocked_waiting_unknown_are_protected(self):
        for state in ('paused','blocked','waiting','unknown'):
            self.own(state, owner_state=state)
        self.assertTrue(all(r['action']=='blocked' for r in self.manager.plan()['resources']))
    def test_acceptance_scope_and_changed_source(self):
        p = self.own('work', 'worktree'); (self.root / 'proof').write_text('fixture proof')
        scope = {'files':[{'source':'tracked','target':'tracked'}]}
        self.manager.accept('work','proof', scope)
        with self.assertRaisesRegex(m.Blocked,'accepted-scope'): self.manager.integrate('work', {'files':[]}, 'proof')
        (p / 'tracked').write_text('changed after acceptance')
        with self.assertRaisesRegex(m.Blocked,'accepted-source-stale'): self.manager.integrate('work', scope, 'proof')
    def test_installed_cli_self_contained(self):
        target = self.root / 'installed/scripts'; target.mkdir(parents=True)
        shutil.copy2(SOURCE / 'scripts/shipboss-resources.py', target / 'shipboss-resources.py')
        entry = target / 'shipboss-resources.py'
        for args in (['--help'], ['--root', str(self.root), 'plan']):
            result = subprocess.run([sys.executable, str(entry), *args], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.manager.home.exists())

if __name__ == '__main__': unittest.main(verbosity=2)
