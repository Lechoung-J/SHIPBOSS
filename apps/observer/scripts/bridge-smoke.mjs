import assert from 'node:assert/strict';
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
const runID = `bridge-smoke-${Date.now()}`;
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

try {
  await writeState(envelope([project()]));
  await launch({ bridge: true });
  await page.waitForFunction(() => window.__SHIPBOSS_WIDGET__.getState().observer.status === 'live', null, { timeout: 10000, polling: 100 });

  await check('AC-1 bridge mode shows only the real project, never demo rooms', async () => {
    const current = await widgetState();
    assert.equal(current.observer.mode, 'bridge'); assert.equal(current.observer.demo, false); assert.equal(current.observer.status, 'live');
    assert.deepEqual(current.rooms.map(item => item.id), ['shipboss']);
    assert.deepEqual(current.projects.map(item => item.id), ['shipboss']);
    assert.equal(current.project.name, '真实项目'); assert.equal(current.project.source, 'shipboss-skill · 集成测试');
    for (const id of ['website', 'tool', 'docs-demo']) assert.ok(!current.rooms.some(item => item.id === id), `demo room leaked: ${id}`);
    assert.match(await page.locator('#map-status').textContent(), /1 个项目/);
    assert.equal(current.rooms[0].scene.characters[1].visible, true, 'engineer A should be in the room');
  });

  await check('AC-2 a task change is reflected inside one second', async () => {
    await writeState(envelope([project({ name: '真实项目·验收', status: 'verifying', taskStatus: 'verifying', verifierActive: true, activity: '等待独立验收' })]));
    const latency = await waitFor(() => {
      const current = window.__SHIPBOSS_WIDGET__.getState();
      const task = current.project.tasks.find(item => item.id === 'EXAMPLE-900');
      const verifier = current.rooms[0]?.scene.characters[3];
      return current.project.name === '真实项目·验收' && task.status === 'verifying' && verifier.visible && verifier.motion === 'testing';
    });
    evidence.latencyMs = latency;
    assert.ok(latency < 1000, `state change took ${latency}ms`);
  });

  await check('AC-5 the observer exposes no write channel and leaves the state file untouched', async () => {
    const api = await page.evaluate(() => {
      const observer = window.shipbossObserver;
      return { keys: Object.keys(observer).sort(), frozen: Object.isFrozen(observer), send: typeof observer.send,
        write: typeof observer.write, setState: typeof observer.setState, require: typeof window.require, process: typeof window.process,
        controls: document.querySelectorAll('#sheet-content input, #sheet-content textarea, #sheet-content select, #sheet-content button, #sheet-content form').length };
    });
    assert.deepEqual(api.keys, ['getState', 'mode', 'onState']);
    assert.equal(api.frozen, true); assert.equal(api.send, 'undefined'); assert.equal(api.write, 'undefined'); assert.equal(api.setState, 'undefined');
    assert.equal(api.require, 'undefined'); assert.equal(api.process, 'undefined'); assert.equal(api.controls, 0);
    const before = await readFile(stateFile, 'utf8');
    await page.waitForTimeout(1200);
    assert.equal(await readFile(stateFile, 'utf8'), before, 'the observer modified the state file');
  });

  await check('AC-3 deleting the file keeps the last valid snapshot and does not crash', async () => {
    const valid = await readFile(stateFile, 'utf8');
    await rm(stateFile, { force: true });
    const latency = await waitFor(() => window.__SHIPBOSS_WIDGET__.getState().observer.status === 'stale');
    const current = await widgetState();
    assert.equal(current.rooms.length, 1); assert.equal(current.project.name, '真实项目·验收');
    assert.equal(current.project.tasks[0].status, 'verifying');
    evidence.deleteDetectedMs = latency;
    assert.equal((await nativePreferences()).windows, 1);
    assert.deepEqual(errors, []);
    // Identical bytes must also leave the stale state (dedupe must not strand it).
    await writeState(valid);
    await waitFor(() => window.__SHIPBOSS_WIDGET__.getState().observer.status === 'live');
  });

  await check('AC-3 invalid JSON keeps the last valid snapshot and does not crash', async () => {
    await writeState('{ this is not json');
    await waitFor(() => window.__SHIPBOSS_WIDGET__.getState().observer.error === 'invalid-json');
    const current = await widgetState();
    assert.equal(current.rooms.length, 1); assert.equal(current.project.name, '真实项目·验收');
    assert.equal(current.observer.status, 'stale');
    assert.equal((await nativePreferences()).windows, 1);
    assert.deepEqual(errors, []);
  });

  await check('AC-3 a valid file after corruption recovers without restart', async () => {
    await writeState(envelope([project({ name: '真实项目·恢复', activity: '已恢复' })]));
    const latency = await waitFor(() => {
      const current = window.__SHIPBOSS_WIDGET__.getState();
      return current.observer.status === 'live' && current.project.name === '真实项目·恢复';
    });
    evidence.recoveryMs = latency;
    assert.ok(latency < 1000, `recovery took ${latency}ms`);
  });

  await check('AC-7 the bridge keeps sandbox, context isolation, and no nodeIntegration', async () => {
    const native = await nativePreferences();
    assert.equal(native.windows, 1); assert.equal(native.sandbox, true); assert.equal(native.isolation, true); assert.equal(native.node, false);
    evidence.native = native;
    assert.equal(page.url().startsWith('file:'), true);
  });

  await close();
  evidence.bridgePassed = true;

  await launch({ bridge: false, demoArgument: true });
  await check('AC-4 without SHIPBOSS_OBSERVER_STATE, --demo still runs the demo model', async () => {
    const current = await widgetState();
    assert.equal(current.observer.mode, 'demo'); assert.equal(current.observer.demo, true);
    assert.deepEqual(current.rooms.map(item => item.id), ['shipboss', 'website', 'tool']);
    assert.equal(current.projects.length, 3);
  });
  await close();

  await rm(stateFile, { force: true });
  await launch({ bridge: true });
  await check('AC-1/AC-3 bridge startup with no file waits without showing demo projects', async () => {
    await waitFor(() => window.__SHIPBOSS_WIDGET__.getState().observer.status === 'waiting');
    const current = await widgetState();
    assert.equal(current.observer.demo, false); assert.equal(current.observer.status, 'waiting');
    assert.equal(current.rooms.length, 0); assert.equal(current.projects.length, 0);
    assert.deepEqual(errors, []);
    // The same running window picks up the first valid file without a restart.
    await writeState(envelope([project({ name: '启动后出现' })]));
    await waitFor(() => {
      const next = window.__SHIPBOSS_WIDGET__.getState();
      return next.observer.status === 'live' && next.rooms.length === 1 && next.rooms[0].name === '启动后出现';
    });
  });
  await close();
  assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, 'bridge-smoke.json'), `${JSON.stringify({ passed: true, checks, errors, evidence }, null, 2)}\n`);
  console.log(`Bridge smoke passed (${checks.length} checks). Evidence: artifacts/bridge-smoke.json`);
} catch (error) {
  evidence.failure = error.stack;
  await writeFile(path.join(artifacts, 'bridge-smoke.json'), `${JSON.stringify({ passed: false, checks, errors, evidence }, null, 2)}\n`);
  throw error;
} finally {
  await close();
}
