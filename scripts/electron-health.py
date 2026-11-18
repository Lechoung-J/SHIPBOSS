#!/usr/bin/env python3
"""Check the actual Electron executable and native bundle without downloading."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def check(binary, expected='41.0.0'):
    path = Path(binary).expanduser().resolve()
    issues = []
    if not path.is_file() or not os.access(path, os.X_OK):
        issues.append('electron-executable-missing')
    app = next((p for p in path.parents if p.suffix == '.app'), None)
    if sys.platform == 'darwin' and app:
        framework = app / 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'
        if not framework.is_file() or framework.stat().st_size < 1024 * 1024:
            issues.append('electron-framework-missing-or-truncated')
        if not (app / 'Contents/Info.plist').is_file():
            issues.append('electron-bundle-plist-missing')
    version = None
    if not issues:
        env = dict(os.environ)
        env.pop('ELECTRON_RUN_AS_NODE', None)
        try:
            result = subprocess.run([str(path), '--version'], env=env, capture_output=True,
                                    text=True, timeout=10)
            match = re.fullmatch(r'v?(\d+\.\d+\.\d+)', result.stdout.strip())
            if result.returncode or not match:
                issues.append('electron-version-probe-failed')
            else:
                version = match.group(1)
                if version != expected:
                    issues.append('electron-version-mismatch')
        except (OSError, subprocess.SubprocessError):
            issues.append('electron-version-probe-failed')
    return {'healthy': not issues, 'expected_version': expected, 'actual_version': version,
            'issues': issues, 'repair': 'Preserve the first install log. Inspect the pinned electron package and its install.js; run that official installer explicitly once, then rerun check:electron. No download or cache repair is performed by this check.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary')
    parser.add_argument('--expected', default='41.0.0')
    args = parser.parse_args()
    result = check(args.binary, args.expected)
    print(json.dumps(result))
    return 0 if result['healthy'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
