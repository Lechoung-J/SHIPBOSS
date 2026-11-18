import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { _electron } from '@playwright/test';
import { createProjectModel } from '../src/project-model.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const runID = `camera-resize-${Date.now()}-${process.pid}`;
const out = path.join(root, 'artifacts', runID);
await mkdir(out, { recursive: true });
const stateFile = path.join(out, 'state.json');
const template = createProjectModel().snapshot()[0];
const projects = Array.from({ length: 12 }, (_, i) => ({ ...structuredClone(template), id: `camera-${i}`, name: `Camera ${i}`, simulated: false }));
const publish = count => writeFile(stateFile, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), projects: projects.slice(0, count) }));
const env = { ...process.env, SHIPBOSS_TEST_MODE: '1', SHIPBOSS_TEST_RUN_ID: runID, SHIPBOSS_OBSERVER_STATE: stateFile, SHIPBOSS_DEV_URL: '' };
delete env.ELECTRON_RUN_AS_NODE; delete env.SHIPBOSS_OBSERVER_SERVICE_DIR;
let app, page;
const evidence = { runID, cases: [], errors: [] };
async function launch() {
  app = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'desktop/main.cjs')], cwd: root, env });
  page = await app.firstWindow(); page.on('pageerror', e => evidence.errors.push(e.message));
  await page.waitForFunction(() => window.__SHIPBOSS_WIDGET__?.getState().rendering.frames > 0 && document.querySelector('#widget-loading').hidden);
}
const sample = () => page.evaluate(() => {
  const api = window.__SHIPBOSS_WIDGET__, s = api.getState(), id = s.rooms[0]?.id;
  const a = api.projectPoint(id, 0, 0, 0), b = api.projectPoint(id, 1, 0, 0);
  return { camera: s.camera, width: s.width, frames: s.rendering.frames, rooms: s.rooms.length,
    roles: s.rooms.map(r => [r.id, r.actorActivities.map(a => a.id)]), unitPixels: Math.hypot(a.x-b.x, a.y-b.y) };
});
async function resize(expanded, before) {
  await page.evaluate(value => window.shipbossDesktop.setExpanded(value), expanded);
  await page.waitForFunction(({ expanded, frames }) => {
    const s = window.__SHIPBOSS_WIDGET__.getState(), c = s.camera, viewport = document.querySelector('#viewport');
    return s.native.expanded === expanded && s.width === (expanded ? 718 : 438) &&
      c.viewport[0] === viewport.clientWidth && c.viewport[1] === viewport.clientHeight &&
      Math.abs(2 / c.projectionMatrix[0] * c.pixelsPerUnit - viewport.clientWidth) < .01 &&
      s.rendering.frames > frames;
  }, { expanded, frames: before.frames });
  const after = await sample();
  assert.equal(after.camera.zoom, before.camera.zoom);
  assert.deepEqual(after.camera.target, before.camera.target);
  assert.deepEqual(after.camera.position, before.camera.position);
  assert.deepEqual(after.camera.quaternion, before.camera.quaternion);
  assert.ok(Math.abs(after.unitPixels - before.unitPixels) < .01);
  assert.equal(after.rooms, before.rooms); assert.deepEqual(after.roles, before.roles);
  assert.ok(expanded ? after.camera.viewWidth > before.camera.viewWidth : after.camera.viewWidth < before.camera.viewWidth);
  return after;
}
try {
  await publish(1); await launch();
  for (const count of [1, 12]) {
    await publish(count);
    await page.waitForFunction(n => window.__SHIPBOSS_WIDGET__.getState().rooms.length === n, count);
    const before = await sample();
    if (evidence.cases.length) {
      const previous = evidence.cases.at(-1).reopened;
      assert.equal(before.camera.zoom, previous.camera.zoom, 'Adding rooms must preserve manual zoom; no automatic fit');
      assert.deepEqual(before.camera.target, previous.camera.target);
      assert.ok(Math.abs(before.unitPixels - previous.unitPixels) < .01);
    }
    const expanded = await resize(true, before), collapsed = await resize(false, expanded);
    // Reproduce the old DOM-width readiness condition in the same renderer task.
    // ResizeObserver is asynchronous; this intentionally samples before delivery.
    const stale = await page.evaluate(() => {
      const viewport = document.querySelector('#viewport'), api = window.__SHIPBOSS_WIDGET__;
      const before = api.getState(); viewport.style.width = `${viewport.clientWidth - 20}px`;
      const during = api.getState(), domWidth = viewport.clientWidth; viewport.style.width = '';
      return { before: { width: before.camera.viewport[0], viewWidth: before.camera.viewWidth }, during: { domWidth, viewWidth: during.camera.viewWidth } };
    });
    assert.notEqual(stale.during.domWidth, stale.before.width);
    assert.equal(stale.during.viewWidth, stale.before.viewWidth);
    await page.waitForTimeout(600);
    await page.mouse.move(210, 190); await page.mouse.wheel(0, -180);
    await page.waitForFunction(zoom => window.__SHIPBOSS_WIDGET__.getState().camera.zoom !== zoom, collapsed.camera.zoom);
    await page.mouse.move(210, 190); await page.mouse.down(); await page.mouse.move(245, 215, { steps: 4 }); await page.mouse.up();
    const manual = await sample();
    assert.notDeepEqual(manual.camera.target, collapsed.camera.target);
    const manualExpanded = await resize(true, manual), manualCollapsed = await resize(false, manualExpanded);
    await page.evaluate(() => window.shipbossDesktop.hide());
    await app.evaluate(({ app }) => app.emit('activate'));
    await page.waitForFunction(async () => (await window.shipbossDesktop.getState()).visible);
    const reopened = await sample();
    assert.deepEqual(reopened.camera, manualCollapsed.camera);
    evidence.cases.push({ count, before, expanded, collapsed, stale, manual, manualExpanded, manualCollapsed, reopened });
  }
  assert.deepEqual(evidence.errors, []); evidence.passed = true;
  console.log('PASS 1/12 rooms, fixed scale, DOM/ResizeObserver ordering, manual zoom/pan, collapse/expand/hide/reopen');
} catch (error) { evidence.passed = false; evidence.failure = error.stack; throw error; }
finally { if (app) await app.close(); await writeFile(path.join(root, 'artifacts/camera-resize.json'), JSON.stringify(evidence, null, 2)); }
