"""Build a host-specific Shipboss Skill from an explicit verified kit."""
from pathlib import Path, PurePosixPath
import hashlib
import json

FIRST = {
    'codex': '--harness codex --owner-session "$CODEX_THREAD_ID" --context-id "$CODEX_THREAD_ID"',
    'claude': "--harness claude --owner-session '${CLAUDE_SESSION_ID}' --context-id '${CLAUDE_SESSION_ID}'",
    'dsh': '--harness dsh --owner-session "$DSH_SESSION_ID"',
}
def checked(root, name):
    p = PurePosixPath(name)
    if p.is_absolute() or any(x in ('', '.', '..') for x in name.split('/')) or '\\' in name:
        raise ValueError('invalid kit path')
    target = root / name
    if any(part.is_symlink() for part in (target, *target.parents)):
        raise ValueError('kit path contains a symlink')
    return target

def refresh_manifest(root, names):
    files = []
    for name in sorted(set(names) - {'PUBLIC-FILES.json', 'SOURCE.json', 'observer-install-manifest.json'}):
        path = checked(root, name)
        files.append({'path': name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    value = {'version': 1, 'target': 'Shipboss installed kit',
             'skill_files': sorted({f['path'] for f in files} | {'PUBLIC-FILES.json'}), 'files': files}
    (root / 'PUBLIC-FILES.json').write_text(json.dumps(value, indent=2) + '\n')
    return value

def build_skill(source, destination, harness='generic'):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    manifest = json.loads((source / 'PUBLIC-FILES.json').read_text())
    bindings = {item['path']: item['sha256'] for item in manifest['files']}
    names = set(manifest['skill_files']) | {'verify.sh', 'install.sh'}
    for name in sorted(names):
        original = checked(source, name)
        data = original.read_bytes()
        if name != 'PUBLIC-FILES.json' and hashlib.sha256(data).hexdigest() != bindings.get(name):
            raise ValueError('public kit digest mismatch: ' + name)
        target = checked(destination, name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(original.stat().st_mode & 0o777)
    text = (destination / 'SKILL.md').read_text()
    if 'name: shipboss' not in text:
        raise ValueError('Shipboss Skill required')
    if harness in FIRST:
        start, end = text.index('## 首次加载先执行'), text.index('**角色**')
        text = text[:start] + '## 首次加载先执行\n\n```bash\nbash <本SKILL所在目录>/scripts/observer.sh start --project "$PWD" ' + FIRST[harness] + '\n```\n\n先确认 helper、元数据写权与真实 journal。queued 不等于已显示。\n\n' + text[end:]
    (destination / 'SKILL.md').write_text(text)
    refresh_manifest(destination, names)
    return {'name': 'shipboss', 'title': 'Shipboss', 'harness': harness,
            'trigger': 'text-skill-instruction; not a host hook', 'public_release': False, 'edition': 'public'}
