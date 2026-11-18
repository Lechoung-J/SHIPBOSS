import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { _electron } from '@playwright/test';

// Run explicitly after building dist/widget.html. This launches the native app.
// No app-object test hooks are exposed by main/preload; Playwright uses Electron's API.
const root = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const require = createRequire(import.meta.url);
const executablePath = require('electron');
const mainFile = path.join(root, 'desktop', 'main.cjs');
await access(path.join(root, 'dist', 'widget.html'));
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const runID = `desktop-smoke-${Date.now()}-${process.pid}`;
const runtime = path.join(artifacts, 'runtime', runID);
const env = { ...process.env, SHIPBOSS_TEST_MODE: '1', SHIPBOSS_TEST_RUN_ID: runID, SHIPBOSS_DEV_URL: '' };
delete env.ELECTRON_RUN_AS_NODE;
// The smoke exercises the demo clock, independently of the launching shell.
delete env.SHIPBOSS_OBSERVER_STATE; delete env.SHIPBOSS_OBSERVER_SERVICE_DIR;
const checks = [], errors = [], evidence = {};
let desktopApp = null, page = null;
async function launch() {
  desktopApp = await _electron.launch({ executablePath, args: [mainFile], cwd: root, env, timeout: 30000 });
  page = await desktopApp.firstWindow({ timeout: 20000 });
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.shipbossDesktop, null, { timeout: 20000 });
  await page.waitForFunction(async () => (await window.shipbossDesktop.getState()).visible, null, { timeout: 15000, polling: 100 });
  await page.waitForFunction(() => {
    const widget = window.__SHIPBOSS_WIDGET__, loading = document.querySelector('#widget-loading');
    return widget && loading?.hidden && document.querySelector('#scene-error')?.hidden &&
      widget.getState().rendering.frames > 0 && widget.getState().rendering.sceneCount === 1 &&
      document.querySelector('#canvas-host canvas')?.width > 0;
  }, null, { timeout: 25000, polling: 100 });
}
async function check(name, action) { await action(); checks.push(name); console.log(`PASS ${name}`); }
const api = (method, value) => page.evaluate(([name, argument]) => {
  return ['setPinned', 'setExpanded'].includes(name) ? window.shipbossDesktop[name](argument) : window.shipbossDesktop[name]();
}, [method, value]);
const widgetState = () => page.evaluate(() => window.__SHIPBOSS_WIDGET__.getState());
async function nativeState() {
  return desktopApp.evaluate(({ app, BrowserWindow, screen }) => {
    const windows = BrowserWindow.getAllWindows(), window = windows[0], bounds = window.getBounds();
    const preferences = window.webContents.getLastWebPreferences();
    return { count: windows.length, visible: window.isVisible(), pinned: window.isAlwaysOnTop(), bounds,
      size: window.getContentSize(), workArea: screen.getDisplayMatching(bounds).workArea, userData: app.getPath('userData'),
      name: app.getName(), isolation: preferences.contextIsolation, sandbox: preferences.sandbox, node: preferences.nodeIntegration };
  });
}
async function waitNativeVisible(visible) {
  // Poll timers rather than rAF, which intentionally stops in the hidden widget.
  await page.waitForFunction(async desired => (await window.shipbossDesktop.getState()).visible === desired,
    visible, { timeout: 5000, polling: 100 });
}
async function secondProcess() {
  return new Promise((resolve, reject) => {
    // A raw second process has no Playwright inspector/debugging port.
    const child = spawn(executablePath, [mainFile], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '', settled = false;
    child.stderr.on('data', value => { stderr = `${stderr}${value}`.slice(-4096); });
    child.stdout.on('data', value => { stdout = `${stdout}${value}`.slice(-4096); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; child.kill('SIGKILL');
      reject(new Error(`Second instance did not exit within 15 seconds. ${stderr}`));
    }, 15000);
    child.once('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve({ code, signal, stderr, stdout });
    });
  });
}
async function quit() {
  const closing = desktopApp.waitForEvent('close', { timeout: 15000 });
  await api('quit').catch(error => { if (!/closed|destroyed|Target page/i.test(error.message)) throw error; });
  await closing; desktopApp = null;
}
try {
  await launch();
  await check('single sandboxed 440×360 rendered widget inside the work area', async () => {
    const native = await nativeState(), widget = await widgetState();
    assert.equal(native.count, 1); assert.equal(native.isolation, true); assert.equal(native.sandbox, true); assert.equal(native.node, false);
    assert.equal(native.name, 'SHIPBOSS Observer'); assert.equal(native.userData, runtime);
    assert.deepEqual(native.size, [Math.min(440, native.workArea.width), Math.min(360, native.workArea.height)]);
    assert.ok(native.bounds.x >= native.workArea.x && native.bounds.y >= native.workArea.y);
    assert.ok(native.bounds.x + native.bounds.width <= native.workArea.x + native.workArea.width);
    assert.ok(native.bounds.y + native.bounds.height <= native.workArea.y + native.workArea.height);
    assert.ok(widget.rendering.frames > 0); assert.equal(widget.rendering.sceneCount, 1);
  });
  await check('immutable narrow preload API and no Node in renderer', async () => {
    const value = await page.evaluate(async () => ({ frozen: Object.isFrozen(window.shipbossDesktop),
      keys: Object.keys(window.shipbossDesktop).sort(), require: typeof window.require, process: typeof window.process,
      state: await window.shipbossDesktop.getState() }));
    assert.equal(value.frozen, true); assert.equal(value.require, 'undefined'); assert.equal(value.process, 'undefined');
    assert.deepEqual(value.keys, ['getCollectedRooms', 'getState', 'hide', 'onState', 'quit', 'setCollectedRooms', 'setExpanded', 'setPinned'].sort());
    assert.deepEqual(value.state, { pinned: false, expanded: false, visible: true });
  });
  await page.evaluate(() => {
    window.__desktopSmokeStates = [];
    window.__desktopSmokeUnsubscribe = window.shipbossDesktop.onState(value => window.__desktopSmokeStates.push(value));
  });
  await check('collection preferences use bounded, separate scopes without widening boolean controls', async () => {
    const demo = await page.evaluate(() => window.shipbossDesktop.getCollectedRooms('demo'));
    const bridge = await page.evaluate(() => window.shipbossDesktop.getCollectedRooms('bridge'));
    assert.equal(demo.ok, true); assert.deepEqual(demo.ids, []); assert.deepEqual(bridge.ids, []);
    await page.evaluate(() => window.shipbossDesktop.setCollectedRooms('demo', ['smoke-demo-room']));
    assert.deepEqual(await page.evaluate(() => window.shipbossDesktop.getCollectedRooms('demo')), { ok: true, ids: ['smoke-demo-room'] });
    assert.deepEqual(await page.evaluate(() => window.shipbossDesktop.getCollectedRooms('bridge')), { ok: true, ids: [] });
    await assert.rejects(page.evaluate(() => window.shipbossDesktop.setCollectedRooms('bridge', '../bad')));
    await page.evaluate(() => window.shipbossDesktop.setCollectedRooms('demo', []));
  });
  await check('renderer pin button changes native always-on-top and emits state', async () => {
    await page.locator('#pin-window').click();
    await page.waitForFunction(async () => (await window.shipbossDesktop.getState()).pinned);
    assert.equal((await nativeState()).pinned, true);
    assert.equal(await page.locator('#pin-window').getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => window.__desktopSmokeStates.some(value => value.pinned));
    await api('setPinned', false); assert.equal((await nativeState()).pinned, false);
  });
  await check('expansion reveals more map without scaling the room', async () => {
    const before = await widgetState();
    const sample = () => page.evaluate(() => {
      const widget = window.__SHIPBOSS_WIDGET__, state = widget.getState();
      const rect = document.querySelector('#canvas-host canvas').getBoundingClientRect();
      const a = widget.projectPoint(state.rooms[0]?.id, 0, 0, 0);
      const b = widget.projectPoint(state.rooms[0]?.id, 1, 0, 0);
      return { width: state.width, height: state.height, camera: state.camera, canvas: { width: rect.width, height: rect.height }, projected: { a, b, unitPixels: Math.hypot(b.x-a.x, b.y-a.y) } };
    });
    evidence.expansion = { before: await sample(), nativeBefore: await nativeState() };
    await page.locator('#expand-window').click();
    await page.waitForFunction(async () => (await window.shipbossDesktop.getState()).expanded);
    await page.waitForFunction(() => window.__SHIPBOSS_WIDGET__.getState().width >= 718);
    evidence.expansion.atOldWait = await sample();
    // DOM layout can precede ResizeObserver. Wait for the actual renderer and
    // orthographic projection, then a rendered frame, rather than the outer div.
    await page.waitForFunction(previousFrames => {
      const state = window.__SHIPBOSS_WIDGET__.getState(), camera = state.camera;
      const viewport = document.querySelector('#viewport');
      return camera.viewport[0] === viewport.clientWidth && camera.viewport[1] === viewport.clientHeight &&
        Math.abs(2 / camera.projectionMatrix[0] * camera.pixelsPerUnit - viewport.clientWidth) < .01 &&
        Math.abs(2 / camera.projectionMatrix[5] * camera.pixelsPerUnit - viewport.clientHeight) < .01 &&
        state.rendering.frames > previousFrames;
    }, before.rendering.frames);
    const expanded = await nativeState(), after = await widgetState();
    evidence.expansion.after = await sample(); evidence.expansion.nativeAfter = expanded;
    const measured = evidence.expansion;
    assert.ok(Math.abs(measured.after.projected.unitPixels - measured.before.projected.unitPixels) < .01);
    assert.ok(2 / after.camera.projectionMatrix[0] > 2 / before.camera.projectionMatrix[0]);
    assert.deepEqual(after.camera.target, before.camera.target);
    assert.deepEqual(after.camera.position, before.camera.position);
    assert.equal(after.camera.pixelsPerUnit, before.camera.pixelsPerUnit);
    assert.equal(after.camera.zoom, before.camera.zoom);
    assert.deepEqual(after.camera.quaternion, before.camera.quaternion);
    assert.ok(after.camera.viewWidth > before.camera.viewWidth);
    assert.equal(after.rooms.length, before.rooms.length);
    // Keep native, canvas, and projected measurements even if a later check fails.
    assert.equal(expanded.count, 1); assert.deepEqual(expanded.size, [Math.min(720, expanded.workArea.width), Math.min(600, expanded.workArea.height)]);
    assert.equal(await page.locator('#expand-window').getAttribute('aria-pressed'), 'true');
    await page.locator('#expand-window').click();
    await page.waitForFunction(async () => !(await window.shipbossDesktop.getState()).expanded);
    const collapsed = await nativeState();
    assert.equal(collapsed.count, 1); assert.deepEqual(collapsed.size, [Math.min(440, collapsed.workArea.width), Math.min(360, collapsed.workArea.height)]);
  });
  await check('non-boolean controls reject without changing state', async () => {
    for (const [name, argument] of [['setPinned', 'yes'], ['setExpanded', 1]]) {
      assert.equal(await page.evaluate(async ([method, value]) => {
        try { await window.shipbossDesktop[method](value); return false; } catch { return true; }
      }, [name, argument]), true);
    }
    assert.deepEqual(await api('getState'), { pinned: false, expanded: false, visible: true });
  });
  await check('hidden rendering stops while the project model clock continues', async () => {
    await page.locator('#hide-window').click(); await waitNativeVisible(false);
    await page.waitForFunction(() => !window.__SHIPBOSS_WIDGET__.getState().rendering.visible, null, { timeout: 5000, polling: 100 });
    const before = await widgetState();
    await page.waitForTimeout(1800);
    const after = await widgetState();
    assert.equal(after.rendering.visible, false); assert.equal(after.rendering.frames, before.rendering.frames);
    assert.equal(after.rendering.framesWhileHidden, before.rendering.framesWhileHidden);
    assert.ok(after.project.elapsed - before.project.elapsed >= 0.8, 'Hidden model clock did not advance during the 1.8 second observation.');
    evidence.hidden = { milliseconds: 1800, beforeFrames: before.rendering.frames, afterFrames: after.rendering.frames,
      beforeElapsed: before.project.elapsed, afterElapsed: after.project.elapsed, framesWhileHidden: after.rendering.framesWhileHidden };
    await desktopApp.evaluate(({ app }) => app.emit('activate')); await waitNativeVisible(true);
    await page.waitForFunction(previous => window.__SHIPBOSS_WIDGET__.getState().rendering.frames > previous,
      after.rendering.frames, { timeout: 10000, polling: 100 });
    assert.equal((await widgetState()).rendering.sceneCount, 1); assert.equal((await nativeState()).count, 1);
  });
  await check('activate and close-to-tray keep one reusable window', async () => {
    await api('hide'); await waitNativeVisible(false); assert.equal((await nativeState()).visible, false);
    await desktopApp.evaluate(({ app }) => app.emit('activate')); await waitNativeVisible(true);
    await desktopApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await waitNativeVisible(false); assert.equal((await nativeState()).count, 1);
    await desktopApp.evaluate(({ app }) => app.emit('activate')); await waitNativeVisible(true);
  });
  await check('a real second process exits and reopens the one existing window', async () => {
    await api('hide'); await waitNativeVisible(false);
    await desktopApp.evaluate(({ app, BrowserWindow }) => {
      // This ephemeral observer lives only in the Playwright controller's main context.
      globalThis.__shipbossSmokeSecondInstance = null;
      app.once('second-instance', () => { globalThis.__shipbossSmokeSecondInstance = { windows: BrowserWindow.getAllWindows().length }; });
    });
    evidence.secondProcess = await secondProcess();
    assert.equal(evidence.secondProcess.code, 0, evidence.secondProcess.stderr);
    const observed = await desktopApp.evaluate(() => globalThis.__shipbossSmokeSecondInstance);
    assert.deepEqual(observed, { windows: 1 });
    await waitNativeVisible(true); assert.equal((await nativeState()).count, 1);
    assert.equal((await widgetState()).rendering.sceneCount, 1);
    await desktopApp.evaluate(() => { delete globalThis.__shipbossSmokeSecondInstance; });
  });
  await check('new windows and navigation outside the widget are blocked', async () => {
    const before = page.url();
    await page.evaluate(() => { window.open('https://blocked.invalid/', '_blank'); });
    assert.equal((await nativeState()).count, 1);
    await page.evaluate(() => { location.href = 'https://blocked.invalid/'; });
    await page.waitForTimeout(100);
    assert.equal(page.url(), before);
  });
  await check('onState unsubscribe stops callbacks', async () => {
    await page.evaluate(() => { window.__desktopSmokeUnsubscribe(); window.__desktopSmokeUnsubscribedAt = window.__desktopSmokeStates.length; });
    await api('setPinned', true);
    assert.equal(await page.evaluate(() => window.__desktopSmokeStates.length === window.__desktopSmokeUnsubscribedAt), true);
  });
  await api('setExpanded', true);
  const remembered = (await nativeState()).bounds;
  await quit();
  await check('pin, expanded state, and bounds persist on restart', async () => {
    const preferences = JSON.parse(await readFile(path.join(runtime, 'preferences.json'), 'utf8'));
    assert.equal(preferences.pinned, true); assert.equal(preferences.expanded, true); assert.deepEqual(preferences.bounds, remembered);
    await launch();
    assert.deepEqual(await api('getState'), { pinned: true, expanded: true, visible: true });
    assert.deepEqual((await nativeState()).bounds, remembered);
  });
  await api('setPinned', false); await api('setExpanded', false);
  await page.screenshot({ path: path.join(artifacts, 'desktop-smoke.png') });
  await quit();
  assert.deepEqual(errors, [], 'Renderer page errors');
  await writeFile(path.join(artifacts, 'desktop-smoke.json'), `${JSON.stringify({ passed: true, checks, errors, evidence, runtime }, null, 2)}\n`);
  console.log(`Native smoke passed (${checks.length} checks). Runtime: ${runtime}`);
} catch (error) {
  await writeFile(path.join(artifacts, 'desktop-smoke.json'), `${JSON.stringify({ passed: false, checks, errors, evidence, runtime, failure: error.stack }, null, 2)}\n`);
  throw error;
} finally {
  if (desktopApp) await desktopApp.close().catch(() => {});
}
