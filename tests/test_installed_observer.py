"""Installed-root observer payload refresh and corrupt Electron boundaries."""
from pathlib import Path
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

class InstalledObserverTests(unittest.TestCase):
    def test_source_self_refresh_and_second_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            dist = root / 'renderer'; dist.mkdir(); (dist / 'widget.html').write_text('<p>fixture</p>')
            target = root / 'installed'
            env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}
            for name in ('DSH_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_SESSION_ID'):
                env.pop(name, None)
            def install(entry, source, dest, extra=()):
                result = subprocess.run([sys.executable, str(entry), '--skill-source', str(source),
                    '--destination', str(dest), '--with-observer', '--no-start', *extra],
                    env=env, capture_output=True, text=True, timeout=40)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                return json.loads(result.stdout)
            install(ROOT / 'apps/observer/scripts/observer-install.py', ROOT, target,
                    ['--renderer-dist', str(dist)])
            prefs = target / 'observer/artifacts/runtime/user/preferences.json'
            prefs.parent.mkdir(parents=True); prefs.write_text('{"collected":["user"]}')
            custom = target / 'docs/banner.png'; custom.write_bytes(b'USER CREATED ARTWORK')
            install(target / 'scripts/observer-install.py', target, target)
            self.assertEqual(prefs.read_text(), '{"collected":["user"]}')
            self.assertEqual(custom.read_bytes(), b'USER CREATED ARTWORK')
            second = root / 'second'
            install(target / 'scripts/observer-install.py', target, second)
            for dest in (target, second):
                self.assertTrue((dest / 'observer/runtime/observer_state.py').is_file())
                self.assertTrue((dest / 'observer/scripts/electron-health.py').is_file())
                self.assertTrue((dest / 'observer/dist/widget.html').is_file())
    def test_partial_native_app_fails_before_execution(self):
        spec = importlib.util.spec_from_file_location('health', ROOT / 'apps/observer/scripts/electron-health.py')
        health = importlib.util.module_from_spec(spec); spec.loader.exec_module(health)
        with tempfile.TemporaryDirectory() as temporary:
            app = Path(temporary) / 'Electron.app'
            executable = app / 'Contents/MacOS/Electron'; executable.parent.mkdir(parents=True)
            executable.write_text('#!/bin/sh\necho v41.0.0\n'); executable.chmod(0o755)
            (app / 'Contents/Info.plist').write_text('fixture')
            result = health.check(executable)
            self.assertFalse(result['healthy'])
            self.assertIn('electron-framework-missing-or-truncated', result['issues'])
            self.assertIsNone(result['actual_version'])

if __name__ == '__main__': unittest.main(verbosity=2)
