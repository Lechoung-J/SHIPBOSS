import { runMotionCheck } from './motion-check.mjs';
import { _electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactsDir = path.join(root, 'artifacts');
// Selecting the newest bundle keeps this check honest after a fresh package run,
// which appends a versioned name instead of overwriting an existing bundle.
async function resolveApp() {
  if (process.env.SHIPBOSS_OBSERVER_APP) return path.resolve(process.env.SHIPBOSS_OBSERVER_APP);
  const candidates = [];
  for (const name of await readdir(artifactsDir)) {
    if (!/^SHIPBOSS Observer.*\.app$/.test(name)) continue;
    const directory = path.join(artifactsDir, name);
    candidates.push({ directory, mtime: (await stat(directory)).mtimeMs });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.directory || path.join(artifactsDir, 'SHIPBOSS Observer.app');
}
const appBundle = await resolveApp();
await runMotionCheck({ appPath: appBundle, out: path.join(root, 'artifacts/motion-package.json') });
const executablePath = path.join(appBundle, 'Contents/MacOS/SHIPBOSS Observer');
const runID = `packaged-${Date.now()}`;
const env = { ...process.env, SHIPBOSS_TEST_MODE: '1', SHIPBOSS_TEST_RUN_ID: runID };
delete env.ELECTRON_RUN_AS_NODE; delete env.SHIPBOSS_DEV_URL;
// The second launch explicitly tests demo/window behavior. A host-provided
// production bridge path must not silently turn this fixture into real mode.
delete env.SHIPBOSS_OBSERVER_STATE;
const errors = [], checks = [];
let app, evidence;
try {
  app = await _electron.launch({ executablePath, args: ['--demo'], cwd: root, env, timeout: 30000 });
  const page = await app.firstWindow({ timeout: 20000 });
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.__SHIPBOSS_WIDGET__ && window.shipbossDesktop && document.querySelector('#widget-loading').hidden, null, { timeout: 25000 });
  const native = await app.evaluate(({ app, BrowserWindow }) => ({ packaged: app.isPackaged, name: app.getName(), windows: BrowserWindow.getAllWindows().length, size: BrowserWindow.getAllWindows()[0].getContentSize(), runtime: app.getPath('userData') }));
  assert.equal(native.packaged, true); assert.equal(native.windows, 1); assert.deepEqual(native.size, [440, 360]); assert.equal(native.name, 'SHIPBOSS Observer');
  assert.equal(native.runtime, path.join(root, 'artifacts/runtime', runID)); checks.push('self-contained packaged application, one 440×360 window');
  assert.ok(page.url().startsWith('file:')); checks.push('renderer loads locally without Vite');
  const before = await page.evaluate(() => window.__SHIPBOSS_WIDGET__.getState());
  assert.equal(before.rooms.length, 3); assert.equal(before.camera.rotationEnabled, false); assert.equal(before.camera.panEnabled, true);
  const shipboss = before.rooms.find(room => room.id === 'shipboss'), website = before.rooms.find(room => room.id === 'website');
  assert.equal(shipboss.scene.skillsUsed, 16); assert.equal(shipboss.scene.skillBoxesShown, 16);
  assert.equal(website.scene.skillsUsed, 5); assert.equal(website.scene.skillBoxesShown, 5);
  assert.equal(await page.locator('.window-bar,.status-bar,#project-toggle').count(), 0); checks.push('three rooms in a fixed-camera map with no bars');
  const visual = await page.evaluate(() => ({ time: window.__SHIPBOSS_WIDGET__.getState().time, quality: window.__SHIPBOSS_WIDGET__.getState().quality }));
  assert.ok(visual.quality.tier === 'high' || visual.quality.tier === 'balanced' || visual.quality.tier === 'low');
  checks.push(`automatic ${visual.quality.name} quality for ${visual.quality.gpu}`);
  const previews = [];
  for (let index = 0; index < 5; index++) {
    await page.keyboard.press('t'); await page.waitForTimeout(80);
    previews.push(await page.evaluate(() => window.__SHIPBOSS_WIDGET__.getState().time));
  }
  assert.deepEqual(previews.slice(0, 4).map(item => item.source), ['preview', 'preview', 'preview', 'preview']);
  assert.equal(previews[4].source, 'local');
  checks.push('T previews dawn, day, dusk, night, then restores local time');
  await page.locator('#expand-window').click();
  await page.waitForFunction(width => {
    const state = window.__SHIPBOSS_WIDGET__.getState();
    return state.width >= 718 && state.camera.viewWidth > width;
  }, before.camera.viewWidth);
  const expanded = await page.evaluate(() => window.__SHIPBOSS_WIDGET__.getState());
  assert.equal(expanded.camera.pixelsPerUnit, before.camera.pixelsPerUnit); assert.equal(expanded.camera.zoom, before.camera.zoom);
  assert.ok(expanded.camera.viewWidth > before.camera.viewWidth); checks.push('expanding increases visible area without scaling furniture');
  await page.waitForFunction(() => {
    const room = window.__SHIPBOSS_WIDGET__.getState().rooms.find(item => item.id === 'shipboss');
    return room?.scene.scribe?.mode === 'reading';
  }, null, { timeout: 22000 });
  const scribe = await page.evaluate(() => window.__SHIPBOSS_WIDGET__.getState().rooms.find(item => item.id === 'shipboss').scene.scribe);
  assert.equal(scribe.visible, true); assert.equal(scribe.x, 3.35);
  await page.screenshot({ path: path.join(root, 'artifacts/desktop-scribe.png') });
  checks.push('scribe final reading pose; full bridge motion is separately asserted in motion-package.json');
  const beforeFrames = await page.evaluate(() => window.__SHIPBOSS_WIDGET__.getState().rendering.frames);
  const measureStart = Date.now();
  await page.waitForTimeout(2000);
  const measureSeconds = (Date.now() - measureStart) / 1000;
  const afterExpand = await page.evaluate(() => window.__SHIPBOSS_WIDGET__.getState());
  const expandedMetrics = await app.evaluate(({ app }) => {
    const list = app.getAppMetrics().map(metric => ({ type: metric.type, workingSetKb: metric.memory?.workingSetSize }));
    return { processes: list, totalWorkingSetMb: Math.round(list.reduce((sum, item) => sum + (item.workingSetKb || 0), 0) / 1024) };
  });
  const measuredFps = (afterExpand.rendering.frames - beforeFrames) / measureSeconds;
  console.log(`Expanded high-quality render: ${measuredFps.toFixed(1)} fps, ${expandedMetrics.totalWorkingSetMb} MB working set`);
  const center = await page.evaluate(() => window.__SHIPBOSS_WIDGET__.projectPoint('website', 0, 1, 0));
  await page.mouse.move(360, 300); await page.mouse.down(); await page.mouse.move(360 + (360 - center.x), 300 + (300 - center.y), { steps: 12 }); await page.mouse.up();
  const waiting = (await page.evaluate(() => window.__SHIPBOSS_WIDGET__.getState())).rooms.find(room => room.id === 'website');
  assert.equal(waiting.scene.waiting, true); assert.equal(waiting.scene.questionVisible, true); assert.equal(waiting.scene.characters[0].visible, true);
  const pm = await page.evaluate(() => window.__SHIPBOSS_WIDGET__.projectPoint('website', -5.1, 1.3, -1.45));
  await page.mouse.click(pm.x, pm.y);
  assert.equal(await page.locator('.question-card').isVisible(), true); assert.match(await page.locator('.question-card').textContent(), /演示/);
  await page.keyboard.press('Escape'); await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(root, 'artifacts/desktop-map-waiting.png') }); checks.push('waiting room light and PM question detail');
  await page.locator('#pin-window').click(); assert.equal((await page.evaluate(() => window.shipbossDesktop.getState())).pinned, true); await page.locator('#pin-window').click();
  await page.locator('#expand-window').click(); await page.locator('#reset-camera').click(); checks.push('packaged window controls');
  assert.deepEqual(errors, []);
  const metrics = await app.evaluate(({ app }) => {
    const list = app.getAppMetrics().map(metric => ({ type: metric.type, workingSetKb: metric.memory?.workingSetSize, peakWorkingSetKb: metric.memory?.peakWorkingSetSize }));
    return { processes: list, totalWorkingSetMb: Math.round(list.reduce((sum, item) => sum + (item.workingSetKb || 0), 0) / 1024) };
  });
  evidence = { passed: true, app: appBundle, checks, native, visual, metrics: { collapsed: metrics, expanded: expandedMetrics, measuredFpsExpanded: +measuredFps.toFixed(1), measuredSeconds: +measureSeconds.toFixed(2) }, errors, screenshot: 'artifacts/desktop-map-waiting.png' };
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence = { passed: false, app: appBundle, checks, errors, failure: error.stack }; throw error;
} finally {
  if (app) await app.close().catch(() => {});
  if (evidence) await writeFile(path.join(root, 'artifacts/desktop-package-smoke.json'), JSON.stringify(evidence, null, 2) + '\n');
}
