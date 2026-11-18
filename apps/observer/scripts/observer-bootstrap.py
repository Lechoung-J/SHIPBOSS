#!/usr/bin/env python3
"""Portable, offline observer entry. Text skills invoke this; it is not a host hook."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


def observer_app(home):
    home = Path(home).expanduser().resolve()
    return home if (home / 'scripts/observer-service.py').is_file() else home / 'apps/observer'


def resolve_home(explicit=None):
    # A broken explicit override is an error; never silently use a different app.
    override = explicit or os.environ.get('SHIPBOSS_OBSERVER_HOME')
    if override:
        app = observer_app(override)
        if not (app / 'scripts/observer-service.py').is_file():
            raise ValueError('observer-home has no runtime: ' + str(app))
        return app
    here = Path(__file__).resolve()
    for base in (here.parent.parent, here.parent.parent / 'observer'):
        if (base / 'scripts/observer-service.py').is_file():
            return base
    config = here.parent.parent / 'observer-config.json'
    if config.is_file():
        data = json.loads(config.read_text())
        value = data.get('observer_home')
        if isinstance(value, str) and value:
            candidate = Path(value).expanduser()
            return resolve_home(str(candidate if candidate.is_absolute() else config.parent / candidate))
    raise ValueError('runtime missing; install observer assets or set SHIPBOSS_OBSERVER_HOME')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', nargs='?', default='start', choices=['start', 'show', 'stop', 'status', 'check'])
    parser.add_argument('--observer-home')
    args, rest = parser.parse_known_args(argv)
    app = resolve_home(args.observer_home)
    config = Path(__file__).resolve().parent.parent / 'observer-config.json'
    if config.is_file() and not os.environ.get('SHIPBOSS_ELECTRON_BINARY'):
        binary = json.loads(config.read_text()).get('electron_binary')
        if binary:
            os.environ['SHIPBOSS_ELECTRON_BINARY'] = binary
    return subprocess.run([sys.executable, str(app / 'scripts/observer-service.py'), args.action, *rest],
                          env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}).returncode


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        print(json.dumps({'ready': False, 'diagnostic': str(exc)}), file=sys.stderr)
        raise SystemExit(1)
