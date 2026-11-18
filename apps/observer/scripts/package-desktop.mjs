import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, utimes, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { finishStaging, markStaging } from './package-stage.mjs';

// No dependency installs, login-item registration, or writes to /Applications.
// An ad-hoc signature makes the renamed local prototype bundle launchable.
// Usage: node scripts/package-desktop.mjs [--check] [--activity-preview]
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/package-desktop.mjs [--check] [--activity-preview]\nRequires macOS, a locally installed pinned Electron, python3, and a completed dist/widget.html build.\nWrites a new app only under artifacts/. Existing bundles are preserved with a new versioned output name.');
  process.exit(0);
}
const activityPreview = args.includes('--activity-preview');
if (args.some(arg => !['--check', '--activity-preview'].includes(arg))) throw new Error('Only --check and --help are supported.');
if (process.platform !== 'darwin') throw new Error('This packaging helper creates a local macOS app on macOS.');
const root = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const artifacts = path.join(root, 'artifacts');
const require = createRequire(import.meta.url);
const inside = (base, candidate) => {
  const relative = path.relative(base, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function checkTree(directory) {
  if ((await lstat(directory)).isSymbolicLink()) throw new Error(`Refusing a symlink input: ${directory}`);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'runtime' || entry.name === '.DS_Store') {
      if (entry.name !== '.DS_Store') throw new Error(`Private/runtime data cannot be packaged: ${path.join(directory, entry.name)}`);
      continue;
    }
    const source = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`App inputs must not contain symlinks: ${source}`);
    if (entry.isDirectory()) await checkTree(source);
    else if (!entry.isFile()) throw new Error(`Unsupported packaging input: ${source}`);
  }
}
let electronPackagePath;
try { electronPackagePath = require.resolve('electron/package.json'); }
catch { throw new Error('Install a pinned Electron 40.x or 41.x locally before packaging. This helper does not install dependencies.'); }
const electronPackage = JSON.parse(await readFile(electronPackagePath, 'utf8'));
const electronDirectory = await realpath(path.dirname(electronPackagePath));
const sourceApp = path.join(electronDirectory, 'dist', 'Electron.app');
await access(path.join(sourceApp, 'Contents', 'MacOS', 'Electron'), constants.X_OK).catch(() => {
  throw new Error('Electron.app is missing. Finish the local Electron binary installation before packaging.');
});
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const widgetFile = path.join(root, 'dist', 'widget.html');
const html = await readFile(widgetFile, 'utf8').catch(() => { throw new Error('Build the renderer first: dist/widget.html is required.'); });
if (/\b(?:src|href)\s*=\s*["']\/(?!\/)/i.test(html)) {
  throw new Error('The renderer contains root-relative asset URLs. Build Vite with base: "./" before packaging.');
}
for (const directory of ['dist', 'desktop']) await checkTree(path.join(root, directory));
for (const file of ['main.cjs', 'preload.cjs', 'policy.cjs', 'trayTemplate.png']) await access(path.join(root, 'desktop', file));
if (await exists(artifacts) && (await lstat(artifacts)).isSymbolicLink()) throw new Error('artifacts must be a real workspace directory.');
const python = process.env.PYTHON || 'python3';
const pythonCheck = spawnSync(python, ['-c', 'import plistlib'], { encoding: 'utf8', timeout: 10000 });
if (pythonCheck.error || pythonCheck.status !== 0) throw new Error(`python3 with plistlib is required: ${pythonCheck.error?.message || pythonCheck.stderr}`);
const report = { electron: electronPackage.version, renderer: widgetFile, sourceApp, artifacts, localSignature: 'ad-hoc', notarized: false };
if (args.includes('--check')) {
  console.log(JSON.stringify({ ...report, checked: true }, null, 2));
  process.exit(0);
}
await mkdir(artifacts, { recursive: true });
if (await realpath(artifacts) !== artifacts) throw new Error('The artifacts path must resolve inside this exact workspace.');
let destination = path.join(artifacts, activityPreview ? 'SHIPBOSS Observer Activity Preview.app' : 'SHIPBOSS Observer.app');
if (await exists(destination)) {
  destination = path.join(artifacts, `${activityPreview ? 'SHIPBOSS Observer Activity Preview' : 'SHIPBOSS Observer'}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.app`);
}
const staging = await mkdtemp(path.join(artifacts, '.desktop-package-'));
await markStaging(staging);
const stagedApp = path.join(staging, 'SHIPBOSS Observer.app');
try {
  // Electron's framework symlinks must stay relative and must not be dereferenced.
  // ditto --noextattr avoids copying Finder/resource metadata that makes
  // codesign reject the staged bundle on newer macOS file providers.
  const copyApp = spawnSync('/usr/bin/ditto', ['--noextattr', '--norsrc', sourceApp, stagedApp], { encoding: 'utf8', timeout: 120000 });
  if (copyApp.error || copyApp.status !== 0) throw new Error(`Cannot stage Electron.app: ${copyApp.error?.message || copyApp.stderr}`);
  const resources = path.join(stagedApp, 'Contents', 'Resources');
  const appDirectory = path.join(resources, 'app');
  if (await exists(appDirectory) || await exists(path.join(resources, 'app.asar'))) {
    throw new Error('The Electron input already contains an app payload; use the clean installed Electron distribution.');
  }
  await mkdir(appDirectory);
  for (const directory of ['dist', 'desktop']) {
    const copied = spawnSync('/usr/bin/ditto', ['--noextattr', '--norsrc', path.join(root, directory), path.join(appDirectory, directory)], { encoding: 'utf8', timeout: 120000 });
    if (copied.error || copied.status !== 0) throw new Error(`Cannot stage ${directory}: ${copied.error?.message || copied.stderr}`);
  }
  if (activityPreview) await writeFile(path.join(appDirectory, 'desktop/activity-preview.json'), JSON.stringify({ preview: true }));
  const appMetadata = { name: 'shipboss-observer', productName: 'SHIPBOSS Observer', version: metadata.version || '0.1.0', private: true, main: 'desktop/main.cjs' };
  await writeFile(path.join(appDirectory, 'package.json'), `${JSON.stringify(appMetadata, null, 2)}\n`, { flag: 'wx' });
  for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) await writeFile(path.join(appDirectory, name), await readFile(path.join(root, name)));
  const plist = path.join(stagedApp, 'Contents', 'Info.plist');
  const updatePlist = spawnSync(python, ['-c', [
    'import plistlib, sys',
    'target, version, preview = sys.argv[1:]',
    'with open(target, "rb") as source: value = plistlib.load(source)',
    'value.update(CFBundleDisplayName="SHIPBOSS Observer", CFBundleName="SHIPBOSS Observer", CFBundleExecutable="SHIPBOSS Observer", CFBundleIdentifier="com.shipboss.observer", CFBundleShortVersionString=version, CFBundleVersion=version, LSUIElement=True, NSHighResolutionCapable=True)',
    'if preview == "1": value.update(CFBundleDisplayName="SHIPBOSS Observer 体验版/未上线", CFBundleName="SHIPBOSS Activity Preview", CFBundleIdentifier="com.shipboss.observer.activity-preview")',
    'value.pop("CFBundleURLTypes", None)',
    'with open(target, "wb") as output: plistlib.dump(value, output)',
    'with open(target, "rb") as source: assert plistlib.load(source)["LSUIElement"] is True',
  ].join('\n'), plist, appMetadata.version, activityPreview ? '1' : '0'], { encoding: 'utf8', timeout: 10000 });
  if (updatePlist.error || updatePlist.status !== 0) throw new Error(`Info.plist update failed: ${updatePlist.error?.message || updatePlist.stderr}`);
  // Electron recognizes a distribution by its executable name as well as payload.
  const oldExecutable = path.join(stagedApp, 'Contents', 'MacOS', 'Electron');
  const newExecutable = path.join(stagedApp, 'Contents', 'MacOS', 'SHIPBOSS Observer');
  if (!inside(stagedApp, await realpath(oldExecutable)) || await exists(newExecutable)) throw new Error('Unexpected app executable rename.');
  await rename(oldExecutable, newExecutable);
  // Clear copied Finder/file-provider metadata on this new app only. Keeping
  // file-provider flags can immediately recreate FinderInfo during signing.
  if (!inside(artifacts, await realpath(stagedApp))) throw new Error('Unexpected app metadata target.');
  const cleanMetadata = spawnSync('/usr/bin/xattr', ['-cr', stagedApp], { encoding: 'utf8', timeout: 15000 });
  if (cleanMetadata.status !== 0) throw new Error(`Cannot clean copied app metadata: ${cleanMetadata.stderr}`);
  let signed;
  for (let attempt = 0; attempt < 3; attempt++) {
    signed = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--preserve-metadata=entitlements', '--sign', '-', stagedApp], { encoding: 'utf8', timeout: 60000 });
    if (signed.status === 0) break;
    // The local file provider can reattach FinderInfo between cleanup and signing.
    spawnSync('/usr/bin/xattr', ['-cr', stagedApp], { encoding: 'utf8', timeout: 15000 });
  }
  if (signed.status !== 0) throw new Error(`Local app signing failed: ${signed.stderr}`);
  // iCloud may reattach FinderInfo immediately; ordinary deep verification checks the code.
  const verified = spawnSync('/usr/bin/codesign', ['--verify', '--deep', stagedApp], { encoding: 'utf8', timeout: 30000 });
  if (verified.status !== 0) throw new Error(`Local signature verification failed: ${verified.stderr}`);
  // Verify both absolute move targets immediately before the one directory rename.
  if (path.resolve(stagedApp) !== path.join(staging, 'SHIPBOSS Observer.app') ||
      !inside(artifacts, await realpath(stagedApp)) || path.dirname(path.resolve(destination)) !== artifacts ||
      !path.basename(destination).startsWith('SHIPBOSS Observer') || !destination.endsWith('.app') || await exists(destination)) {
    throw new Error('Refusing an unexpected bundle move target.');
  }
  await rename(stagedApp, destination);
  // ditto preserves the source bundle's 1980 timestamp; stamp this new output
  // so package-smoke's "newest bundle" selection actually picks it.
  await utimes(destination, new Date(), new Date());
  const closure = await finishStaging({ artifacts, staging, status: 'succeeded', report: { ...report, app: destination } });
  console.log(JSON.stringify({ ...report, app: destination, runtime: path.join(artifacts, 'runtime', activityPreview ? 'activity-preview' : 'shipboss-observer'), ...closure, appPayload: ['dist/', 'desktop/', 'package.json'] }, null, 2));
} catch (error) {
  try {
    const closure = await finishStaging({ artifacts, staging, status: 'failed', report, error: error.message });
    console.error(JSON.stringify({ packaging: 'failed', ...closure }));
  } catch (closureError) {
    console.error(`Stage retained after closure failure: ${closureError.message}`);
  }
  throw error;
}
