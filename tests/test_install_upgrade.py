"""Complete installation and reversible owned-file updates in synthetic destinations."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('installer', ROOT/'apps/observer/scripts/observer-install.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class InstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve(); self.dest = self.root/'installed'
        self.project = self.root/'project'; self.project.mkdir()
        self.env = {**os.environ, 'PYTHONDONTWRITEBYTECODE':'1'}
        for key in ('DSH_SESSION_ID','CODEX_THREAD_ID','CLAUDE_SESSION_ID','SHIPBOSS_OBSERVER_HOME'): self.env.pop(key,None)
    def run_install(self, source=ROOT, dest=None, harness='generic'):
        result = subprocess.run([sys.executable,str(ROOT/'apps/observer/scripts/observer-install.py'),
          '--skill-source',str(source),'--destination',str(dest or self.dest),'--skill-harness',harness,
          '--project',str(self.project),'--no-start'],env=self.env,capture_output=True,text=True,timeout=40)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        return json.loads(result.stdout)
    def test_root_complete_selfcheck_and_installed_bootstrap(self):
        p=subprocess.run(['bash',str(ROOT/'install.sh'),str(self.dest),'--no-start'],env=self.env,capture_output=True,text=True,timeout=40)
        self.assertEqual(p.returncode,0,p.stdout+p.stderr)
        for name in ('SKILL.md','LICENSE','verify.sh','scripts/shipboss-resources.py','scripts/observer.sh'):
            self.assertTrue((self.dest/name).is_file(),name)
        p=subprocess.run(['bash',str(self.dest/'verify.sh')],capture_output=True,text=True);self.assertEqual(p.returncode,0,p.stdout+p.stderr)
        for harness in ('codex','claude','dsh'):
            out=self.root/harness;self.run_install(source=self.dest,dest=out,harness=harness)
            text=(out/'SKILL.md').read_text();self.assertIn('name: shipboss',text)
            self.assertIn(module.__name__[:0]+'--harness '+harness,text)
            self.assertTrue((out/'verify.sh').is_file())
        receipt=json.loads((self.dest/'observer-install-manifest.json').read_text());self.assertFalse(receipt['readiness']['ready'])
    def legacy(self):
        self.run_install()
        (self.dest/'docs/banner.png').write_bytes(b'legacy owned banner')
        # A recognized prior product records this exact old asset, not just its name.
        record=json.loads((self.dest/'SOURCE.json').read_text())
        record['files'].append({'path':'docs/banner.png','sha256':module.hashlib.sha256(b'legacy owned banner').hexdigest()})
        record.pop('record_digest',None)
        record['record_digest']=module.record_digest(record)
        (self.dest/'SOURCE.json').write_text(json.dumps(record))
        receipt=json.loads((self.dest/'observer-install-manifest.json').read_text());receipt['files']=record['files']
        (self.dest/'observer-install-manifest.json').write_text(json.dumps(receipt))
        (self.dest/'notes.txt').write_text('user customization')
        (self.dest/'observer-config.json').write_text('{"version":1,"user_option":true}')
        prefs=self.dest/'observer/artifacts/runtime/shipboss-observer/preferences.json';prefs.parent.mkdir(parents=True);prefs.write_text('{"collected":["example"]}')
        return prefs
    def test_owned_upgrade_preserves_user_state_and_repeats(self):
        prefs=self.legacy();config=(self.dest/'observer-config.json').read_bytes()
        r=self.run_install();self.assertFalse((self.dest/'docs/banner.png').exists())
        self.assertEqual((self.dest/'notes.txt').read_text(),'user customization')
        self.assertEqual((self.dest/'observer-config.json').read_bytes(),config)
        self.assertEqual(prefs.read_text(),'{"collected":["example"]}')
        backup=Path(r['upgrade']['backup']);self.assertTrue((backup/'files/docs/banner.png').exists())
        self.assertEqual(json.loads((self.dest/'SOURCE.json').read_text())['product'],'Shipboss')
        source1=(self.dest/'SOURCE.json').read_bytes();self.run_install();self.assertEqual((self.dest/'SOURCE.json').read_bytes(),source1)
    def test_promotion_failure_rolls_back(self):
        self.legacy();before={p.relative_to(self.dest).as_posix():p.read_bytes() for p in self.dest.rglob('*') if p.is_file()}
        args=module.argparse.Namespace(destination=str(self.dest),project_skill=None,skill_source=str(ROOT),skill_harness='dsh',project=str(self.project),no_start=True,with_observer=False,observer_home=None,renderer_dist=None,electron_binary=None)
        original=module.os.replace;count=[0]
        def fail(src,dst):
            count[0]+=1
            if count[0]==4:raise OSError('synthetic promotion interruption')
            return original(src,dst)
        with patch.object(module.os,'replace',side_effect=fail):
            with self.assertRaisesRegex(OSError,'synthetic'):module.install(args)
        after={p.relative_to(self.dest).as_posix():p.read_bytes() for p in self.dest.rglob('*') if p.is_file()}
        self.assertEqual(before,after)
        self.run_install()
    def test_bad_digest_never_updates_destination(self):
        self.legacy();before=(self.dest/'SOURCE.json').read_bytes()
        source=self.root/'source';source.mkdir();m=json.loads((ROOT/'PUBLIC-FILES.json').read_text())
        # Explicit complete kit files only; inject an unreviewed change into one owned file.
        for name in set(m['skill_files'])|{'verify.sh','install.sh','.gitignore'}:
            p=source/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes((ROOT/name).read_bytes())
        (source/'PROTOCOL.md').write_text('changed')
        result=subprocess.run([sys.executable,str(ROOT/'apps/observer/scripts/observer-install.py'),'--skill-source',str(source),'--destination',str(self.dest),'--no-start'],capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0);self.assertEqual((self.dest/'SOURCE.json').read_bytes(),before)
    def test_destination_symlink_and_traversal_rejected(self):
        outside=self.root/'outside';outside.mkdir();self.dest.symlink_to(outside,target_is_directory=True)
        for dest in (self.dest,self.root/'a/../outside'):
            p=subprocess.run([sys.executable,str(ROOT/'apps/observer/scripts/observer-install.py'),'--skill-source',str(ROOT),'--destination',str(dest),'--no-start'],capture_output=True,text=True)
            self.assertNotEqual(p.returncode,0,p.stdout)
        self.assertEqual(list(outside.iterdir()),[])
    def snapshot(self):
        return {p.relative_to(self.dest).as_posix():(p.read_bytes(),p.stat().st_mode & 0o777) for p in self.dest.rglob('*') if p.is_file()}
    def force_upgrade(self):
        return subprocess.run(['bash',str(ROOT/'install.sh'),str(self.dest),'--force','--no-start'],env=self.env,capture_output=True,text=True,timeout=40)
    def test_unknown_source_and_user_banner_block_before_update(self):
        self.legacy()
        (self.dest/'docs/banner.png').write_bytes(b'USER CREATED ARTWORK')
        for value in ('{"schema":99,"owner":"user"}', '{broken', '{"schema":99,"product":"Shipboss","edition":"public"}'):
            (self.dest/'SOURCE.json').write_text(value)
            before=self.snapshot();result=self.force_upgrade()
            self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertEqual(self.snapshot(),before)
    def test_modified_retired_banner_is_preserved_and_not_claimed(self):
        self.legacy();(self.dest/'docs/banner.png').write_bytes(b'USER CREATED ARTWORK')
        receipt=self.run_install()
        self.assertEqual((self.dest/'docs/banner.png').read_bytes(),b'USER CREATED ARTWORK')
        self.assertIn('docs/banner.png',receipt['upgrade']['preserved_unowned'])
        self.assertNotIn('docs/banner.png',{x['path'] for x in receipt['files']})
        self.run_install();self.assertEqual((self.dest/'docs/banner.png').read_bytes(),b'USER CREATED ARTWORK')
    def test_unowned_banner_without_prior_record_stays(self):
        self.dest.mkdir();(self.dest/'docs').mkdir();(self.dest/'docs/banner.png').write_bytes(b'USER CREATED ARTWORK')
        self.run_install();self.assertEqual((self.dest/'docs/banner.png').read_bytes(),b'USER CREATED ARTWORK')
    def test_modified_owned_target_and_stale_record_block(self):
        self.legacy();(self.dest/'PROTOCOL.md').write_text('user modified protocol')
        before=self.snapshot();result=self.force_upgrade();self.assertNotEqual(result.returncode,0);self.assertEqual(self.snapshot(),before)
    def test_source_record_digest_and_installed_manifest_mismatch_block(self):
        self.legacy()
        record=json.loads((self.dest/'SOURCE.json').read_text());record['files'][0]['sha256']='0'*64
        (self.dest/'SOURCE.json').write_text(json.dumps(record))
        before=self.snapshot();self.assertNotEqual(self.force_upgrade().returncode,0);self.assertEqual(self.snapshot(),before)
    def test_previous_r1_bound_record_upgrades(self):
        self.legacy();record=json.loads((self.dest/'SOURCE.json').read_text());record.pop('schema');record.pop('record_digest')
        (self.dest/'SOURCE.json').write_text(json.dumps(record))
        self.run_install();self.assertFalse((self.dest/'docs/banner.png').exists())
        self.assertEqual(json.loads((self.dest/'SOURCE.json').read_text())['schema'],1)
if __name__=='__main__':unittest.main(verbosity=2)
