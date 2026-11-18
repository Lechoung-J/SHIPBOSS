#!/usr/bin/env python3
"""Install observer launchers and optional runtime assets using only local files."""
import argparse
import contextlib
import copy
import io
import tempfile
import uuid
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
APP = HERE.parent
LAUNCHER = '''#!/usr/bin/env bash
set -eu
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$#" -eq 0 ]; then set -- start; fi
exec python3 "$HERE/observer-bootstrap.py" "$@"
'''
SHIM = '''#!/usr/bin/env python3
"""Use the canonical runtime; no local role inference."""
import importlib.util
from pathlib import Path
import runpy
import sys
entry = Path(__file__).resolve().with_name('observer-bootstrap.py')
spec = importlib.util.spec_from_file_location('observer_bootstrap', entry)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
try:
    app = bootstrap.resolve_home()
except (ValueError, OSError) as exc:
    raise SystemExit(str(exc))
sys.path.insert(0, str(app / 'runtime'))
runpy.run_path(str(app / 'runtime/runtime.py'), run_name='__main__')
'''



def payload_app(source=None, explicit=None):
    """Resolve only the named source layout, never an ancestor search."""
    candidates = []
    if explicit:
        value = Path(explicit).expanduser().resolve()
        candidates.extend((value, value / 'apps/observer', value / 'observer'))
    if source:
        value = Path(source).expanduser().resolve()
        candidates.extend((value / 'apps/observer', value / 'observer'))
    candidates.extend((APP, APP / 'observer'))
    for candidate in candidates:
        if ((candidate / 'runtime/observer_state.py').is_file()
                and (candidate / 'desktop/main.cjs').is_file()
                and (candidate / 'scripts/observer-service.py').is_file()):
            return candidate
    raise ValueError('observer payload missing; provide a complete source or installed observer home')


def write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def install_payload(args):
    if args.project_skill:
        if not args.skill_source:
            raise ValueError('--project-skill requires a complete --skill-source')
        base = Path(args.project).expanduser().resolve()
        platform = '.claude' if args.project_skill == 'claude' else '.agents'
        dest = base / platform / 'skills/shipboss'
        args.skill_harness = args.project_skill
    else:
        if not args.destination:
            raise ValueError('--destination or --project-skill is required')
        dest = Path(args.destination).expanduser().resolve()
    dest.mkdir(parents=True, exist_ok=True)
    release = None
    if args.skill_source:
        import importlib.util
        spec = importlib.util.spec_from_file_location('shipboss_skill', HERE / 'shipboss-skill.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        release = module.build_skill(args.skill_source, dest, args.skill_harness)
        kit = APP.parents[1]
        for filename in ('PROTOCOL.md', 'PROTOCOL.zh-CN.md', 'LICENSE', 'README.md', 'README.zh-CN.md'):
            original = kit / filename
            if not (dest / filename).exists() and original.is_file():
                shutil.copy2(original, dest / filename)
        for reference in (dest / 'references').glob('*.md'):
            text = reference.read_text().replace('../apps/observer/runtime/README.md', 'observer-runtime.md')
            reference.write_text(text)
        for filename in ('observer-install.py', 'shipboss-skill.py'):
            target = dest / 'scripts' / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            if (HERE / filename).resolve() != target.resolve():
                shutil.copy2(HERE / filename, target)
    scripts = dest / 'scripts'
    scripts.mkdir(exist_ok=True)
    kit = HERE.parent if (HERE.parent / 'PUBLIC-FILES.json').is_file() else APP.parents[1]
    kit_manifest = kit / 'PUBLIC-FILES.json'
    if kit_manifest.is_file():
        public_files = {item['path']: item['sha256'] for item in json.loads(kit_manifest.read_text())['files']}
        for name in ('scripts/shipboss-resources.py', 'references/resource-lifecycle.md', 'references/resource-lifecycle.zh-CN.md', 'references/resource-closure-skill.md'):
            original = kit / name
            if name not in public_files or original.is_symlink() or hashlib.sha256(original.read_bytes()).hexdigest() != public_files[name]:
                raise ValueError('resource kit digest mismatch')
            target = dest / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if original.resolve() != target.resolve():
                shutil.copy2(original, target)
    if (HERE / 'observer-bootstrap.py').resolve() != (scripts / 'observer-bootstrap.py').resolve():
        shutil.copy2(HERE / 'observer-bootstrap.py', scripts / 'observer-bootstrap.py')
    health_source = HERE / 'electron-health.py'
    if health_source.is_file() and health_source.resolve() != (scripts / 'electron-health.py').resolve():
        shutil.copy2(health_source, scripts / 'electron-health.py')
    write(scripts / 'observer.sh', LAUNCHER)
    write(scripts / 'observer_runtime.py', SHIM)
    for path in scripts.iterdir():
        if path.name in ('observer.sh', 'observer-bootstrap.py', 'observer_runtime.py'):
            path.chmod(0o755)
    config = {'version': 1, 'trigger': 'text-skill-instruction; not a host hook'}
    source_config = Path(args.skill_source) / 'observer-config.json' if args.skill_source else None
    if source_config and source_config.is_file() and not args.electron_binary:
        inherited = json.loads(source_config.read_text()).get('electron_binary')
        if isinstance(inherited, str):
            config['electron_binary'] = inherited
    if args.with_observer:
        source_app = payload_app(args.skill_source, args.observer_home)
        runtime = dest / 'observer'
        if runtime == source_app or source_app.is_relative_to(runtime) or runtime.is_relative_to(source_app):
            raise ValueError('runtime destination must be separate from source app')
        for folder in ('runtime', 'desktop'):
            shutil.copytree(source_app / folder, runtime / folder, dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns('__pycache__', '*.pyc', 'node_modules', 'activity-preview.json'))
        renderer = Path(args.renderer_dist).resolve() if args.renderer_dist else source_app / 'dist'
        if not (renderer / 'widget.html').is_file():
            raise ValueError('renderer dist missing; build offline first or pass --renderer-dist')
        shutil.copytree(renderer, runtime / 'dist', dirs_exist_ok=True)
        for name in ('observer-service.py', 'observer-bootstrap.py', 'electron-health.py'):
            (runtime / 'scripts').mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_app / 'scripts' / name, runtime / 'scripts' / name)
        config['observer_home'] = 'observer'
    elif args.observer_home:
        config['observer_home'] = str(Path(args.observer_home).expanduser().resolve())
    # Generated config can reference this machine. Distributed scripts do not.
    if args.electron_binary:
        binary = Path(args.electron_binary).expanduser().resolve()
        if not binary.is_file() or not os.access(binary, os.X_OK):
            raise ValueError('existing Electron executable missing')
        if '.app/' in str(binary):
            health = subprocess.run([sys.executable, str(HERE / 'electron-health.py'), str(binary)], capture_output=True, text=True, timeout=15)
            if health.returncode:
                raise ValueError('Electron health check failed: ' + health.stdout.strip())
        config['electron_binary'] = str(binary)
    write(dest / 'observer-config.json', json.dumps(config, indent=2) + '\n')
    command = [sys.executable, str(scripts / 'observer-bootstrap.py')]
    check = subprocess.run([*command, 'check'], capture_output=True, text=True,
                           env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}, timeout=20)
    try:
        readiness = json.loads(check.stdout or check.stderr)
    except ValueError:
        readiness = {'ready': False, 'diagnostic': (check.stdout + check.stderr)[-1000:]}
    startup = {'attempted': False, 'reason': 'no-start' if args.no_start else 'first skill load requires a verified session'}
    selected_harness = args.skill_harness if args.skill_harness != 'generic' else ('codex' if os.environ.get('CODEX_THREAD_ID') else 'claude' if os.environ.get('CLAUDE_SESSION_ID') else 'dsh')
    session_env = {'dsh': 'DSH_SESSION_ID', 'codex': 'CODEX_THREAD_ID', 'claude': 'CLAUDE_SESSION_ID'}[selected_harness]
    if not args.no_start and readiness.get('ready') and os.environ.get(session_env):
        result = subprocess.run([*command, 'start', '--harness', selected_harness, '--project', str(Path(args.project).resolve())],
                                capture_output=True, text=True, timeout=45)
        startup = {'attempted': True, 'exit_code': result.returncode,
                   'output': (result.stdout + result.stderr).strip()[-4000:]}
    manifest = []
    for path in sorted(dest.rglob('*')):
        relative = path.relative_to(dest)
        if (path.is_file() and not path.is_symlink() and path.name != 'observer-install-manifest.json'
                and not set(relative.parts) & {'node_modules', 'artifacts', '__pycache__'} and path.suffix != '.pyc'):
            manifest.append({'path': str(relative), 'bytes': path.stat().st_size,
                             'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    receipt = {'version': 1, 'destination': str(dest), 'release': release, 'readiness': readiness,
               'startup': startup, 'files': manifest}
    write(dest / 'observer-install-manifest.json', json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, ensure_ascii=False))
    # Protocol remains installed even when the optional observer lacks dependencies.
    return 0


def safe_path(root, name):
    parts = name.split('/')
    if Path(name).is_absolute() or any(p in ('', '.', '..') for p in parts) or '\\' in name:
        raise ValueError('invalid owned path')
    target = root / name
    for part in (target, *target.parents):
        if part.is_symlink():
            raise ValueError('installation symlink rejected')
    return target


def record_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def prior_ownership(dest):
    """Recognize content-bound installed records, never a filename alone."""
    source = safe_path(dest, 'SOURCE.json')
    if not source.exists():
        return {}, False
    if not source.is_file():
        raise ValueError('source ownership conflict')
    try:
        value = json.loads(source.read_text())
        if (not isinstance(value, dict) or value.get('product') != 'Shipboss'
                or value.get('edition') != 'public' or value.get('schema', 1) != 1
                or not isinstance(value.get('manifest_sha256'), str)
                or len(value['manifest_sha256']) != 64
                or any(c not in '0123456789abcdef' for c in value['manifest_sha256'])):
            raise ValueError('unrecognized source record')
        if 'schema' in value:
            if type(value['schema']) is not int or value['schema'] != 1 or 'record_digest' not in value:
                raise ValueError('unsupported or incomplete source schema')
        elif set(value) != {'product', 'edition', 'manifest_sha256', 'files'}:
            raise ValueError('unrecognized legacy source record')
        if 'record_digest' in value:
            unsigned = {k: v for k, v in value.items() if k != 'record_digest'}
            if value['record_digest'] != record_digest(unsigned):
                raise ValueError('source record binding mismatch')
        rows = value['files']; owned = {}
        if not isinstance(rows, list) or not rows:
            raise ValueError('source record has no owned files')
        for row in rows:
            name, digest = row['path'], row['sha256']
            safe_path(dest, name)
            if name in owned or not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
                raise ValueError('invalid ownership binding')
            owned[name] = digest
        # R1 records lack a self-digest. Their installed manifest must still match
        # its recorded digest before that prior mapping is accepted.
        manifest = safe_path(dest, 'PUBLIC-FILES.json')
        if not manifest.is_file() or hashlib.sha256(manifest.read_bytes()).hexdigest() != owned.get('PUBLIC-FILES.json'):
            raise ValueError('installed manifest binding mismatch')
        return owned, True
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError('source ownership conflict: ' + str(exc)) from exc


def install(args):
    source = Path(args.skill_source).absolute() if args.skill_source else (HERE.parent if (HERE.parent / 'SKILL.md').is_file() else APP.parents[1])
    if args.project_skill:
        project = Path(args.project).expanduser().absolute()
        dest = project / ('.claude' if args.project_skill == 'claude' else '.agents') / 'skills/shipboss'
        harness = args.project_skill
    else:
        if not args.destination:
            raise ValueError('--destination or --project-skill is required')
        dest = Path(args.destination).expanduser().absolute()
        harness = args.skill_harness
    if '..' in dest.parts or '..' in source.parts:
        raise ValueError('installation traversal rejected')
    for root in (dest, source):
        if any(p.is_symlink() for p in (root, *root.parents)):
            raise ValueError('installation symlink rejected')
    if not (source / 'SKILL.md').is_file():
        # Explicit launcher-only use remains possible for a small runtime bundle.
        return install_payload(args)
    dest.parent.mkdir(parents=True, exist_ok=True)
    prior_owned, recognized = prior_ownership(dest)
    old_receipt = safe_path(dest, 'observer-install-manifest.json')
    prior = json.loads(old_receipt.read_text()) if old_receipt.is_file() else None
    if prior is not None:
        if (not recognized or prior.get('version') != 1 or (prior.get('release') or {}).get('name') != 'shipboss'
                or {row['path']: row['sha256'] for row in prior.get('files', [])} != prior_owned):
            raise ValueError('installation receipt ownership conflict')
    retired = set()
    preserved = []
    for name in ('docs/banner.png', 'docs/banner@2x.jpg'):
        target = safe_path(dest, name)
        if target.is_file():
            if recognized and hashlib.sha256(target.read_bytes()).hexdigest() == prior_owned.get(name):
                retired.add(name)
            else:
                preserved.append(name)
    with tempfile.TemporaryDirectory(prefix='.shipboss-stage-', dir=dest.parent) as temporary:
        stage = Path(temporary)
        staged = copy.copy(args)
        staged.project_skill = None
        staged.destination = str(stage)
        staged.skill_source = str(source)
        staged.skill_harness = harness
        staged.no_start = True
        with contextlib.redirect_stdout(io.StringIO()):
            install_payload(staged)
        # Preserve user-owned config unless an explicit replacement was requested.
        config = dest / 'observer-config.json'
        explicit = args.with_observer or args.observer_home or args.electron_binary
        if config.is_file() and not explicit:
            safe_path(dest, 'observer-config.json')
            shutil.copy2(config, stage / 'observer-config.json')
        from importlib.util import spec_from_file_location, module_from_spec
        spec = spec_from_file_location('public_skill_builder', HERE / 'shipboss-skill.py')
        builder = module_from_spec(spec); spec.loader.exec_module(builder)
        names = [str(p.relative_to(stage)) for p in stage.rglob('*') if p.is_file()]
        kit = builder.refresh_manifest(stage, [n for n in names if not n.startswith('observer/') and n != 'observer-config.json'])
        check = subprocess.run(['bash', str(stage / 'verify.sh')], cwd=stage, capture_output=True, text=True, timeout=30)
        if check.returncode:
            raise ValueError('staged kit verification failed: ' + check.stdout[-1200:] + check.stderr[-1200:])
        owned = sorted(str(p.relative_to(stage)) for p in stage.rglob('*') if p.is_file() and p.name != 'observer-install-manifest.json')
        retired -= set(owned)
        # Reject unknown or modified collisions before creating a backup or changing
        # destination bytes. Config is explicitly user-owned unless replaced by flags.
        for name in owned:
            target = safe_path(dest, name)
            if target.exists():
                if not target.is_file():
                    raise ValueError('owned target is not a regular file')
                actual = hashlib.sha256(target.read_bytes()).hexdigest()
                incoming = hashlib.sha256((stage / name).read_bytes()).hexdigest()
                if name == 'observer-config.json':
                    if explicit:
                        continue
                elif actual != incoming and actual != prior_owned.get(name):
                    raise ValueError('owned file conflict: ' + name)
        # Only digest-proven prior assets are retired. Preserved unknown files are
        # reported but never copied into this installation's owned-file mapping.
        changes = sorted(set(owned) | retired | {'observer-install-manifest.json', 'SOURCE.json'})
        for name in changes:
            safe_path(dest, name)
        backup = dest.parent / '.shipboss-backups' / uuid.uuid4().hex
        if backup.parent.is_symlink():
            raise ValueError('backup parent symlink rejected')
        backup.mkdir(parents=True, mode=0o700)
        journal = {'version': 1, 'status': 'prepared', 'files': [], 'source_manifest_sha256': hashlib.sha256((source / 'PUBLIC-FILES.json').read_bytes()).hexdigest()}
        for name in changes:
            target = safe_path(dest, name)
            if target.exists() and not target.is_file():
                raise ValueError('owned target is not a regular file')
            row = {'path': name, 'existed': target.is_file()}
            if row['existed']:
                saved = backup / 'files' / name; saved.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(target, saved)
            journal['files'].append(row)
        write(backup / 'journal.json', json.dumps(journal, indent=2) + '\n')
        source_record = {'schema': 1, 'product': 'Shipboss', 'edition': 'public', 'manifest_sha256': journal['source_manifest_sha256'],
                         'files': [{'path': n, 'sha256': hashlib.sha256((stage / n).read_bytes()).hexdigest()} for n in owned if n != 'observer-config.json']}
        source_record['record_digest'] = record_digest(source_record)
        write(stage / 'SOURCE.json', json.dumps(source_record, indent=2) + '\n')
        receipt = json.loads((stage / 'observer-install-manifest.json').read_text())
        receipt.update(destination=str(dest), upgrade={'status': 'installed', 'backup': str(backup),
            'retired': sorted(retired), 'preserved_unowned': sorted(preserved),
            'replaced': [row['path'] for row in journal['files'] if row['existed'] and row['path'] not in retired]}, files=source_record['files'])
        applied = []
        try:
            dest.mkdir(exist_ok=True)
            for name in changes:
                target = safe_path(dest, name)
                staged_file = stage / name
                applied.append(name)
                if staged_file.is_file() and name != 'observer-install-manifest.json':
                    target.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(staged_file, target)
                elif target.exists():
                    target.unlink()
            journal['status'] = 'promoted'
            write(backup / 'journal.json', json.dumps(journal, indent=2) + '\n')
            command = [sys.executable, str(dest / 'scripts/observer-bootstrap.py')]
            check = subprocess.run([*command, 'check'], capture_output=True, text=True, timeout=20)
            try: receipt['readiness'] = json.loads(check.stdout or check.stderr)
            except ValueError: receipt['readiness'] = {'ready': False, 'diagnostic': 'readiness unavailable'}
            selected = harness if harness != 'generic' else ('codex' if os.environ.get('CODEX_THREAD_ID') else 'claude' if os.environ.get('CLAUDE_SESSION_ID') else 'dsh')
            session_env = {'codex': 'CODEX_THREAD_ID', 'claude': 'CLAUDE_SESSION_ID', 'dsh': 'DSH_SESSION_ID'}[selected]
            if not args.no_start and receipt['readiness'].get('ready') and os.environ.get(session_env):
                started = subprocess.run([*command, 'start', '--harness', selected, '--project', str(Path(args.project).resolve())], capture_output=True, text=True, timeout=45)
                receipt['startup'] = {'attempted': True, 'exit_code': started.returncode, 'output': (started.stdout + started.stderr)[-4000:]}
            write(dest / 'observer-install-manifest.json', json.dumps(receipt, indent=2) + '\n')
        except BaseException:
            for name in reversed(applied):
                target = safe_path(dest, name); saved = backup / 'files' / name
                if saved.is_file():
                    target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(saved, target)
                elif target.is_file(): target.unlink()
            journal['status'] = 'rolled-back'
            write(backup / 'journal.json', json.dumps(journal, indent=2) + '\n')
            raise
        print(json.dumps(receipt, ensure_ascii=False))
        return 0


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--destination')
    p.add_argument('--skill-source', help='reviewed public Shipboss source kit')
    p.add_argument('--skill-harness', choices=['generic', 'dsh', 'codex', 'claude'], default='generic')
    p.add_argument('--project-skill', choices=['codex', 'claude'], help='install only into this explicit project local Skill path')
    p.add_argument('--observer-home')
    p.add_argument('--with-observer', action='store_true')
    p.add_argument('--renderer-dist')
    p.add_argument('--electron-binary')
    p.add_argument('--no-start', action='store_true')
    p.add_argument('--project', default=os.getcwd())
    return install(p.parse_args())


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print(json.dumps({'ready': False, 'diagnostic': str(exc)}), file=sys.stderr)
        raise SystemExit(1)
