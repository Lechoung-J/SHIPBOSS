// EXAMPLE-044 独立检查：bridge 模式下 status === 'idle' 的房间整体变暗，
// 非 idle 房间不受影响；状态改回 implementing 后 1 秒内恢复亮度。
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { _electron } from '@playwright/test';

const root = await fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const executablePath = require('electron');
const mainFile = path.join(root, 'desktop', 'main.cjs');
const runtime = path.join(root, 'artifacts', 'runtime', `idle-dim-${Date.now()}`);
const stateFile = path.join(runtime, 'observer-state.json');
await mkdir(runtime, { recursive: true });

const actor = (id, active = false, motion = 'idle', taskId = null) => ({
  id, role: { pm: 'pm', 'eng-a': 'engineer', 'eng-b': 'engineer', verifier: 'verifier' }[id],
  name: id, active, taskId, motion: active ? motion : 'idle', activity: active ? '实现中' : '', papers: active ? 1 : 0,
});
const busyProject = {
  id: 'busy-room', name: '忙碌项目', source: 'idle-dim-check', skillsUsed: 2, status: 'implementing', activity: '1 项进行中',
  needsAttention: false, awaitingUser: false, pendingQuestion: null, recording: false, scribeActivity: '',
  tasks: [{ id: 'EXAMPLE-901', title: '真实任务', status: 'implementing', assignee: 'eng-a', attempt: 1,
    motion: 'working', activity: '实现中', verdict: null, verification: null, evidence: [], simulated: false }],
  actors: [actor('pm'), actor('eng-a', true, 'working', 'EXAMPLE-901'), actor('eng-b'), actor('verifier')],
  reports: [], epoch: 1, time: 30, simulated: false,
};
const idleProject = {
  id: 'idle-room', name: '闲置项目', source: 'idle-dim-check', skillsUsed: 0, status: 'idle', activity: '今天没有活动',
  needsAttention: false, awaitingUser: false, pendingQuestion: null, recording: false, scribeActivity: '',
  tasks: [], actors: [actor('pm'), actor('eng-a'), actor('eng-b'), actor('verifier')],
  reports: [], epoch: 1, time: 0, simulated: false,
};
const envelope = projects => ({ version: 1, generatedAt: new Date().toISOString(), source: 'idle-dim-check', projects });
async function writeState(value) {
  const staging = `${stateFile}.tmp-${process.pid}`;
  await writeFile(staging, JSON.stringify(value, null, 2));
  await rename(staging, stateFile);
}

const errors = [], evidence = { stateFile, checks: [] };
let app = null, page = null;
const state = () => page.evaluate(() => window.__SHIPBOSS_WIDGET__.getState());
const roomState = current => Object.fromEntries(current.rooms.map(room => [room.id, { dimmed: room.dimmed, lightScale: room.lightScale, inView: room.inView, status: room.scene?.status }]));
async function waitFor(predicate, timeout = 3000) {
  const started = Date.now();
  await page.waitForFunction(predicate, null, { timeout, polling: 50 });
  return Date.now() - started;
}

try {
  await writeState(envelope([busyProject, idleProject]));
  const env = { ...process.env, SHIPBOSS_TEST_MODE: '1', SHIPBOSS_TEST_RUN_ID: `idle-dim-${Date.now()}`, SHIPBOSS_OBSERVER_STATE: stateFile };
  delete env.ELECTRON_RUN_AS_NODE; delete env.SHIPBOSS_DEV_URL;
  app = await _electron.launch({ executablePath, args: [mainFile], cwd: root, env, timeout: 30000 });
  page = await app.firstWindow({ timeout: 20000 });
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => {
    const widget = window.__SHIPBOSS_WIDGET__, loading = document.querySelector('#widget-loading');
    return widget && loading?.hidden && widget.getState().rendering.frames > 0;
  }, null, { timeout: 25000, polling: 100 });
  await waitFor(() => {
    const current = window.__SHIPBOSS_WIDGET__.getState();
    return current.observer.status === 'live' && current.rooms.length === 2;
  });
  await waitFor(() => {
    const current = window.__SHIPBOSS_WIDGET__.getState();
    const idle = current.rooms.find(room => room.id === 'idle-room');
    return idle?.dimmed === true && idle.lightScale <= 0.401;
  });

  const initial = await state();
  const rooms = roomState(initial);
  assert.equal(initial.observer.mode, 'bridge');
  assert.equal(initial.projects.length, 2);
  assert.equal(initial.rooms.length, 2);
  assert.equal(rooms['busy-room'].dimmed, false, 'busy room must stay bright');
  assert.equal(rooms['busy-room'].lightScale, 1);
  assert.equal(rooms['idle-room'].dimmed, true, 'idle room must be dimmed');
  assert.ok(rooms['idle-room'].lightScale > 0.35 && rooms['idle-room'].lightScale <= 0.401, `idle lightScale ${rooms['idle-room'].lightScale}`);
  assert.equal(rooms['idle-room'].inView, true, 'idle room must remain visible, not hidden');
  assert.ok(initial.rendering.renderedRoomCount >= 1);
  assert.deepEqual(initial.rooms.map(room => room.id).sort(), ['busy-room', 'idle-room']);
  for (const demo of ['shipboss', 'website', 'tool', 'docs-demo']) {
    assert.ok(!initial.rooms.some(room => room.id === demo), `demo room leaked: ${demo}`);
  }
  evidence.initial = rooms;
  const screenshot = path.join(root, 'artifacts', 'idle-dim.png');
  await page.locator('#observer').screenshot({ path: screenshot, timeout: 15000 });
  evidence.screenshot = screenshot;
  evidence.checks.push('AC-1 two projects, exactly one idle, dimmed differs');

  // Sample the in-page light scale while the idle room returns to normal.
  await page.evaluate(() => {
    window.__dimSamples = [];
    const started = performance.now();
    window.__dimTimer = setInterval(() => {
      const idle = window.__SHIPBOSS_WIDGET__.getState().rooms.find(room => room.id === 'idle-room');
      window.__dimSamples.push({ t: +(performance.now() - started).toFixed(1), scale: idle?.lightScale ?? null, dimmed: idle?.dimmed ?? null });
      if (performance.now() - started > 1600) clearInterval(window.__dimTimer);
    }, 20);
  });
  await writeState(envelope([busyProject, { ...idleProject, status: 'implementing' }]));
  const latency = await waitFor(() => {
    const current = window.__SHIPBOSS_WIDGET__.getState();
    const idle = current.rooms.find(room => room.id === 'idle-room');
    return idle?.dimmed === false && idle.lightScale >= 0.99;
  });
  const samples = await page.evaluate(() => { clearInterval(window.__dimTimer); return window.__dimSamples; });
  const restored = await state();
  const after = roomState(restored);
  evidence.recoveryMs = latency;
  evidence.samples = samples.filter(sample => sample.scale !== null).slice(0, 80);
  evidence.after = after;
  assert.ok(latency < 1000, `recovery took ${latency}ms`);
  assert.equal(after['idle-room'].dimmed, false);
  assert.equal(after['idle-room'].lightScale, 1);
  assert.equal(after['busy-room'].dimmed, false);
  assert.equal(after['busy-room'].lightScale, 1);
  const transition = samples.filter(sample => sample.scale > 0.401 && sample.scale < 0.999);
  assert.ok(transition.length >= 2, `expected a gradual 0.3s transition, got ${transition.length} intermediate samples`);
  evidence.checks.push('AC-2 idle -> implementing restores in <1s, busy room unaffected');
  evidence.checks.push('AC-2 lightScale transitions gradually instead of snapping');

  // AC-4: no sandbox/CSP regression.
  const native = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const preferences = window.webContents.getLastWebPreferences();
    return { windows: BrowserWindow.getAllWindows().length, isolation: preferences.contextIsolation, sandbox: preferences.sandbox, node: preferences.nodeIntegration };
  });
  assert.equal(native.windows, 1); assert.equal(native.isolation, true); assert.equal(native.sandbox, true); assert.equal(native.node, false);
  assert.deepEqual(errors, []);
  evidence.native = native;
  evidence.checks.push('AC-4 sandbox/context isolation/no nodeIntegration unchanged');

  evidence.passed = true;
  await writeFile(path.join(root, 'artifacts', 'idle-dim.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`PASS AC-1 dimmed differ: ${JSON.stringify(rooms)}`);
  console.log(`PASS AC-2 recovery: ${latency}ms, intermediate samples: ${transition.length}`);
  console.log(`PASS AC-4 sandbox/isolation/node: ${JSON.stringify(native)}`);
} catch (error) {
  evidence.passed = false;
  evidence.failure = error.stack;
  await writeFile(path.join(root, 'artifacts', 'idle-dim.json'), `${JSON.stringify(evidence, null, 2)}\n`).catch(() => {});
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
  await rm(runtime, { recursive: true, force: true });
}
