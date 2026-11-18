import assert from 'node:assert/strict';
import * as THREE from 'three';
import { isolateRoomMaterials } from '../src/room-style.js';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { _electron } from '@playwright/test';

// Native file-bridge integration check. Requires a built dist/widget.html.
const root = await fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const executablePath = require('electron');
const mainFile = path.join(root, 'desktop', 'main.cjs');
const artifacts = path.join(root, 'artifacts');
const runID = `EXAMPLE-044-dimming-${Date.now()}`;
const runtime = path.join(artifacts, 'runtime', runID);
const stateFile = path.join(runtime, 'observer-state.json');
await mkdir(runtime, { recursive: true });

const checks = [], errors = [], evidence = { stateFile, checks };
let desktopApp = null, page = null;

const actor = (id, active = false, motion = 'idle', taskId = null) => ({
  id, role: { pm: 'pm', 'eng-a': 'engineer', 'eng-b': 'engineer', verifier: 'verifier' }[id],
  name: id, active, taskId, motion: active ? motion : 'idle', activity: active ? '真实活动' : '', papers: active ? 1 : 0,
});
function project({ name = '真实项目', status = 'implementing', taskStatus = 'implementing', verifierActive = false, activity = '1 项实现中' } = {}) {
  return {
    id: 'shipboss', name, source: 'shipboss-skill · 集成测试', skillsUsed: 0, status, activity,
    needsAttention: false, awaitingUser: false, pendingQuestion: null, recording: false, scribeActivity: '',
    tasks: [{
      id: 'EXAMPLE-900', title: '真实任务', status: taskStatus, assignee: 'eng-a', attempt: 1,
      motion: taskStatus === 'verifying' ? 'idle' : 'working', activity: taskStatus === 'verifying' ? '等待验收' : '实现中',
      verdict: null, verification: taskStatus === 'verifying' ? 'active' : null, evidence: [], simulated: false,
    }],
    actors: [
      actor('pm'), actor('eng-a', taskStatus !== 'verifying', 'working', 'EXAMPLE-900'),
      actor('eng-b'), actor('verifier', verifierActive, verifierActive ? 'testing' : 'idle', verifierActive ? 'EXAMPLE-900' : null),
    ],
    reports: [], epoch: 1, time: 30, simulated: false,
  };
}
const envelope = (projects, extra = {}) => ({ version: 1, generatedAt: new Date().toISOString(), source: 'shipboss-skill', projects, ...extra });
async function writeState(value) {
  const staging = `${stateFile}.tmp-${process.pid}`;
  await writeFile(staging, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  await rename(staging, stateFile);
}
async function launch({ bridge, demoArgument = false } = {}) {
  const id = `${runID}-${bridge ? 'bridge' : 'demo'}`;
  const env = { ...process.env, SHIPBOSS_TEST_MODE: '1', SHIPBOSS_TEST_RUN_ID: id };
  delete env.ELECTRON_RUN_AS_NODE; delete env.SHIPBOSS_DEV_URL;
  if (bridge) env.SHIPBOSS_OBSERVER_STATE = stateFile;
  else delete env.SHIPBOSS_OBSERVER_STATE;
  desktopApp = await _electron.launch({ executablePath, args: [mainFile, ...(demoArgument ? ['--demo'] : [])], cwd: root, env, timeout: 30000 });
  page = await desktopApp.firstWindow({ timeout: 20000 });
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.shipbossObserver, null, { timeout: 20000 });
  await page.waitForFunction(() => {
    const widget = window.__SHIPBOSS_WIDGET__, loading = document.querySelector('#widget-loading');
    return widget && loading?.hidden && widget.getState().rendering.frames > 0;
  }, null, { timeout: 25000, polling: 100 });
}
async function close() { if (desktopApp) { await desktopApp.close().catch(() => {}); desktopApp = null; page = null; } }
const widgetState = () => page.evaluate(() => window.__SHIPBOSS_WIDGET__.getState());
async function nativePreferences() {
  return desktopApp.evaluate(({ BrowserWindow, app }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const preferences = window.webContents.getLastWebPreferences();
    return { windows: BrowserWindow.getAllWindows().length, isolation: preferences.contextIsolation, sandbox: preferences.sandbox, node: preferences.nodeIntegration, userData: app.getPath('userData') };
  });
}
async function check(name, action) { await action(); checks.push(name); console.log(`PASS ${name}`); }
async function waitFor(predicate, timeout = 1500) {
  const started = Date.now();
  await page.waitForFunction(predicate, null, { timeout, polling: 50 });
  return Date.now() - started;
}

const fixture = (id, status) => ({ ...project({ name: id, status }), id, tasks: [], actors: ['pm', 'eng-a', 'eng-b', 'verifier'].map(id => actor(id)), activity: '今天没有活动' });
try {
  await check('material isolation, 40% color, no accumulation and exact restoration', async () => {
    const shared = new THREE.MeshStandardMaterial({ color: '#c8c8c8', emissive: '#555555', emissiveIntensity: .5 });
    const a = new THREE.Group(), b = new THREE.Group();
    a.add(new THREE.Mesh(new THREE.BoxGeometry(), shared)); b.add(new THREE.Mesh(new THREE.BoxGeometry(), shared));
    const left = isolateRoomMaterials(a); isolateRoomMaterials(b);
    const original = shared.color.clone();
    for (let i = 0; i < 3; i++) {
      left.apply(false, .4);
      assert.ok(a.children[0].material.color.equals(original.clone().multiplyScalar(.4)));
      assert.ok(b.children[0].material.color.equals(original)); assert.ok(shared.color.equals(original));
    }
    left.apply(false, 1); assert.ok(a.children[0].material.color.equals(original));
  });
  await writeState(envelope([fixture('shipboss', 'idle'), fixture('busy', 'implementing')]));
  await launch({ bridge: true });
  await waitFor(() => window.__SHIPBOSS_WIDGET__.getState().rooms.length === 2, 10000);
  const initial = await widgetState();
  await check('two projects: idle readable at 0.4; implementing unchanged at 1', async () => {
    assert.equal(initial.rooms[0].dimmed, true); assert.equal(initial.rooms[0].lightScale, .4);
    assert.equal(initial.rooms[1].dimmed, false); assert.equal(initial.rooms[1].lightScale, 1);
  });
  const stable = { camera: initial.camera, quality: initial.quality, positions: initial.rooms.map(r => r.position) };
  async function transition(status, target) {
    const start = Date.now();
    await writeState(envelope([fixture('shipboss', status), fixture('busy', 'implementing')]));
    const samples = [];
    await page.waitForFunction(({ status, target }) => {
      const s = window.__SHIPBOSS_WIDGET__.getState();
      window.__dimSamples ??= [];
      window.__dimSamples.push({ status: s.projects[0].status, scale: s.rooms[0].lightScale, other: s.rooms[1].lightScale, at: performance.now() });
      return s.projects[0].status === status && s.rooms[0].lightScale === target;
    }, { status, target }, { timeout: 1000, polling: 'raf' });
    samples.push(...await page.evaluate(() => { const s = window.__dimSamples; window.__dimSamples = []; return s; }));
    assert.ok(samples.some(s => s.scale > .4 && s.scale < 1), 'must observe intermediate brightness');
    assert.ok(samples.every(s => s.other === 1), 'busy neighbour must never dim');
    assert.ok(Date.now() - start < 1000);
    const matching = samples.filter(s => s.status === status);
    const direction = target === 1 ? 1 : -1;
    for (let i = 1; i < matching.length; i++) assert.ok(direction * (matching[i].scale - matching[i - 1].scale) >= 0);
    return { elapsedMs: Date.now() - start, samples };
  }
  await check('idle -> implementing fades monotonically and restores within 1 second', async () => { evidence.brighten = await transition('implementing', 1); });
  await check('implementing -> idle fades monotonically without changing neighbour', async () => { evidence.darken = await transition('idle', .4); });
  await check('rapid reversal and repeated state updates preserve brightness', async () => {
    await writeState(envelope([fixture('shipboss', 'implementing'), fixture('busy', 'implementing')]));
    await waitFor(() => window.__SHIPBOSS_WIDGET__.getState().rooms[0].lightScale > .4);
    await writeState(envelope([fixture('shipboss', 'idle'), fixture('busy', 'implementing')]));
    await waitFor(() => window.__SHIPBOSS_WIDGET__.getState().rooms[0].lightScale === .4);
    await writeState(envelope([fixture('shipboss', 'idle'), fixture('busy', 'implementing')]));
    await page.waitForTimeout(400);
    assert.deepEqual((await widgetState()).rooms.map(r => r.lightScale), [.4, 1]);
  });
  await check('non-idle statuses remain bright; camera/map/quality/security unchanged', async () => {
    for (const status of ['done', 'verifying', 'reviewing', 'rework', 'dispatching', 'needs-human']) {
      await writeState(envelope([fixture('shipboss', status), fixture('busy', 'implementing')]));
      await waitFor(() => window.__SHIPBOSS_WIDGET__.getState().rooms[0].lightScale === 1);
      await page.waitForTimeout(100);
      assert.equal((await widgetState()).rooms[0].dimmed, false);
    }
    const current = await widgetState();
    assert.deepEqual(current.camera, stable.camera); assert.deepEqual(current.quality, stable.quality);
    assert.deepEqual(current.rooms.map(r => r.position), stable.positions);
    const native = await nativePreferences();
    assert.equal(native.sandbox, true); assert.equal(native.isolation, true); assert.equal(native.node, false);
    evidence.native = native; assert.deepEqual(errors, []);
  });
  await writeState(envelope([fixture('shipboss', 'idle'), fixture('busy', 'implementing')]));
  await waitFor(() => window.__SHIPBOSS_WIDGET__.getState().rooms[0].lightScale === .4);
  await page.screenshot({ path: path.join(artifacts, 'EXAMPLE-044-dimming.png') });
  await writeFile(path.join(artifacts, 'EXAMPLE-044-dimming.json'), JSON.stringify({ passed: true, checks, evidence, errors }, null, 2));
  console.log(`EXAMPLE-044 dimming passed (${checks.length} checks).`);
} finally { await close(); }
