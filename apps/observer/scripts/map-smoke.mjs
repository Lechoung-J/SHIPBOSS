import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const url = process.env.SHIPBOSS_MAP_URL || 'http://127.0.0.1:5311/widget.html';
const artifacts = fileURLToPath(new URL('../artifacts/', import.meta.url));
const timeout = 25000;
const result = {
  url, startedAt: new Date().toISOString(), viewport: { width: 1100, height: 800 }, deviceScaleFactor: 1,
  checks: [], failures: [], errors: [], warnings: [], externalRequests: [], checkpoints: [], trace: [], screenshots: [],
  note: 'Real elapsed-time model; read-only diagnostics; native-window behavior is checked separately.',
};
await mkdir(artifacts, { recursive: true });
let browser, context, page, originalCanvas, traceTimer, tracePending = Promise.resolve();
let initial, initialThemes, initialPositions;
const near = (actual, expected, epsilon = 1e-8, message = '') => assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: ${actual} vs ${expected}`);
const vectorsNear = (actual, expected, epsilon = 1e-8, message = '') => { assert.equal(actual.length, expected.length); actual.forEach((value, index) => near(value, expected[index], epsilon, `${message}[${index}]`)); };
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const room = (current, id = 'shipboss') => current.rooms.find(item => item.id === id);
const project = (current, id = 'shipboss') => current.project.id === id ? current.project : current.projects.find(item => item.id === id);
const elapsed = current => current.project.elapsed;
const themes = current => Object.fromEntries(current.rooms.map(item => [item.id, { theme: item.scene.theme, name: item.scene.themeName, floor: item.scene.floorStyle }]));
const positions = current => Object.fromEntries(current.rooms.map(item => [item.id, item.position]));
const state = () => page.evaluate(() => window.__SHIPBOSS_WIDGET__.getState());
async function check(name, run) {
  try { await run(); result.checks.push(name); console.log(`PASS ${name}`); }
  catch (error) { result.failures.push({ check: name, message: error.stack || error.message }); console.error(`FAIL ${name}: ${error.message}`); }
}
async function checkpoint(name, current = null) {
  const value = current || await state(); result.checkpoints.push({ name, ...value }); return value;
}
async function capture(name, keepPointer = false) {
  if (!keepPointer) await page.mouse.move(1060, 770);
  const path = `${artifacts}${name}.png`;
  await page.locator('#observer').screenshot({ path, timeout }); result.screenshots.push(path);
}
async function waitAt(min, max, predicate = () => true) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = await state(), time = elapsed(current);
    assert.ok(time < max, `Missed real-time window ${min}–${max}s (now ${time.toFixed(2)}s)`);
    if (time >= min && predicate(current)) return current;
    await page.waitForTimeout(750);
  }
  throw new Error(`Condition not reached within ${timeout / 1000}s for ${min}–${max}s window`);
}
async function sameScene() {
  assert.equal(await page.locator('canvas').count(), 1);
  assert.equal(context.pages().length, 1);
  assert.equal(await page.evaluate(canvas => canvas.isConnected && canvas === document.querySelector('#canvas-host canvas'), originalCanvas), true, 'Original canvas was replaced');
  assert.equal((await state()).rendering.sceneCount, 1);
}
async function fixedThemes(current) {
  const values = themes(current);
  for (const [id, theme] of Object.entries(initialThemes)) assert.deepEqual(values[id], theme, `Theme changed for ${id}`);
  for (const [id, position] of Object.entries(initialPositions)) assert.deepEqual(positions(current)[id], position, `Room moved: ${id}`);
}
async function projected(projectId, point) {
  return page.evaluate(({ projectId, point }) => window.__SHIPBOSS_WIDGET__.projectPoint(projectId, ...point), { projectId, point });
}
async function drag(dx, dy = 0, button = 'left', modifiers = []) {
  const box = await page.locator('#canvas-host canvas').boundingBox();
  const start = { x: box.x + box.width / 2 - dx / 2, y: box.y + box.height * .61 - dy / 2 };
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  try {
    await page.mouse.move(start.x, start.y); await page.mouse.down({ button });
    await page.mouse.move(start.x + dx, start.y + dy, { steps: 6 }); await page.mouse.up({ button });
  } finally { for (const modifier of modifiers.reverse()) await page.keyboard.up(modifier); }
  await page.waitForTimeout(90);
}
async function centerOn(projectId, point, vertical = .53) {
  await page.keyboard.press('Escape');
  for (let attempt = 0; attempt < 12; attempt++) {
    const box = await page.locator('#canvas-host canvas').boundingBox(), projectedPoint = await projected(projectId, point);
    const dx = box.x + box.width / 2 - projectedPoint.x, dy = box.y + box.height * vertical - projectedPoint.y;
    if (Math.hypot(dx, dy) < 2) return;
    await drag(Math.max(-120, Math.min(120, dx)), Math.max(-100, Math.min(100, dy)));
  }
  throw new Error(`Could not pan ${projectId} point into the viewport`);
}
async function resetCamera() { await page.locator('#reset-camera').click(); await page.waitForTimeout(100); }
async function startTrace() {
  let tracing = false;
  traceTimer = setInterval(() => {
    if (tracing) return;
    tracing = true;
    tracePending = state().then(current => {
      result.trace.push({ elapsed: elapsed(current), rooms: current.rendering.roomCount,
        projects: current.rooms.map(item => ({ id: item.id, waiting: item.scene.waiting, question: item.scene.questionVisible, thinking: item.scene.thinking, rejected: item.scene.rejected,
          actors: item.scene.characters.map(actor => ({ index: actor.index, mode: actor.mode, motion: actor.motion, x: actor.x, z: actor.z, seated: actor.seated, visible: actor.visible })) })) });
    }).catch(error => result.warnings.push(`Trace: ${error.message}`)).finally(() => { tracing = false; });
  }, 1000);
}

try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
  context = await browser.newContext({ viewport: result.viewport, deviceScaleFactor: result.deviceScaleFactor });
  context.setDefaultTimeout(6000); context.setDefaultNavigationTimeout(timeout);
  page = await context.newPage();
  page.on('pageerror', error => result.errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') result.errors.push(message.text());
    if (message.type() === 'warning') result.warnings.push(message.text());
  });
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(url).origin) result.externalRequests.push(request.url());
  });
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout }); assert.equal(response.status(), 200);
  await page.waitForFunction(() => window.__SHIPBOSS_WIDGET__ && document.querySelector('#widget-loading').hidden, null, { timeout, polling: 500 });
  originalCanvas = await page.locator('#canvas-host canvas').elementHandle();
  initial = await checkpoint('initial'); initialThemes = themes(initial); initialPositions = positions(initial);
  await startTrace();

  await check('initial thought bubble is real scene state before t14', async () => {
    const current = await waitAt(0, 14, value => room(value).scene.thinking.some((visible, index) => visible && room(value).scene.characters[index].mode === 'working'));
    assert.ok(project(current).actors.some((actor, index) => actor.motion === 'thinking' && room(current).scene.thinking[index]));
    await checkpoint('thinking', current); await capture('map-thinking');
  });
  await check('compact map has three styled rooms, one canvas, and no legacy bars or selector', async () => {
    assert.equal(await page.locator('.window-bar,.status-bar,#project-toggle').count(), 0);
    const box = await page.locator('#observer').boundingBox(); near(box.width, 440, .5); near(box.height, 360, .5);
    assert.equal(initial.rendering.roomCount, 3); assert.equal(initial.rendering.sceneCount, 1);
    assert.deepEqual(initial.rooms.map(item => item.id), ['shipboss', 'website', 'tool']);
    assert.equal(new Set(initial.rooms.map(item => item.scene.theme)).size, 3);
    assert.equal(new Set(initial.rooms.map(item => item.scene.floorStyle)).size, 3);
    assert.equal(initial.camera.rotationEnabled, false); assert.equal(initial.camera.panEnabled, true);
    await sameScene();
  });
  await check('only the website waits, with an active seated PM and orange question', async () => {
    const current = await state();
    for (const item of current.rooms) {
      const waiting = item.id === 'website'; assert.equal(item.scene.waiting, waiting); assert.equal(item.scene.questionVisible, waiting);
    }
    const website = project(current, 'website'), pm = room(current, 'website').scene.characters[0];
    assert.equal(website.needsAttention, true); assert.equal(website.awaitingUser, true);
    assert.equal(pm.desired, true); assert.equal(pm.motion, 'waiting'); assert.equal(pm.visible, true);
    assert.equal(pm.mode, 'working'); near(pm.seated, 1); near(pm.x, -5.2, .001); near(pm.z, -.33, .001);
  });
  await check('expansion reveals more world while preserving zoom and world-point pixel scale', async () => {
    const before = await state(), a = await projected('shipboss', [0, 0, 0]), b = await projected('shipboss', [2, 0, 0]);
    await page.locator('#expand-window').click();
    await page.waitForFunction(() => Math.abs(document.querySelector('#observer').getBoundingClientRect().width - 720) < .5, null, { polling: 100 });
    await page.waitForTimeout(100);
    const after = await checkpoint('expanded'), box = await page.locator('#observer').boundingBox();
    near(box.width, 720, .5); near(box.height, 600, .5);
    near(after.camera.zoom, before.camera.zoom); near(after.camera.pixelsPerUnit, before.camera.pixelsPerUnit);
    vectorsNear(after.camera.target, before.camera.target); vectorsNear(after.camera.quaternion, before.camera.quaternion);
    assert.ok(after.camera.viewWidth > before.camera.viewWidth);
    near(distance(await projected('shipboss', [0, 0, 0]), await projected('shipboss', [2, 0, 0])), distance(a, b), 1, 'Projected separation changed on expansion');
    await sameScene();
  });
  await check('ordinary left drag pans and all button/modifier drags keep orientation fixed', async () => {
    for (const gesture of [
      { name: 'left', button: 'left', dx: 120, dy: 0 },
      { name: 'right', button: 'right', dx: -65, dy: 15 },
      { name: 'control-left', button: 'left', dx: 45, dy: -20, modifiers: ['Control'] },
      { name: 'shift-left', button: 'left', dx: -45, dy: 20, modifiers: ['Shift'] },
      { name: 'middle', button: 'middle', dx: 0, dy: 45 },
    ]) {
      const before = await state(); await drag(gesture.dx, gesture.dy, gesture.button, gesture.modifiers || []); const after = await state();
      vectorsNear(after.camera.quaternion, before.camera.quaternion, 1e-8, gesture.name);
      if (gesture.button === 'left' && !gesture.modifiers?.length) {
        assert.ok(after.camera.target.some((value, index) => Math.abs(value - before.camera.target[index]) > .01), `${gesture.name} did not pan`);
        near(after.camera.zoom, before.camera.zoom, 1e-8, `${gesture.name} changed zoom`);
      }
      assert.equal(await page.locator('#info-sheet').isVisible(), false, `${gesture.name} opened a sheet`);
    }
    await fixedThemes(await state()); await resetCamera();
  });
  await check('wheel zooms in and out without changing camera orientation', async () => {
    const box = await page.locator('#canvas-host canvas').boundingBox(); await page.mouse.move(box.x + box.width * .6, box.y + box.height * .6);
    const before = await state(); await page.mouse.wheel(0, -350); await page.waitForTimeout(120); const zoomed = await state();
    assert.ok(zoomed.camera.zoom > before.camera.zoom); vectorsNear(zoomed.camera.quaternion, before.camera.quaternion);
    await page.mouse.wheel(0, 350); await page.waitForTimeout(120); const after = await state();
    assert.ok(after.camera.zoom < zoomed.camera.zoom); vectorsNear(after.camera.quaternion, before.camera.quaternion);
    await resetCamera();
  });

  await check('t18 engineer A waits for testing on the agreed sofa seat', async () => {
    const current = await waitAt(18, 21, value => room(value).scene.characters[1].mode === 'resting');
    const actor = room(current).scene.characters[1];
    assert.equal(project(current).actors[1].motion, 'testing'); assert.equal(actor.visible, true);
    near(actor.x, -5.43, .015); near(actor.z, 3.23, .015); near(actor.seated, 1, .02);
    assert.equal(room(current).scene.thinking[1], false); await checkpoint('testing-sofa', current); await capture('map-testing');
  });
  await check('t29 engineer B paces the corridor during testing', async () => {
    const before = await waitAt(29, 34, value => room(value).scene.characters[2].mode === 'pacing');
    await page.waitForTimeout(800); const after = await state();
    for (const current of [before, after]) {
      const actor = room(current).scene.characters[2]; assert.equal(project(current).actors[2].motion, 'testing');
      assert.equal(actor.mode, 'pacing'); assert.ok(actor.x >= -2.02 && actor.x <= 2.02); near(actor.z, 2.1, .02);
    }
    assert.ok(Math.abs(room(after).scene.characters[2].x - room(before).scene.characters[2].x) > .025, 'Pacing position did not change');
    await checkpoint('testing-corridor', after);
  });
  await check('t31 rejection shows a verifier X and a failed first attempt', async () => {
    const current = await waitAt(31, 35, value => room(value).scene.rejected[3]);
    assert.equal(project(current).actors[3].motion, 'rejected'); assert.equal(room(current).scene.thinking[3], false);
    const task = project(current).tasks.find(item => item.assignee === 'eng-a'); assert.equal(task.status, 'rework'); assert.equal(task.attempt, 1);
    assert.ok(project(current).reports.some(report => report.taskId === task.id && report.verdict.startsWith('FAIL')));
    await checkpoint('rejected', current); await capture('map-rejected');
  });
  await check('t35 engineer A returns for attempt two with a thought bubble', async () => {
    const current = await waitAt(35, 38, value => room(value).scene.thinking[1]);
    const task = project(current).tasks.find(item => item.assignee === 'eng-a'); assert.equal(task.attempt, 2); assert.equal(task.status, 'implementing');
    assert.equal(project(current).actors[1].motion, 'thinking'); assert.equal(room(current).scene.rejected[3], false);
    await checkpoint('rework', current);
  });

  await check('blank floor hover identifies its repository and keeps the bubble near the pointer', async () => {
    await centerOn('shipboss', [0, .04, 2.6]);
    let found = null;
    for (const point of [[1, .04, 2.6], [0, .04, 3.1], [2, .04, 2.8], [-1, .04, 2.6], [1, .04, 4.2]]) {
      const screen = await projected('shipboss', point); await page.mouse.move(screen.x, screen.y);
      const current = await state();
      if (current.tooltip.visible && current.tooltip.kind === 'project-floor' && current.tooltip.projectId === 'shipboss') { found = screen; break; }
    }
    assert.ok(found, 'No unobstructed actual floor sample exposed the repository tooltip');
    const tooltip = page.locator('#floor-tooltip'); assert.equal(await tooltip.locator('strong').textContent(), project(await state()).name);
    const box = await tooltip.boundingBox(); assert.ok(box);
    const gap = Math.hypot(Math.max(box.x - found.x, 0, found.x - box.x - box.width), Math.max(box.y - found.y, 0, found.y - box.y - box.height));
    assert.ok(gap <= 35, `Tooltip is ${gap}px from the cursor`); await capture('map-floor-hover', true);
  });
  await check('the waiting PM question opens read-only details from real pointer picking', async () => {
    await centerOn('website', [-2, 1.1, -.5]); await capture('map-waiting');
    const anchor = await page.evaluate(() => window.__SHIPBOSS_WIDGET__.actorHeadPoint?.('website', 0) || window.__SHIPBOSS_WIDGET__.projectPoint('website', -5.2, 2.6, -.33));
    let hit = null;
    for (const [dx, dy] of [[0, 0], [-4, 0], [4, 0], [0, -4], [0, 4], [-8, -8], [8, -8], [-8, 8], [8, 8], [-12, 0], [12, 0], [0, -12], [0, 12], [-15, -15], [15, -15]]) {
      const point = { x: anchor.x + dx, y: anchor.y + dy }; await page.mouse.move(point.x, point.y);
      const tooltip = page.locator('#floor-tooltip');
      if (await tooltip.isVisible() && await tooltip.getAttribute('data-kind') === 'question') { hit = point; break; }
    }
    if (hit) { await page.mouse.click(hit.x, hit.y); result.questionPick = '3D question geometry'; }
    else {
      const point = await projected('website', [-5.1, 1.2, -1.45]); await page.mouse.click(point.x, point.y); result.questionPick = 'PM station fallback';
    }
    assert.equal(await page.locator('#info-sheet').isVisible(), true); assert.equal(await page.locator('.question-card').count(), 1);
    const current = await state(); assert.equal(current.projectId, 'website');
    const text = await page.locator('.question-card').textContent(); assert.ok(text.includes(project(current, 'website').pendingQuestion.question));
    assert.match(text, /原 Session.*回答/); assert.match(text, /仅展示等待状态/);
    assert.equal(await page.locator('#sheet-content input,#sheet-content textarea,#sheet-content select,#sheet-content button,#sheet-content form').count(), 0);
    await checkpoint('question-sheet', current); await capture('map-question'); await page.keyboard.press('Escape');
  });
  await check('map overview pans and zooms out to include all three existing rooms', async () => {
    await resetCamera();
    for (let attempt = 0; attempt < 6 && (await state()).camera.zoom > .67; attempt++) {
      const box = await page.locator('#canvas-host canvas').boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 400); await page.waitForTimeout(100);
    }
    await centerOn('shipboss', [8, 1, 5.7], .5);
    const current = await state(); assert.equal(current.rendering.roomCount, 3); assert.equal(current.rooms.filter(item => item.inView).length, 3);
    await fixedThemes(current); await checkpoint('overview', current); await capture('map-overview');
  });
  // Split the remaining real-time wait into bounded milestones; never alter the clock.
  if (elapsed(await state()) < 54) await check('real clock reaches the second delivery cycle', async () => { await waitAt(54, 69); });
  await check('t70 adds a fourth room without moving old rooms or changing the camera', async () => {
    const before = await waitAt(68.2, 70), a = await projected('shipboss', [0, 0, 0]), b = await projected('shipboss', [2, 0, 0]);
    const after = await waitAt(70, 77, current => current.rendering.roomCount === 4);
    assert.deepEqual(after.rooms.map(item => item.id), ['shipboss', 'website', 'tool', 'docs-demo']); await fixedThemes(after);
    for (const key of ['position', 'target', 'quaternion']) vectorsNear(after.camera[key], before.camera[key], 1e-8, `Camera ${key} changed on addition`);
    near(after.camera.zoom, before.camera.zoom); near(after.camera.pixelsPerUnit, before.camera.pixelsPerUnit);
    near(distance(await projected('shipboss', [0, 0, 0]), await projected('shipboss', [2, 0, 0])), distance(a, b), 1);
    await sameScene(); await checkpoint('new-project', after); await capture('map-four-rooms');
  });
  await check('browser run has no errors or external asset requests', async () => {
    assert.deepEqual(result.errors, []); assert.deepEqual(result.externalRequests, []);
  });
} catch (error) {
  result.failures.push({ check: 'browser setup or unhandled failure', message: error.stack || error.message });
  console.error(error.stack || error.message);
} finally {
  clearInterval(traceTimer); await tracePending;
  if (page && !page.isClosed()) { try { await checkpoint('final'); } catch {} }
  if (browser) await browser.close();
  result.finishedAt = new Date().toISOString(); result.passed = result.failures.length === 0 && result.errors.length === 0;
  const report = `${artifacts}map-smoke.json`; await writeFile(report, JSON.stringify(result, null, 2));
  console.log(`${result.passed ? 'PASS' : 'FAIL'} map smoke: ${result.checks.length} checks, ${result.failures.length} failures, ${result.errors.length} browser errors. Report: ${report}`);
}
if (!result.passed) process.exitCode = 1;
