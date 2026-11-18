// Own only the one stage created by this packaging invocation.
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';

export async function finishStaging({ artifacts, staging, status, report, error = '' }) {
  artifacts = path.resolve(artifacts);
  staging = path.resolve(staging);
  if (await realpath(artifacts) !== artifacts || await realpath(staging) !== staging ||
      path.dirname(staging) !== artifacts || !path.basename(staging).startsWith('.desktop-package-') ||
      (await lstat(staging)).isSymbolicLink()) throw new Error('Unexpected owned package stage.');
  const marker = JSON.parse(await readFile(path.join(staging, '.stage-owner.json'), 'utf8'));
  const info = await lstat(staging);
  if (marker.pid !== process.pid || marker.ino !== info.ino || marker.dev !== info.dev || !marker.nonce) {
    throw new Error('Package stage ownership changed.');
  }
  const receiptRoot = path.join(artifacts, '.package-receipts');
  await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
  if (await realpath(receiptRoot) !== receiptRoot) throw new Error('Receipt path redirected.');
  const id = randomUUID();
  const evidence = path.join(receiptRoot, id);
  await mkdir(evidence, { mode: 0o700 });
  const files = [];
  async function inventory(directory, rel = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      const name = path.posix.join(rel, entry.name);
      const stat = await lstat(item);
      if (entry.isSymbolicLink()) {
        const { readlink } = await import('node:fs/promises');
        files.push({ path: name, type: 'symlink', target: await readlink(item), mode: stat.mode & 0o777 });
      } else if (entry.isDirectory()) await inventory(item, name);
      else if (entry.isFile()) files.push({ path: name, bytes: stat.size, mode: stat.mode & 0o777,
        sha256: createHash('sha256').update(await readFile(item)).digest('hex') });
      else throw new Error('Unsupported stage entry.');
    }
  }
  await inventory(staging);
  const kept = [];
  if (status === 'failed') {
    // Preserve unique application payload and signature/plist evidence. The pinned
    // Electron dependency remains an input, rather than another archived full app.
    for (const relative of ['SHIPBOSS Observer.app/Contents/Resources/app',
      'SHIPBOSS Observer.app/Contents/Info.plist', 'SHIPBOSS Observer.app/Contents/_CodeSignature']) {
      const source = path.join(staging, relative);
      try {
        const stat = await lstat(source);
        if (stat.isSymbolicLink() || await realpath(source) !== source) throw new Error('Evidence input redirected.');
        const target = path.join(evidence, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await cp(source, target, { recursive: stat.isDirectory(), dereference: false, preserveTimestamps: true, errorOnExist: true });
        kept.push(relative);
      } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
    }
  }
  for (const entry of files) {
    if (!kept.some(prefix => entry.path === prefix || entry.path.startsWith(`${prefix}/`))) continue;
    const copied = path.join(evidence, entry.path);
    const copiedStat = await lstat(copied);
    if ((copiedStat.mode & 0o777) !== entry.mode) throw new Error('Evidence mode verification failed.');
    if (entry.type === 'symlink') {
      const { readlink } = await import('node:fs/promises');
      if (await readlink(copied) !== entry.target) throw new Error('Evidence link verification failed.');
    } else if (createHash('sha256').update(await readFile(copied)).digest('hex') !== entry.sha256) {
      throw new Error('Evidence content verification failed.');
    }
  }
  const receipt = { version: 1, status, report, diagnostic: String(error), kept,
    stageManifest: files, sourceDependency: report.sourceApp, stageReleased: false };
  const receiptPath = path.join(evidence, 'receipt.json');
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600, flag: 'wx' });
  // Recheck the exact inode before moving into this invocation's private evidence
  // directory. No wildcard deletion and no sibling stage is touched.
  const final = await lstat(staging);
  if (await realpath(staging) !== staging || final.ino !== marker.ino || final.dev !== marker.dev) throw new Error('Stage changed before release.');
  const owned = path.join(evidence, '.owned-stage');
  await rename(staging, owned);
  const moved = await lstat(owned);
  if (moved.ino !== marker.ino || moved.dev !== marker.dev || moved.isSymbolicLink()) throw new Error('Moved stage identity changed.');
  await rm(owned, { recursive: true });
  receipt.stageReleased = true;
  await writeFile(path.join(evidence, '.receipt.tmp'), JSON.stringify(receipt, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(path.join(evidence, '.receipt.tmp'), receiptPath);
  return { receipt: receiptPath, stageReleased: true, status };
}

export async function markStaging(staging) {
  const stat = await lstat(staging);
  await writeFile(path.join(staging, '.stage-owner.json'), JSON.stringify({ pid: process.pid,
    ino: stat.ino, dev: stat.dev, nonce: randomUUID() }), { mode: 0o600, flag: 'wx' });
}
