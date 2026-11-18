import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, access, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { finishStaging, markStaging } from '../apps/observer/scripts/package-stage.mjs';
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stage-fixture-')));
try {
  const artifacts = path.join(root, 'artifacts'); await mkdir(artifacts);
  for (const status of ['succeeded', 'failed']) {
    const staging = await mkdtemp(path.join(artifacts, '.desktop-package-')); await markStaging(staging);
    const payload = path.join(staging, 'SHIPBOSS Observer.app/Contents/Resources/app');
    await mkdir(payload, { recursive: true }); await writeFile(path.join(payload, 'main.cjs'), 'fixture payload');
    const vendor = path.join(staging, 'SHIPBOSS Observer.app/Contents/Frameworks'); await mkdir(vendor);
    await writeFile(path.join(vendor, 'vendor'), Buffer.alloc(1000000, 1));
    const release = path.join(artifacts, 'current.app'); await mkdir(release, { recursive: true });
    await writeFile(path.join(release, 'release'), 'keep');
    const sibling = await mkdtemp(path.join(artifacts, '.desktop-package-')); await writeFile(path.join(sibling, 'keep'), 'sibling');
    const result = await finishStaging({ artifacts, staging, status, report: { sourceApp: 'pinned-local-input' }, error: status === 'failed' ? 'fixture interruption' : '' });
    assert.equal(result.stageReleased, true); await assert.rejects(access(staging));
    assert.equal(await readFile(path.join(release, 'release'), 'utf8'), 'keep');
    assert.equal(await readFile(path.join(sibling, 'keep'), 'utf8'), 'sibling');
    const receipt = JSON.parse(await readFile(result.receipt, 'utf8'));
    assert.equal(receipt.status, status); assert.equal(receipt.stageReleased, true);
    const kept = path.join(path.dirname(result.receipt), 'SHIPBOSS Observer.app/Contents/Resources/app/main.cjs');
    if (status === 'failed') assert.equal(await readFile(kept, 'utf8'), 'fixture payload');
    else await assert.rejects(access(kept));
    await assert.rejects(access(path.join(path.dirname(result.receipt), 'SHIPBOSS Observer.app/Contents/Frameworks')));
  }
  const foreign = await mkdtemp(path.join(artifacts, '.desktop-package-')); await markStaging(foreign);
  const marker = JSON.parse(await readFile(path.join(foreign, '.stage-owner.json'), 'utf8')); marker.pid++;
  await writeFile(path.join(foreign, '.stage-owner.json'), JSON.stringify(marker));
  await assert.rejects(finishStaging({ artifacts, staging: foreign, status: 'succeeded', report: {} }), /ownership/);
  await access(foreign);
  const outside = path.join(root, 'outside'); await mkdir(outside);
  const swap = path.join(artifacts, '.desktop-package-swap'); await symlink(outside, swap);
  await assert.rejects(finishStaging({ artifacts, staging: swap, status: 'failed', report: {} }), /Unexpected/);
  console.log(JSON.stringify({ cases: 4, successStageReleased: true, failedStageReleased: true, minimalEvidence: true, siblingAndReleaseRetained: true, wrongOwnerAndSymlinkBlocked: true }));
} finally { await rm(root, { recursive: true }); }
