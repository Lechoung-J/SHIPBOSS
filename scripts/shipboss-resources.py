#!/usr/bin/env python3
"""Explicit local resource archive/release. Inventory and plan never write."""
import argparse
import base64
import contextlib
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time

VERSION = 1
class Blocked(ValueError):
    pass

def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()

def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()

def load(path):
    return json.loads(Path(path).read_text())

def atomic(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.parent.resolve() != path.parent or path.is_symlink(): raise Blocked('atomic-path-symlink')
    fd, name = tempfile.mkstemp(prefix='.write-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(encoded(value) + b'\n'); stream.flush(); os.fsync(stream.fileno())
        os.chmod(name, 0o600)
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)

def run(args, cwd=None, check=True):
    result = subprocess.run(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'}, timeout=120)
    if check and result.returncode:
        raise Blocked('command-failed: ' + str(args[0]))
    return result

def git(path, *args):
    return run(['git', '-c', 'core.hooksPath=/dev/null', '-C', str(path), *args]).stdout

def relative(value):
    if not isinstance(value, str) or not value or '\\' in value:
        raise Blocked('invalid-relative-path')
    p = PurePosixPath(value)
    if p.is_absolute() or any(x in ('', '.', '..') for x in value.split('/')):
        raise Blocked('path-escape')
    return p

def beneath(path, base):
    return path == base or base in path.parents

_ACL_LIBRARY = None

def acl_status(path):
    """Inspect the entry itself. Never follow a dependency/framework symlink.

    Darwin acl_get_link_np(ACL_TYPE_EXTENDED) returns ENOENT for an entry
    with no extended ACL. Require lstat before/after to distinguish that
    result from a missing or replaced path. Any available ACL is unsupported.
    Other platforms and failed native probes remain unknown.
    """
    global _ACL_LIBRARY
    if sys.platform != 'darwin': return 'unknown'
    try:
        before = Path(path).lstat()
        if _ACL_LIBRARY is None:
            library = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
            library.acl_get_link_np.argtypes = [ctypes.c_char_p, ctypes.c_int]
            library.acl_get_link_np.restype = ctypes.c_void_p
            library.acl_free.argtypes = [ctypes.c_void_p]
            library.acl_free.restype = ctypes.c_int
            _ACL_LIBRARY = library
        ctypes.set_errno(0)
        pointer = _ACL_LIBRARY.acl_get_link_np(os.fsencode(path), 0x100)
        code = ctypes.get_errno()
        if pointer:
            if _ACL_LIBRARY.acl_free(pointer) != 0: return 'unknown'
            return 'present'
        after = Path(path).lstat()
        identity = lambda info: (info.st_dev, info.st_ino, info.st_mode, info.st_ctime_ns)
        if code == errno.ENOENT and identity(before) == identity(after): return 'absent'
    except (OSError, AttributeError, TypeError, ValueError):
        pass
    return 'unknown'

def xattrs(path):
    if not hasattr(os, 'listxattr'): return {}
    return {name: base64.b64encode(os.getxattr(path, name, follow_symlinks=False)).decode()
            for name in sorted(os.listxattr(path, follow_symlinks=False))}

def setattrs(path, attrs):
    if attrs and not hasattr(os, 'setxattr'): raise Blocked('xattrs-unsupported')
    for name, value in attrs.items():
        os.setxattr(path, name, base64.b64decode(value, validate=True), follow_symlinks=False)

def process_probe(resource):
    """Return only an occupancy verdict. Never emit process commands or tokens."""
    resource = Path(resource)
    if sys.platform == 'darwin':
        tool = shutil.which('lsof') or '/usr/sbin/lsof'
        result = run([tool, '-nP', '-Fpn', '-d', 'cwd,txt,mem'], check=False)
        if result.returncode or result.stderr.strip(): return 'unknown'
        for line in result.stdout.decode(errors='replace').splitlines():
            if line.startswith('n/') and beneath(Path(line[1:]).resolve(), resource): return 'active'
        return 'idle'
    proc = Path('/proc')
    if not proc.is_dir(): return 'unknown'
    try:
        for item in proc.iterdir():
            if not item.name.isdigit(): continue
            for part in ('cwd', 'exe'):
                try:
                    if beneath(Path(os.readlink(item / part)).resolve(), resource): return 'active'
                except FileNotFoundError: continue
                except PermissionError: return 'unknown'
            try:
                for line in (item / 'maps').read_text().splitlines():
                    fields = line.split(None, 5)
                    if len(fields) == 6 and fields[5].startswith('/') and beneath(Path(fields[5]).resolve(), resource): return 'active'
            except FileNotFoundError: continue
            except PermissionError: return 'unknown'
        return 'idle'
    except OSError:
        return 'unknown'

class Manager:
    def __init__(self, root, probe=process_probe):
        candidate = Path(root).absolute()
        if candidate.is_symlink() or candidate.resolve() != candidate: raise Blocked('root-symlink')
        self.root = candidate
        if Path(git(candidate, 'rev-parse', '--show-toplevel').decode().strip()).resolve() != candidate:
            raise Blocked('wrong-root')
        common = Path(git(candidate, 'rev-parse', '--path-format=absolute', '--git-common-dir').decode().strip()).resolve()
        if common != candidate / '.git': raise Blocked('root-must-be-main-workspace')
        self.common = common
        self.home = candidate / '.delegate/resource-ledger'
        self.probe = probe
        self.root_identity = {'path': str(candidate), 'dev': candidate.stat().st_dev, 'ino': candidate.stat().st_ino,
                              'git': str(common), 'git_ino': common.stat().st_ino}
        # Registry and CAS may never be redirected to another directory.
        for p in (candidate / '.delegate', self.home):
            if p.exists() and (p.is_symlink() or p.resolve() != p): raise Blocked('ledger-symlink')

    def registry(self):
        if not (self.home / 'registry.json').exists():
            return {'version': VERSION, 'root': self.root_identity, 'resources': {}, 'protected': []}
        value = load(self.home / 'registry.json')
        if value['root'] != self.root_identity: raise Blocked('wrong-root')
        return value

    @contextlib.contextmanager
    def locked(self):
        self.home.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock = self.home / 'lock'
        try: fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError: raise Blocked('concurrent-operation-or-stale-lock')
        try:
            os.write(fd, str(os.getpid()).encode()); os.close(fd)
            yield
        finally:
            lock.unlink()

    def checked(self, value):
        relative(value)
        p = self.root / value
        cursor = self.root
        for part in Path(value).parts:
            cursor = cursor / part
            if cursor.is_symlink(): raise Blocked('resource-path-symlink')
        if p.resolve() != p or not beneath(p, self.root): raise Blocked('path-escape')
        return p

    def protect_target(self, p, registry):
        protected = ['.git', '.delegate/resource-ledger', '.delegate/public-review',
                     '.delegate/observer-service', '.delegate/observer-state.json',
                     'apps/observer/node_modules', 'apps/observer/dist', 'apps/observer/artifacts/runtime']
        protected += registry['protected']
        for value in protected:
            target = self.root / str(relative(value))
            if beneath(p, target) or beneath(target, p): raise Blocked('protected-path')
        if git(self.root, 'ls-files', '-z', '--', str(p.relative_to(self.root))): raise Blocked('protected-main-tracked')

    def guard(self, item, registry, live=True):
        p = self.checked(item['path'])
        self.protect_target(p, registry)
        if item['retention'] != 'reclaim': raise Blocked('retained-' + item['retention'])
        if item['kind'] == 'worktree' and not item.get('integration_verified') and not item.get('archive_not_integrated', False):
            raise Blocked('integration-pending-explicit-archive-required')
        if item['owner_state'] != 'inactive': raise Blocked('owner-' + item['owner_state'])
        if not p.is_dir(): raise Blocked('source-missing-or-not-directory')
        if live:
            verdict = self.probe(p)
            if verdict != 'idle': raise Blocked('process-' + verdict)
        return p

    def adopt(self, data):
        with self.locked():
            registry = self.registry()
            for value in data.get('protected', []):
                self.checked(value)
                if value not in registry['protected']: registry['protected'].append(value)
            for item in data['resources']:
                if not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', item['id']): raise Blocked('invalid-id')
                if item['id'] in registry['resources']: raise Blocked('already-owned')
                self.checked(item['path'])
                if any(beneath(self.root / item['path'], self.root / r['path']) or
                       beneath(self.root / r['path'], self.root / item['path']) for r in registry['resources'].values()):
                    raise Blocked('overlapping-resource')
                if item['kind'] not in ('artifact', 'worktree', 'stage'): raise Blocked('invalid-kind')
                if item['retention'] not in ('reclaim', 'current', 'rollback', 'evidence'): raise Blocked('invalid-retention')
                if item['owner_state'] not in ('active', 'inactive', 'paused', 'blocked', 'waiting', 'unknown'): raise Blocked('invalid-owner-state')
                if not item.get('owner') or not item.get('task'): raise Blocked('missing-owner-task')
                for key, target in item.get('dependency_links', {}).items():
                    relative(key); self.checked(target)
                    if Path(key).name != 'node_modules' or Path(target).name != 'node_modules': raise Blocked('invalid-dependency-link')
                registry['resources'][item['id']] = {**item, 'lifecycle': 'registered'}
            atomic(self.home / 'registry.json', registry)
            return registry

    def put(self, content):
        key = hashlib.sha256(content).hexdigest()
        folder = self.home / 'objects'
        folder.mkdir(exist_ok=True, mode=0o700)
        if folder.resolve() != folder or folder.is_symlink(): raise Blocked('object-store-symlink')
        target = folder / key
        if target.exists():
            if self.blob(key) != content: raise Blocked('object-collision')
        else:
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(content); stream.flush(); os.fsync(stream.fileno())
        return key

    def blob(self, key):
        if not isinstance(key, str) or not re.fullmatch('[0-9a-f]{64}', key): raise Blocked('malformed-blob')
        p = self.home / 'objects' / key
        if p.is_symlink() or p.resolve() != p: raise Blocked('object-symlink')
        content = p.read_bytes()
        if hashlib.sha256(content).hexdigest() != key: raise Blocked('corrupt-blob')
        return content

    def tree(self, source, item, store=False):
        entries = []
        def visit(p, rel):
            info = p.lstat()
            acl = acl_status(p)
            if acl != 'absent': raise Blocked('unsupported-acl' if acl == 'present' else 'acl-probe-unknown')
            entry = {'path': rel, 'mode': stat.S_IMODE(info.st_mode), 'xattrs': xattrs(p), 'acl': 'absent'}
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(p)
                permitted = item.get('dependency_links', {}).get(rel)
                if permitted:
                    if (p.parent / target).resolve() != self.checked(permitted): raise Blocked('dependency-link-changed')
                    entry.update(type='dependency', target=target, repo_target=permitted)
                else:
                    if os.path.isabs(target) or not beneath((p.parent / target).resolve(), source): raise Blocked('external-symlink')
                    entry.update(type='symlink', target=target)
            elif stat.S_ISDIR(info.st_mode):
                entry['type'] = 'directory'
                entries.append(entry)
                for child in sorted(p.iterdir(), key=lambda x: x.name):
                    if rel == '.' and child.name == '.git' and item['kind'] == 'worktree': continue
                    visit(child, child.name if rel == '.' else rel + '/' + child.name)
                return
            elif stat.S_ISREG(info.st_mode):
                fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, 'rb') as stream:
                    before = os.fstat(stream.fileno()); content = stream.read(); after = os.fstat(stream.fileno())
                if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns): raise Blocked('source-changing')
                entry.update(type='file', size=len(content), blob=self.put(content) if store else hashlib.sha256(content).hexdigest())
            else: raise Blocked('unsupported-file-type')
            entries.append(entry)
        visit(source, '.')
        return entries

    def git_state(self, path, store=False):
        if not (path / '.git').is_file(): raise Blocked('not-linked-worktree')
        if Path(git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir').decode().strip()).resolve() != self.common:
            raise Blocked('foreign-worktree')
        if git(path, 'rev-parse', '--shared-index-path').strip(): raise Blocked('split-index-protected')
        if git(path, 'ls-files', '-u').strip(): raise Blocked('unmerged-index-protected')
        head = git(path, 'rev-parse', 'HEAD').decode().strip()
        branch = run(['git', '-C', str(path), 'symbolic-ref', '-q', 'HEAD'], check=False).stdout.decode().strip()
        index = Path(git(path, 'rev-parse', '--path-format=absolute', '--git-path', 'index').decode().strip()).read_bytes()
        data = {'head': head, 'branch': branch, 'index': hashlib.sha256(index).hexdigest()}
        for name, args in [('status', ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
                           ('stages', ['ls-files', '--stage', '-z']),
                           ('staged', ['diff', '--binary', '--cached', '--no-ext-diff']),
                           ('unstaged', ['diff', '--binary', '--no-ext-diff'])]:
            content = git(path, *args)
            data[name] = base64.b64encode(content).decode()
        if store:
            data['index_blob'] = self.put(index)
            data['index_objects'] = []
            for record in git(path, 'ls-files', '--stage', '-z').split(b'\0'):
                if not record: continue
                mode, oid, stage = record.split(b'\t', 1)[0].split()
                if mode == b'160000': raise Blocked('submodule-protected')
                data['index_objects'].append({'oid': oid.decode(), 'blob': self.put(git(path, 'cat-file', 'blob', oid.decode()))})
            with tempfile.TemporaryDirectory(dir=self.home) as tmp:
                bundle = Path(tmp) / 'history.bundle'
                git(path, 'bundle', 'create', str(bundle), 'HEAD')
                git(path, 'bundle', 'verify', str(bundle))
                data['bundle'] = self.put(bundle.read_bytes())
        return data

    def snapshot(self, item, store=False):
        source = self.checked(item['path'])
        info = source.stat()
        result = {'tree': self.tree(source, item, store), 'identity': [info.st_dev, info.st_ino]}
        if not store:
            for entry in result['tree']:
                entry['xattrs'] = {name: hashlib.sha256(base64.b64decode(value)).hexdigest() for name, value in entry['xattrs'].items()}
        if item['kind'] == 'worktree':
            result['git'] = self.git_state(source, store)
            if not store:
                for key in ('status', 'stages', 'staged', 'unstaged'):
                    result['git'][key] = hashlib.sha256(base64.b64decode(result['git'][key])).hexdigest()
        if item['kind'] == 'artifact' and source.suffix == '.app' and sys.platform == 'darwin':
            result['codesign_verified'] = run(['/usr/bin/codesign', '--verify', '--deep', str(source)], check=False).returncode == 0
        return result

    def stable(self, snapshot):
        value = json.loads(json.dumps(snapshot))
        for entry in value['tree']:
            entry['xattrs'] = {name: hashlib.sha256(base64.b64decode(content)).hexdigest() for name, content in entry['xattrs'].items()}
        if 'git' in value:
            value['git'].pop('index_blob', None); value['git'].pop('bundle', None); value['git'].pop('index_objects', None)
            for key in ('status', 'stages', 'staged', 'unstaged'):
                value['git'][key] = hashlib.sha256(base64.b64decode(value['git'][key])).hexdigest()
        return value

    def plan(self, ids=None):
        registry = self.registry(); rows = []
        for key in ids if ids is not None else sorted(registry['resources']):
            item = registry['resources'][key]
            row = {'id': key, 'resource_digest': digest(item), 'path': item['path']}
            try:
                self.guard(item, registry)
                row.update(action='archive-release', snapshot=self.snapshot(item))
            except (Blocked, OSError, subprocess.SubprocessError) as exc:
                row.update(action='blocked', reason=str(exc))
            rows.append(row)
        plan = {'version': VERSION, 'root': self.root_identity, 'registry_digest': digest(registry), 'resources': rows}
        return {**plan, 'digest': digest(plan)}

    def validate_entries(self, manifest):
        seen = set(); entries = manifest['snapshot']['tree']
        for entry in entries:
            name = entry['path']
            if name != '.': relative(name)
            if name in seen: raise Blocked('duplicate-entry')
            seen.add(name)
            if entry.get('acl') != 'absent': raise Blocked('archive-acl-proof-missing')
            if entry['type'] not in ('directory', 'file', 'symlink', 'dependency'): raise Blocked('invalid-entry-type')
            if entry['mode'] < 0 or entry['mode'] > 0o777: raise Blocked('invalid-mode')
            if name == '.' and entry['type'] != 'directory': raise Blocked('invalid-root-entry')
            if name != '.' and str(PurePosixPath(name).parent) not in seen: raise Blocked('missing-parent-entry')
            if entry['type'] in ('symlink', 'dependency'):
                target = entry['target']
                if entry['type'] == 'symlink':
                    if os.path.isabs(target): raise Blocked('absolute-symlink')
                    base = Path('/virtual')
                    if not beneath((base / name).parent.joinpath(target).resolve(), base): raise Blocked('symlink-escape')
                else:
                    if manifest['resource'].get('dependency_links', {}).get(name) != entry['repo_target']: raise Blocked('unregistered-dependency')
                    self.checked(entry['repo_target'])
            if entry['type'] == 'file':
                if len(self.blob(entry['blob'])) != entry['size']: raise Blocked('size-mismatch')
        if '.' not in seen: raise Blocked('missing-root')
        # A link must never be an ancestor of another entry.
        kinds = {e['path']: e['type'] for e in entries}
        for name in seen - {'.'}:
            for parent in PurePosixPath(name).parents:
                if str(parent) != '.' and kinds.get(str(parent)) != 'directory': raise Blocked('link-parent')

    def materialize(self, manifest, target, git_mode=None):
        self.validate_entries(manifest)
        item = manifest['resource']; snapshot = manifest['snapshot']
        if target.exists(): raise Blocked('restore-target-exists')
        if 'git' in snapshot:
            state = snapshot['git']
            if git_mode == 'linked':
                branch = state['branch']
                if branch and git(self.root, 'rev-parse', branch).decode().strip() != state['head']: raise Blocked('branch-moved')
                git(self.root, 'worktree', 'add', '--no-checkout', *([] if branch else ['--detach']), str(target), branch.removeprefix('refs/heads/') if branch else state['head'])
            else:
                target.mkdir()
                git(target, 'init', '-q')
                bundle = target / 'history.bundle'
                bundle.write_bytes(self.blob(state['bundle']))
                git(target, 'fetch', str(bundle), 'HEAD')
                bundle.unlink()
                git(target, 'update-ref', '--no-deref', 'HEAD', state['head'])
                if state['branch']: git(target, 'symbolic-ref', 'HEAD', state['branch']); git(target, 'update-ref', state['branch'], state['head'])
            # Only remove generated checkout files inside this freshly created destination.
            for child in target.iterdir():
                if child.name == '.git': continue
                if child.is_dir() and not child.is_symlink(): shutil.rmtree(child)
                else: child.unlink()
        else: target.mkdir()
        for entry in snapshot['tree']:
            p = target if entry['path'] == '.' else target / entry['path']
            kind = entry['type']
            if entry['path'] != '.':
                if kind == 'directory': p.mkdir()
                elif kind == 'file': p.write_bytes(self.blob(entry['blob']))
                elif kind == 'dependency': os.symlink(str(self.checked(entry['repo_target'])), p)
                else: os.symlink(entry['target'], p)
        for entry in reversed(snapshot['tree']):
            p = target if entry['path'] == '.' else target / entry['path']
            if entry['type'] not in ('symlink', 'dependency'): p.chmod(entry['mode'])
            setattrs(p, entry.get('xattrs', {}))
        if 'git' in snapshot:
            state = snapshot['git']
            for obj in state['index_objects']:
                with tempfile.NamedTemporaryFile(dir=self.home) as staged:
                    staged.write(self.blob(obj['blob'])); staged.flush()
                    oid = git(target, 'hash-object', '-w', staged.name).decode().strip()
                if oid != obj['oid']: raise Blocked('index-object-mismatch')
            index = Path(git(target, 'rev-parse', '--path-format=absolute', '--git-path', 'index').decode().strip())
            index.write_bytes(self.blob(state['index_blob']))
            for key, args in [('status', ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
                              ('stages', ['ls-files', '--stage', '-z']), ('staged', ['diff', '--binary', '--cached', '--no-ext-diff']),
                              ('unstaged', ['diff', '--binary', '--no-ext-diff'])]:
                if base64.b64encode(git(target, *args)).decode() != state[key]: raise Blocked('git-restore-mismatch-' + key)
            # Git can refresh index stat-cache bytes during semantic diff checks.
            # Retain the archived original index exactly after those checks.
            original_index = self.blob(state['index_blob'])
            index.write_bytes(original_index)
            if hashlib.sha256(index.read_bytes()).hexdigest() != state['index']: raise Blocked('index-byte-mismatch')
        # Compare dependency link identity without following it or requiring same relative spelling.
        actual = self.tree(target, item)
        expected = json.loads(json.dumps(snapshot['tree']))
        for collection in (actual, expected):
            for e in collection:
                if e['type'] == 'dependency': e['target'] = e['repo_target']
        if actual != expected: raise Blocked('restore-tree-mismatch')
        if snapshot.get('codesign_verified'):
            run(['/usr/bin/codesign', '--verify', '--deep', str(target)])
        return {'tree_verified': True, 'git_verified': 'git' in snapshot,
                'codesign_verified': snapshot.get('codesign_verified', False), 'xattrs': 'preserved-and-compared',
                'acl': 'absent-on-source-and-restore'}

    def archive(self, item):
        snapshot = self.snapshot(item, store=True)
        manifest = {'version': VERSION, 'root': self.root_identity, 'resource': item, 'snapshot': snapshot}
        key = digest(manifest)
        # Verify restoration before any destructive operation; no real registry worktree is created here.
        with tempfile.TemporaryDirectory(prefix='verify-', dir=self.home) as tmp:
            proof = self.materialize(manifest, Path(tmp) / ('Restored.app' if item['kind'] == 'artifact' and item['path'].endswith('.app') else 'restore'))
        atomic(self.home / 'archives' / (key + '.json'), manifest)
        return key, proof

    def archive_only(self, key):
        with self.locked():
            registry = self.registry(); item = registry['resources'][key]
            source = self.checked(item['path']); self.protect_target(source, registry)
            if item['owner_state'] != 'inactive' or self.probe(source) != 'idle': raise Blocked('owner-or-process-not-idle')
            before = self.snapshot(item)
            archive, proof = self.archive(item)
            if self.snapshot(item) != before or self.stable(self.read_archive(archive)['snapshot']) != before: raise Blocked('source-changed-during-archive')
            receipt = {'id': key, 'archive': archive, 'proof': proof, 'status': 'archived-source-retained', 'integration': 'integration-verified' if item.get('integration_verified') else 'archived-not-integrated'}
            atomic(self.home / 'archive-receipts' / (archive + '.json'), receipt)
            return receipt

    def apply(self, plan, expected):
        unsigned = {k: v for k, v in plan.items() if k != 'digest'}
        if digest(unsigned) != expected or plan.get('digest') != expected: raise Blocked('plan-digest-mismatch')
        if plan['root'] != self.root_identity: raise Blocked('wrong-root')
        with self.locked():
            receipt_path = self.home / 'receipts' / (expected + '.json')
            if receipt_path.exists(): return load(receipt_path)
            registry = self.registry()
            if digest(registry) != plan['registry_digest']: raise Blocked('plan-stale-registry')
            receipt = {'version': VERSION, 'plan': expected, 'resources': [], 'complete': False}
            atomic(receipt_path, receipt)
            for row in plan['resources']:
                result = {'id': row['id'], 'status': 'blocked'}
                try:
                    if row['action'] != 'archive-release': raise Blocked(row.get('reason', 'plan-blocked'))
                    item = registry['resources'][row['id']]
                    if digest(item) != row['resource_digest']: raise Blocked('plan-stale-owner')
                    source = self.guard(item, registry)
                    if self.snapshot(item) != row['snapshot']: raise Blocked('plan-stale-source')
                    key, proof = self.archive(item)
                    if self.stable(self.read_archive(key)['snapshot']) != row['snapshot']: raise Blocked('archive-source-mismatch')
                    # A second process and fingerprint check occurs after potentially long archive I/O.
                    self.guard(item, registry)
                    if self.snapshot(item) != row['snapshot']: raise Blocked('source-changed-during-archive')
                    result.update(archive=key, proof=proof, status='archive-verified')
                    receipt['resources'].append(result); atomic(receipt_path, receipt)
                    if item['kind'] == 'worktree':
                        state = row['snapshot']['git']; ref = 'refs/shipboss/archive/' + item['id'] + '/' + key
                        git(self.root, 'update-ref', ref, state['head'])
                        result['archive_ref'] = ref
                        git(self.root, 'worktree', 'remove', '--force', str(source))
                    else:
                        # Exact resolved path checked again immediately before removal. Never follow links.
                        if self.checked(item['path']) != source: raise Blocked('delete-path-changed')
                        retired = self.home / 'retiring'
                        retired.mkdir(exist_ok=True, mode=0o700)
                        if retired.resolve() != retired: raise Blocked('retirement-parent-symlink')
                        target = retired / (item['id'] + '-' + key)
                        if target.exists() or target.is_symlink(): raise Blocked('retirement-target-exists')
                        result.update(status='release-pending', retirement_path=str(target.relative_to(self.root)))
                        atomic(receipt_path, receipt)
                        source.rename(target)
                        info = target.lstat()
                        if target.is_symlink() or [info.st_dev, info.st_ino] != row['snapshot']['identity']:
                            if not source.exists(): target.rename(source)
                            raise Blocked('retirement-identity-changed')
                        # The source name is no longer a deletion target. A new
                        # directory created there belongs to a later invocation.
                        if self.stable({'tree': self.tree(target, item)})['tree'] != row['snapshot']['tree']:
                            if not source.exists(): target.rename(source)
                            raise Blocked('retirement-tree-changed')
                        shutil.rmtree(target)
                    item.update(archive=key, lifecycle='workspace-released', archive_state='archived' if item.get('integration_verified') else 'archived-not-integrated')
                    result['status'] = 'workspace-released'
                    atomic(self.home / 'registry.json', registry)
                except (Blocked, OSError, subprocess.SubprocessError, KeyError) as exc:
                    result.update(status='blocked', reason=str(exc))
                if not any(r is result for r in receipt['resources']): receipt['resources'].append(result)
                atomic(receipt_path, receipt)
            receipt['complete'] = True
            atomic(receipt_path, receipt)
            return receipt

    def read_archive(self, key):
        if not re.fullmatch('[0-9a-f]{64}', key): raise Blocked('invalid-archive-id')
        path = self.home / 'archives' / (key + '.json')
        if path.is_symlink(): raise Blocked('archive-symlink')
        value = load(path)
        if digest(value) != key or value['root'] != self.root_identity: raise Blocked('archive-tampered')
        return value

    def restore(self, key, destination):
        with self.locked():
            target = self.checked(destination)
            self.protect_target(target, self.registry())
            manifest = self.read_archive(key)
            self.validate_entries(manifest)
            for owned in self.registry()['resources'].values():
                owned_path = self.root / owned['path']
                if destination != manifest['resource']['path'] and (beneath(target, owned_path) or beneath(owned_path, target)):
                    raise Blocked('restore-overlaps-owned-resource')
            target.parent.mkdir(parents=True, exist_ok=True)
            self.checked(destination)
            # Never overwrite; a failed restore keeps its target for diagnosis.
            result = self.materialize(manifest, target, 'linked' if manifest['resource']['kind'] == 'worktree' else None)
            registry = self.registry(); item = registry['resources'][manifest['resource']['id']]
            if destination == item['path']:
                item['lifecycle'] = 'restored'; item['owner_state'] = 'active'
                atomic(self.home / 'registry.json', registry)
            return result

    def accept(self, key, evidence, manifest=None):
        with self.locked():
            registry = self.registry(); item = registry['resources'][key]
            item['accepted'] = self.evidence(evidence)
            item['accepted_source_digest'] = digest(self.snapshot(item))
            if manifest is not None:
                if not manifest.get('files'): raise Blocked('empty-acceptance-manifest')
                for row in manifest['files']:
                    relative(row['source']); relative(row['target'])
                item['accepted_manifest'] = manifest
            item['lifecycle'] = 'accepted'
            atomic(self.home / 'registry.json', registry)
            return item

    def evidence(self, path):
        p = self.checked(path)
        if not p.is_file(): raise Blocked('evidence-missing')
        return {'path': path, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}

    def integrate(self, key, specification, evidence):
        with self.locked():
            registry = self.registry(); item = registry['resources'][key]
            if not item.get('accepted'): raise Blocked('acceptance-required')
            if not item.get('accepted_manifest') or specification != item['accepted_manifest']: raise Blocked('accepted-scope-mismatch')
            snapshot = self.snapshot(item)
            if digest(snapshot) != item['accepted_source_digest']: raise Blocked('accepted-source-stale')
            source_entries = {e['path']: e for e in snapshot['tree']}
            rows = []
            for row in specification['files']:
                source_name = str(relative(row['source']))
                target = self.checked(row['target'])
                entry = source_entries.get(source_name)
                if row.get('deleted'):
                    if entry is not None or target.exists(): raise Blocked('integration-deletion-mismatch')
                    rows.append({'source': source_name, 'target': row['target'], 'deleted': True})
                    continue
                if not entry or entry['type'] != 'file' or not target.is_file(): raise Blocked('integration-file-missing')
                b = hashlib.sha256(target.read_bytes()).hexdigest()
                if entry['blob'] != b or entry['mode'] != stat.S_IMODE(target.stat().st_mode): raise Blocked('integration-mismatch')
                rows.append({'source': source_name, 'target': row['target'], 'sha256': b, 'mode': entry['mode']})
            if not rows: raise Blocked('empty-integration-manifest')
            item.update(integration={'kind': 'integrated-uncommitted', 'files': rows, 'evidence': self.evidence(evidence)}, lifecycle='integrated-uncommitted')
            atomic(self.home / 'registry.json', registry)
            return item

    def verify_integration(self, key, evidence):
        with self.locked():
            registry = self.registry(); item = registry['resources'][key]
            self.check_integration(item)
            item.update(integration_verified={'evidence': self.evidence(evidence), 'integration_digest': digest(item['integration'])}, lifecycle='integration-verified')
            atomic(self.home / 'registry.json', registry)
            return item

    def check_integration(self, item):
        if not item.get('integration'): raise Blocked('integration-pending')
        for row in item['integration']['files']:
            path = self.checked(row['target'])
            if row.get('deleted'):
                if path.exists(): raise Blocked('integration-stale')
                continue
            if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != row['sha256'] or stat.S_IMODE(path.stat().st_mode) != row['mode']:
                raise Blocked('integration-stale')

    def close(self, key):
        with self.locked():
            registry = self.registry(); item = registry['resources'][key]
            if not item.get('accepted') or not item.get('integration_verified'): raise Blocked('integration-pending')
            self.check_integration(item)
            if item['integration_verified']['integration_digest'] != digest(item['integration']): raise Blocked('verification-stale')
            if item['lifecycle'] not in ('workspace-released', 'closed'): raise Blocked('workspace-not-released')
            manifest = self.read_archive(item['archive'])
            with tempfile.TemporaryDirectory(dir=self.home) as tmp:
                self.materialize(manifest, Path(tmp) / ('Restored.app' if item['path'].endswith('.app') else 'restore'))
            item['lifecycle'] = 'closed'; atomic(self.home / 'registry.json', registry)
            return item

    def set_owner(self, key, record):
        with self.locked():
            registry = self.registry(); item = registry['resources'][key]
            state = record['owner_state']
            if state not in ('active','inactive','paused','blocked','waiting','unknown'): raise Blocked('invalid-owner-state')
            if item.get('session_id') and record.get('session_id') != item['session_id']: raise Blocked('session-mismatch')
            if state == 'inactive':
                if record.get('host_state') not in ('completed','stopped','failed'): raise Blocked('host-ownership-unknown')
                if item.get('checkpoint',{}).get('pending_jobs'): raise Blocked('pending-jobs-unresolved')
                if self.probe(self.checked(item['path'])) != 'idle': raise Blocked('writer-not-proven-idle')
            item.update(owner_state=state, lease_until=record.get('lease_until',item.get('lease_until',0)),
                        owner_evidence=self.evidence(record['evidence']))
            atomic(self.home / 'registry.json',registry)
            return item

    def checkpoint(self, key, record):
        import uuid
        with self.locked():
            registry = self.registry(); item = registry['resources'][key]
            session = str(uuid.UUID(record['session_id']))
            if item.get('session_id') and item['session_id'] != session: raise Blocked('session-mismatch')
            if record['workspace'] != item['path']: raise Blocked('workspace-mismatch')
            if record['state'] not in ('paused', 'blocked', 'waiting', 'unknown'): raise Blocked('invalid-checkpoint-state')
            if not record.get('assignment') or not record.get('next_action') or not record.get('reason_code'): raise Blocked('incomplete-checkpoint')
            # Diagnostics are codes and evidence hashes. No model messages, argv,
            # credential values or reasoning text are persisted by this command.
            entry = {k: record[k] for k in ('assignment', 'workspace', 'state', 'reason_code', 'next_action')}
            entry.update(session_id=session, pending_jobs=list(record.get('pending_jobs', [])),
                         verified_stage=record.get('verified_stage', 'unverified'),
                         source_digest=digest(self.snapshot(item)),
                         revision=git(self.checked(item['path']), 'rev-parse', 'HEAD').decode().strip() if item['kind'] == 'worktree' else None)
            entry['digest'] = digest(entry)
            item.update(checkpoint=entry, session_id=session, owner_state=record['state'])
            atomic(self.home / 'registry.json', registry)
            return entry

    def prepare_resume(self, key, record):
        with self.locked():
            registry = self.registry(); item = registry['resources'][key]; checkpoint = item.get('checkpoint')
            if not checkpoint: raise Blocked('checkpoint-missing')
            for field in ('session_id', 'workspace', 'assignment'):
                if record.get(field) != checkpoint[field]: raise Blocked(field + '-mismatch')
            if record.get('checkpoint_digest') != checkpoint['digest']: raise Blocked('checkpoint-stale')
            if digest(self.snapshot(item)) != checkpoint['source_digest']: raise Blocked('source-stale')
            host = record.get('host_state', 'unknown')
            if host == 'completed': action = 'collect-existing-delivery'
            elif host == 'running': action = 'keep-existing-writer'
            elif host in ('stopped', 'failed'):
                if checkpoint['pending_jobs']: raise Blocked('pending-jobs-unresolved')
                if self.probe(self.checked(item['path'])) != 'idle': raise Blocked('writer-not-proven-idle')
                action = 'pm-resume-same-session'
            else: raise Blocked('host-ownership-unknown')
            result = {'action': action, 'session_id': checkpoint['session_id'], 'assignment': checkpoint['assignment'],
                      'workspace': checkpoint['workspace'], 'checkpoint_digest': checkpoint['digest'],
                      'source_digest': checkpoint['source_digest'], 'host_evidence': self.evidence(record['host_evidence']),
                      'executed': False, 'requires_fresh_verification': True}
            item['resume_preparation'] = result
            atomic(self.home / 'registry.json', registry)
            return result

    def inventory(self):
        registry = self.registry(); output = []
        active = sum(r['owner_state'] == 'active' for r in registry['resources'].values())
        for item in registry['resources'].values():
            row = dict(item)
            if item['lifecycle'] in ('workspace-released', 'closed'):
                row['classification'] = 'archived'
            else:
                try: self.guard(item, registry); row['classification'] = 'reclaimable'
                except (Blocked, OSError) as exc:
                    reason = str(exc)
                    row.update(classification='active' if 'active' in reason else 'retained' if reason.startswith('retained') else 'protected', reason=reason)
            row['integration_state'] = 'integration-verified' if item.get('integration_verified') else 'integration-pending'
            output.append(row)
        objects = self.home / 'objects'
        return {'resources': output, 'active_roles': active, 'workspace_budget': active,
                'archive_unique_bytes': sum(p.stat().st_size for p in objects.iterdir() if p.is_file()) if objects.exists() else 0,
                'gc': 'no automatic object or reference deletion'}

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=os.getcwd())
    subs = parser.add_subparsers(dest='command')
    for cmd in ('inventory', 'init'): subs.add_parser(cmd)
    p = subs.add_parser('adopt'); p.add_argument('--file', required=True)
    p = subs.add_parser('plan'); p.add_argument('--ids', nargs='+')
    p = subs.add_parser('apply'); p.add_argument('--plan', required=True); p.add_argument('--digest', required=True)
    p = subs.add_parser('restore'); p.add_argument('--archive', required=True); p.add_argument('--destination', required=True)
    p = subs.add_parser('archive'); p.add_argument('--id', required=True)
    p = subs.add_parser('archive-verify'); p.add_argument('--archive', required=True)
    for cmd in ('accept', 'verify-integration'):
        p = subs.add_parser(cmd); p.add_argument('--id', required=True); p.add_argument('--evidence', required=True)
        if cmd == 'accept': p.add_argument('--manifest')
    for cmd in ('checkpoint', 'prepare-resume', 'set-owner'):
        p = subs.add_parser(cmd); p.add_argument('--id', required=True); p.add_argument('--record', required=True)
    p = subs.add_parser('integrate'); p.add_argument('--id', required=True); p.add_argument('--manifest', required=True); p.add_argument('--evidence', required=True)
    p = subs.add_parser('close'); p.add_argument('--id', required=True)
    args = parser.parse_args(argv); manager = Manager(args.root); cmd = args.command or 'inventory'
    if cmd == 'init':
        with manager.locked(): atomic(manager.home / 'registry.json', manager.registry())
        result = {'initialized': True}
    elif cmd == 'inventory': result = manager.inventory()
    elif cmd == 'adopt': result = manager.adopt(load(args.file))
    elif cmd == 'plan': result = manager.plan(args.ids)
    elif cmd == 'apply': result = manager.apply(load(args.plan), args.digest)
    elif cmd == 'restore': result = manager.restore(args.archive, args.destination)
    elif cmd == 'archive-verify':
        with manager.locked():
            manifest = manager.read_archive(args.archive)
            with tempfile.TemporaryDirectory(dir=manager.home) as tmp:
                result = manager.materialize(manifest, Path(tmp) / ('Restored.app' if manifest['resource']['path'].endswith('.app') else 'restore'))
    elif cmd == 'archive': result = manager.archive_only(args.id)
    elif cmd == 'set-owner': result = manager.set_owner(args.id, load(args.record))
    elif cmd == 'checkpoint': result = manager.checkpoint(args.id, load(args.record))
    elif cmd == 'prepare-resume': result = manager.prepare_resume(args.id, load(args.record))
    elif cmd == 'accept': result = manager.accept(args.id, args.evidence, load(args.manifest) if args.manifest else None)
    elif cmd == 'integrate': result = manager.integrate(args.id, load(args.manifest), args.evidence)
    elif cmd == 'verify-integration': result = manager.verify_integration(args.id, args.evidence)
    elif cmd == 'close': result = manager.close(args.id)
    print(json.dumps(result, sort_keys=True))
    return 2 if cmd == 'apply' and (not result.get('complete') or any(r['status'] != 'workspace-released' for r in result['resources'])) else 0

if __name__ == '__main__':
    try: raise SystemExit(main())
    except (Blocked, OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        print(json.dumps({'status': 'blocked', 'reason': str(exc)}), file=sys.stderr)
        raise SystemExit(2)
