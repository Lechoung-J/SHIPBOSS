// Identical isolated file-bridge fixture and actual pointer sequence for source and --app.
// All project data is synthetic; no runtime state is read or modified.
import assert from 'node:assert/strict';
import { _electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createProjectModel } from '../src/project-model.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));

export async function runCollectionCheck({ appPath = null, out = path.join(os.tmpdir(), `EXAMPLE-049-collection-${process.pid}.json`) } = {}) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'EXAMPLE-049-collection-fixture-'));
  const statePath = path.join(fixture, 'state.json');
  const testRunId = `EXAMPLE-049-${process.pid}`;
  const template = createProjectModel().snapshot()[0];
  const projects = Array.from({ length: 12 }, (_, index) => {
    const project = structuredClone(template);
    project.id = `EXAMPLE-049-room-${String(index).padStart(2, '0')}`;
    project.name = `隔离项目 ${String(index + 1).padStart(2, '0')}`;
    project.source = 'EXAMPLE-049 isolated fixture';
    project.activity = '隔离状态持续刷新';
    project.simulated = false;
    project.isIdle = false;
    project.tasks = (project.tasks || []).map((task, taskIndex) => ({ ...task, id: `${project.id}-T${taskIndex}` }));
    project.reports = [];
    project.pendingQuestion = null; project.needsAttention = false; project.awaitingUser = false;
    project.actors = project.actors.map(actor => ({ ...actor,
      active: index === 0 && actor.id === 'eng-a', uncertain: false,
      activity: index === 0 && actor.id === 'eng-a' ? '隔离工程师持续运行' : '隔离等待',
      taskId: null, papers: 0,
    }));
    return project;
  });
  let tick = 0, timer = null, app = null, page = null, refreshError = null;
  const errors = [], interactions = [], observations = [];
  const fixtureFingerprint = crypto.createHash('sha256').update(JSON.stringify(projects)).digest('hex');
  let publishQueue = Promise.resolve();
  function publish() {
    // Timer refresh and explicit refresh can coincide. Serialize test-fixture
    // writes so they cannot rename the same staging file twice.
    publishQueue = publishQueue.then(async () => {
      const payload = { version: 1, generatedAt: new Date().toISOString(), source: 'EXAMPLE-049 synthetic interaction fixture', projects };
      const staging = `${statePath}.tmp`; await writeFile(staging, JSON.stringify(payload)); await rename(staging, statePath); tick++;
    });
    return publishQueue;
  }
  async function state() { return page.evaluate(() => window.__SHIPBOSS_WIDGET__?.getState() || null); }
  async function until(predicate, label, timeout = 25000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const current = await state(); if (current && predicate(current)) return current;
      await wait(100);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }
  async function launch() {
    const selected = appPath?.endsWith('.app') ? path.join(appPath, 'Contents/MacOS/SHIPBOSS Observer') : appPath;
    const env = { ...process.env, SHIPBOSS_TEST_MODE: '1', SHIPBOSS_TEST_RUN_ID: testRunId, SHIPBOSS_OBSERVER_STATE: statePath };
    delete env.ELECTRON_RUN_AS_NODE; delete env.SHIPBOSS_DEV_URL;
    app = await _electron.launch({ executablePath: selected || require('electron'), args: selected ? [] : [path.join(root, 'desktop/main.cjs')], cwd: root, env, timeout: 30000 });
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await until(s => s.collection?.ready && s.rooms.length === 12 && s.rendering.frames > 0, 'collection preferences and first rendered frame of 12 rooms');
    await page.locator('#widget-loading').waitFor({ state: 'hidden' });
  }
  async function closeApp() { if (app) { const old = app; app = null; await old.close(); } }
  async function viewportBox() { return page.locator('#viewport canvas').boundingBox(); }
  async function diagnosticPoint(kind, id) {
    return page.evaluate(({ kind, id }) => {
      const api = window.__SHIPBOSS_WIDGET__;
      return kind === 'cabinet' ? api.getState().cabinet.point : api.roomPoint(id, -5, .05, 3);
    }, { kind, id });
  }
  async function hitTest(x, y) { return page.evaluate(([x, y]) => window.__SHIPBOSS_WIDGET__.hitTest(x, y), [x, y]); }
  async function sampleLayoutMidpoint(id, start, target) {
    return page.evaluate(async ({ id, start, target }) => {
      const distance = (left, right) => Math.hypot(...left.map((value, index) => value - right[index]));
      const deadline = performance.now() + 460;
      while (performance.now() < deadline) {
        await new Promise(requestAnimationFrame);
        const state = window.__SHIPBOSS_WIDGET__?.getState();
        const room = state?.rooms.find(candidate => candidate.id === id);
        if (!room) continue;
        const from = distance(room.position, start), to = distance(room.position, target);
        if (from > .25 && to > .25 && room.position[1] === 0) {
          return { id, position: room.position, animationTime: state.rendering.animationTime, fromDistance: from, targetDistance: to };
        }
      }
      return null;
    }, { id, start, target });
  }
  async function panTo(kind, id = null) {
    const box = await viewportBox(); if (!box) throw new Error('3D viewport canvas is unavailable');
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    let best = await diagnosticPoint(kind, id);
    for (let attempt = 0; attempt < 18; attempt++) {
      if (best.x >= box.x + 28 && best.x <= box.x + box.width - 28 && best.y >= box.y + 28 && best.y <= box.y + box.height - 28) return best;
      const dx = clamp(center.x - best.x, -box.width * .33, box.width * .33);
      const dy = clamp(center.y - best.y, -box.height * .33, box.height * .33);
      const beforeDistance = Math.hypot(best.x - center.x, best.y - center.y);
      let improved = false;
      for (const sign of [1, -1]) {
        await page.mouse.move(center.x, center.y); await page.mouse.down();
        await page.mouse.move(center.x + sign * dx, center.y + sign * dy, { steps: 4 }); await page.mouse.up(); await wait(80);
        const candidate = await diagnosticPoint(kind, id), distance = Math.hypot(candidate.x - center.x, candidate.y - center.y);
        if (distance < beforeDistance - 2) { best = candidate; improved = true; break; }
        // Restore the camera exactly before trying the opposite pan direction.
        await page.mouse.move(center.x, center.y); await page.mouse.down();
        await page.mouse.move(center.x - sign * dx, center.y - sign * dy, { steps: 3 }); await page.mouse.up(); await wait(60);
      }
      if (!improved) {
        const targets = kind === 'cabinet'
          ? await diagnosticPoint(kind, id)
          : await diagnosticPoint(kind, id);
        best = targets;
      } else best = await diagnosticPoint(kind, id);
    }
    if (best.x < box.x || best.x > box.x + box.width || best.y < box.y || best.y > box.y + box.height) {
      throw new Error(`Could not pan ${kind} ${id || ''} into view: ${JSON.stringify(best)}`);
    }
    return best;
  }
  async function clickCabinet() {
    const point = await panTo('cabinet');
    const hit = await hitTest(point.x, point.y);
    if (hit?.kind !== 'collection-cabinet') throw new Error(`Cabinet diagnostic point did not hit cabinet: ${JSON.stringify(hit)}`);
    await page.mouse.click(point.x, point.y);
    await page.locator('#collection-panel').waitFor({ state: 'visible' });
    interactions.push({ type: 'actual-cabinet-click', point, hit });
  }
  async function chooseBlankPoint() {
    const box = await viewportBox();
    for (let y = box.y + 24; y < box.y + box.height - 24; y += 34) {
      for (let x = box.x + 24; x < box.x + box.width - 24; x += 38) {
        const canvas = await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.tagName === 'CANVAS', [x, y]);
        if (canvas && !await hitTest(x, y)) return { x, y };
      }
    }
    throw new Error('No empty map point available for no-op context-menu test');
  }
  async function stowByRightClick(id, waitAfterMs = 540, captureMidLayout = false) {
    const point = await panTo('room', id);
    const hit = await hitTest(point.x, point.y);
    if (hit?.projectId !== id) throw new Error(`Room point missed ${id}: ${JSON.stringify(hit)}`);
    const before = await state();
    await page.mouse.click(point.x, point.y, { button: 'right' });
    await page.locator('#room-context-menu').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#room-context-title').textContent(), before.rooms.find(r => r.id === id).name);
    const afterMenu = await state();
    assert.ok(before.camera.target.every((value, index) => Math.abs(value - afterMenu.camera.target[index]) < 1e-5), 'right-click opens menu without panning');
    await page.locator('#collect-room').click();
    await until(s => s.collection.ids.includes(id), `${id} stowed`);
    interactions.push({ type: 'actual-room-contextmenu', id, point });
    if (captureMidLayout) {
      const moving = before.rooms.find(room => room.id !== id && !room.collected);
      if (!moving) throw new Error('No visible neighbor available for mid-layout sample');
      const targetSlot = before.rooms.filter(room => room.id !== id && !room.collected).findIndex(room => room.id === moving.id);
      const target = [targetSlot % 2 ? 17.3 : 0, 0, Math.floor(targetSlot / 2) * 13.3];
      const sample = await sampleLayoutMidpoint(moving.id, moving.position, target);
      if (!sample) throw new Error(`No rendered mid-layout sample for ${moving.id}`);
      observations.push({ type: 'rendered-mid-layout', stowedId: id, movingId: moving.id, start: moving.position, target, sample });
    }
    if (waitAfterMs) await wait(waitAfterMs);
  }
  async function openFallback() {
    await page.locator('#collection-fallback').click(); await page.locator('#collection-panel').waitFor({ state: 'visible' });
  }
  let evidence;
  try {
    await publish(); timer = setInterval(() => publish().catch(error => { refreshError = error; }), 450);
    await launch();
    let startup = await state();
    assert.equal(startup.collection.scope, 'bridge'); assert.equal(startup.collection.ids.length, 0);
    assert.equal(startup.rendering.roomCount, 12, 'rack is independent of project room count');
    assert.ok(startup.width <= 440 && startup.height <= 360, 'collapsed window keeps compact layout');
    await page.locator('#hide-window').focus(); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'collection-fallback', 'empty-list keyboard entry is in tab order');
    await page.keyboard.press('Enter'); await page.locator('#collection-panel').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#collection-list').getAttribute('role'), 'list');
    assert.equal(await page.locator('#collection-list [role=listitem]').count(), 0);
    assert.match(await page.locator('#collection-empty').textContent(), /还没有收纳/);
    assert.equal(await page.locator('#collection-restore-all').isDisabled(), true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'collection-close', 'empty list opens with a keyboard-focusable close control');
    await page.keyboard.press('Escape'); await page.locator('#collection-panel').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'collection-fallback', 'Escape returns focus to the keyboard entry');
    interactions.push({ type: 'keyboard-empty-list' });
    await page.locator('#expand-window').click();
    startup = await until(s => s.width >= 718 && s.height >= 598, 'expanded 720×600 window');
    await page.locator('#expand-window').click();
    await until(s => s.width <= 440 && s.height <= 360, 'collapsed 440×360 window');

    // Cabinet is independently clickable when no rooms are stowed; empty state is explicit.
    await clickCabinet();
    assert.match(await page.locator('#collection-empty').textContent(), /还没有收纳/);
    await page.locator('#collection-close').click();

    const blank = await chooseBlankPoint();
    await page.mouse.click(blank.x, blank.y, { button: 'right' }); await wait(120);
    assert.equal((await state()).collection.roomMenuOpen, false, 'blank right-click is a no-op');
    interactions.push({ type: 'blank-contextmenu-noop', point: blank });

    // Stow every project through its real visible room context menu, including a live actor.
    for (let index = 0; index < projects.length; index++) await stowByRightClick(projects[index].id, 540, index === 0);
    let all = await until(s => s.collection.ids.length === 12 && s.rendering.renderedRoomCount === 0, 'all 12 rooms stowed');
    assert.equal(all.rendering.roomCount, 12); assert.equal(all.rooms.filter(room => room.collected).length, 12);
    assert.equal(projects[0].actors.find(actor => actor.id === 'eng-a').active, true, 'isolated actor remains active while its view is stowed');
    for (let i = 0; i < 8; i++) {
      await publish(); await wait(450);
      all = await state(); assert.equal(all.collection.ids.length, 12, 'fresh bridge snapshots never auto-restore a room');
      assert.equal(all.rooms[0].collected, true);
    }

    // 12 rows exercise scrolling and the all-stowed/no-room layout.
    await openFallback();
    assert.equal(await page.locator('.collection-row').count(), 12);
    const overflow = await page.locator('#collection-list').evaluate(el => el.scrollHeight > el.clientHeight);
    assert.equal(overflow, true, 'collection rows remain scrollable in compact window');
    await page.screenshot({ path: `${out}.all-stowed.png` });
    await page.locator('#collection-close').click();

    // Restart the same source/app target against the same fixture and preference key.
    await closeApp(); await launch();
    let restarted = await state();
    assert.deepEqual(restarted.collection.ids, projects.map(project => project.id), 'same-userData restart persists all collected IDs in stable order');
    assert.equal(restarted.rendering.renderedRoomCount, 0);

    // With all rooms hidden, click the actual independent 3D cabinet and restore one row.
    await clickCabinet();
    assert.equal(await page.locator('.collection-row').count(), 12);
    const restoreId = projects[0].id;
    const restorePositionBefore = (await state()).rooms.find(room => room.id === restoreId).position;
    await page.locator(`.collection-row[data-project-id="${restoreId}"]`).click();
    await until(s => !s.collection.ids.includes(restoreId), 'single room restored');
    const oneRestored = await until(s => s.rooms.find(room => room.id === restoreId).position.every((value, i) => value === [0, 0, 0][i]), 'single restored room finishes its rendered layout tween');
    assert.equal(oneRestored.rooms.find(room => room.id === restoreId).collected, false);
    assert.deepEqual(oneRestored.rooms.find(room => room.id === restoreId).position, [0, 0, 0]);
    assert.ok(restorePositionBefore[1] < 0, 'restored room began below the map');
    await page.locator('#collection-close').click();

    // Restore the target visibly first; rapid inverse input must never right-click a collected room.
    const quickId = projects[1].id;
    await openFallback();
    await page.locator(`.collection-row[data-project-id="${quickId}"]`).click();
    await until(s => !s.collection.ids.includes(quickId), 'quick room restored before reverse test');
    await until(s => s.rooms.find(room => room.id === quickId).position.every((value, i) => value === [17.3, 0, 0][i]), 'quick target finishes restoration before its new pointer input');
    await page.locator('#collection-close').click();
    await panTo('room', quickId);
    await until(s => s.rooms.find(room => room.id === quickId).visible, 'restored quick target is in the viewport before its right-click');

    // Rapid inverse input retargets from the current visual pose, then settles normally.
    await stowByRightClick(quickId, 0);
    const quickMid = (await state()).rooms.find(room => room.id === quickId);
    assert.ok(quickMid.position[1] > -0.82, 'quick reverse begins before the sink animation settles');
    await openFallback();
    await page.locator(`.collection-row[data-project-id="${quickId}"]`).click();
    const quickEnd = await until(s => !s.collection.ids.includes(quickId), 'rapid restore');
    const finalQuick = (await until(s => s.rooms.find(room => room.id === quickId).position.every((value, i) => value === [17.3, 0, 0][i]), 'rapid reversal settles on a rendered frame')).rooms.find(room => room.id === quickId);
    assert.equal(finalQuick.visible, true); assert.ok(quickMid.position[1] <= 0);
    assert.deepEqual(finalQuick.position, [17.3, 0, 0]);
    observations.push({ quickMid, finalQuick });

    await page.locator('#collection-restore-all').click().catch(async () => {
      if (!await page.locator('#collection-panel').isVisible()) await openFallback();
      await page.locator('#collection-restore-all').click();
    });
    await until(s => s.collection.ids.length === 0 && s.rooms.every(room => !room.collected), 'restore all');
    const restoredAll = await until(s => projects.every((project, index) => s.rooms.find(room => room.id === project.id).position.every((value, i) => value === [index % 2 ? 17.3 : 0, 0, Math.floor(index / 2) * 13.3][i])), 'all restored rooms finish their rendered layout tweens');
    assert.equal(restoredAll.rendering.roomCount, 12);
    for (let index = 0; index < projects.length; index++) {
      const expected = [index % 2 ? 17.3 : 0, 0, Math.floor(index / 2) * 13.3];
      const room = restoredAll.rooms.find(item => item.id === projects[index].id);
      assert.deepEqual(room.position, expected, 'restored order follows discovery order');
    }
    await wait(550); await closeApp(); await launch();
    const restartedEmpty = await state(); assert.deepEqual(restartedEmpty.collection.ids, [], 'restoring all persists across restart');
    assert.equal(restartedEmpty.rendering.roomCount, 12);
    assert.ok(restartedEmpty.rooms.every(room => !room.collected));

    const bridgeAfter = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(bridgeAfter.projects)).digest('hex'), fixtureFingerprint,
      'renderer never modifies the synthetic bridge fixture or project/task state');
    assert.deepEqual(errors, []); if (refreshError) throw refreshError;
    const native = await app.evaluate(({ BrowserWindow }) => {
      const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration };
    });
    assert.deepEqual(native, { sandbox: true, contextIsolation: true, nodeIntegration: false });
    evidence = { passed: true, target: appPath || 'source Electron', testRunId, fixture, fixtureFingerprint,
      projectCount: projects.length, refreshes: tick, interactions, observations, native, errors };
  } catch (error) {
    evidence = { passed: false, target: appPath || 'source Electron', testRunId, fixture, refreshes: tick,
      failure: error.stack, interactions, observations, errors };
    throw error;
  } finally {
    clearInterval(timer); await closeApp().catch(() => {});
    await mkdir(path.dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(evidence, null, 2) + '\n');
  }
  console.log(`EXAMPLE-049 collection ${appPath || 'source'} OK: ${projects.length} rooms, ${interactions.length} actual pointer interactions, ${tick} refreshes; evidence ${out}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
  await runCollectionCheck({ appPath: value('--app') || process.env.SHIPBOSS_OBSERVER_APP || null, out: value('--out') || undefined });
}
