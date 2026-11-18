import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const base = 'http://127.0.0.1:5310';
const timeout = 25000;
const artifacts = 'artifacts';
const activeRoles = [0, 1, 2, 0, -1];
const stackTargets = [[12, 0, 0, 0], [0, 12, 0, 0], [0, 0, 12, 0], [12, 0, 0, 0], [0, 0, 0, 12]];
const sequence = [[1, 0], [1, 1], [1, 2], [1, 3], [2, 0], [2, 1], [2, 2], [2, 3], [2, 4]];
const roleNames = ['产品经理', '工程师', '验收员'];
const errors = [], consoleWarnings = [], checks = [], failures = [], checkpoints = [], screenshots = [];
let trace = null, videoPath = null, mobileLayout = null, reducedPage = null;
const startedAt = new Date().toISOString();
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1,
  recordVideo: { dir: `${artifacts}/video`, size: { width: 1440, height: 1000 } },
});
context.setDefaultTimeout(timeout);
context.setDefaultNavigationTimeout(timeout);
const page = await context.newPage();
const watchErrors = target => {
  target.on('pageerror', error => errors.push(error.message));
  target.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
    if (message.type() === 'warning') consoleWarnings.push(message.text());
  });
};
watchErrors(page);
const state = (target = page) => target.evaluate(() => window.__SHIPBOSS_DEMO__.getState());
const settle = (target = page) => target.waitForFunction(() => window.__SHIPBOSS_DEMO__.getState().settled, null, { timeout });
async function check(name, action) {
  try { await action(); checks.push(name); }
  catch (error) { failures.push({ check: name, message: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
}
async function capture(name) {
  const path = `${artifacts}/study03-${name}.png`;
  await page.screenshot({ path, timeout }); screenshots.push(path);
}
async function uiState(target = page) {
  return target.evaluate(() => {
    const visible = el => !el.hidden && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const labels = [...document.querySelectorAll('.station-label[data-station]')].filter(visible).map(el => {
      const index = Number(el.dataset.station);
      return { index, active: el.dataset.active, rect: rect(el), monitor: window.__SHIPBOSS_DEMO__.project([-4.6, -.1, 4.4][index], 1.63, -1.76) };
    });
    return {
      labels, deliveryVisible: visible(document.querySelector('.delivery-label')),
      buttons: [...document.querySelectorAll('[data-stage]')].map(el => ({ stage: Number(el.dataset.stage), visible: visible(el), rect: rect(el) })),
      playback: rect(document.querySelector('.playback')), width: innerWidth, height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
}
async function assertStage(target, cycle, stage, name) {
  const s = await state(target), ui = await uiState(target), active = activeRoles[stage];
  checkpoints.push({ name, ...s, ui });
  await check(`${name}: stage, report, paper, screen, and occupancy`, () => {
    assert.equal(s.cycle, cycle); assert.equal(s.stage, stage); assert.equal(s.pendingTasks, 2 - cycle);
    assert.equal(s.settled, true); assert.equal(s.reportReady, stage >= 3);
    assert.deepEqual(s.stacks, stackTargets[stage]);
    assert.deepEqual(s.screens, [0, 1, 2].map(i => i === active));
    assert.equal(s.characters.filter(a => a.visible).length, active < 0 ? 0 : 1);
    s.characters.forEach((actor, i) => {
      assert.equal(actor.mode, i === active ? 'working' : 'absent');
      if (i === active) assert.equal(actor.seated, 1);
    });
  });
  await check(`${name}: only active monitor bubble is visible`, () => {
    assert.deepEqual(ui.labels.map(label => label.index), active < 0 ? [] : [active]);
    assert.equal(ui.deliveryVisible, stage === 4);
    for (const label of ui.labels) {
      assert.equal(label.active, 'true');
      // The speech-bubble tail sits just above its own monitor, also on mobile.
      const center = label.rect.x + label.rect.width / 2;
      assert.ok(Math.abs(center - label.monitor.x) < 110, 'Bubble is horizontally distant from its monitor');
      assert.ok(label.monitor.y - label.rect.bottom >= -12 && label.monitor.y - label.rect.bottom < 90, 'Bubble is vertically distant from its monitor');
    }
  });
  return s;
}
async function clickWorld(x, y, z) {
  const point = await page.evaluate(([x, y, z]) => window.__SHIPBOSS_DEMO__.project(x, y, z), [x, y, z]);
  await page.mouse.click(point.x, point.y);
}

// Start before the application script so the initial PM entrance is not missed.
await page.addInitScript(() => {
  const trace = window.__study03Trace = {
    active: true, started: null, elapsedMs: 0, frames: [], stages: [], modes: [[], [], []],
    crossings: [], entries: [], exits: [], violations: [], maxVisible: 0, doorOpened: false,
  };
  let previous = null;
  const seenViolations = new Set();
  const violation = (kind, detail) => {
    if (!seenViolations.has(kind)) { trace.violations.push({ kind, ...detail }); seenViolations.add(kind); }
  };
  const visible = el => !el.hidden && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  function observe(now) {
    if (!trace.active) return;
    requestAnimationFrame(observe);
    if (!window.__SHIPBOSS_DEMO__) return;
    if (trace.started === null) trace.started = now;
    const s = window.__SHIPBOSS_DEMO__.getState();
    const labels = [...document.querySelectorAll('.station-label[data-station]')].filter(visible).map(el => Number(el.dataset.station));
    const deliveryVisible = visible(document.querySelector('.delivery-label'));
    const f = {
      ms: +(now - trace.started).toFixed(1), cycle: s.cycle, stage: s.stage, playing: s.playing, paused: s.paused,
      settled: s.settled, reportReady: s.reportReady, characters: s.characters, stacks: s.stacks,
      screens: s.screens, labels, deliveryVisible, doorAngle: s.doorAngle,
    };
    trace.elapsedMs = f.ms; trace.frames.push(f);
    if (!previous || previous.stage !== s.stage || previous.cycle !== s.cycle) trace.stages.push({ cycle: s.cycle, stage: s.stage, ms: f.ms, pm: s.characters[0] });
    const occupancy = s.characters.filter(a => a.visible).length;
    trace.maxVisible = Math.max(trace.maxVisible, occupancy); trace.doorOpened ||= s.doorAngle > .7;
    const active = [0, 1, 2, 0, -1][s.stage];
    const expectedLabels = active < 0 ? [] : [active];
    if (occupancy > 1) violation('multiple visible characters', f);
    if (JSON.stringify(labels) !== JSON.stringify(expectedLabels)) violation('role labels do not match active stage', f);
    if (JSON.stringify(s.screens) !== JSON.stringify([0, 1, 2].map(i => i === active))) violation('screen does not match active stage', f);
    if (deliveryVisible !== (s.stage === 4)) violation('delivery label outside standby', f);
    if (s.reportReady !== (s.stage >= 3)) violation('incorrect report availability', f);
    if (Math.abs(s.stacks.reduce((a, b) => a + b, 0) - 12) > .02) violation('paper total is not conserved', f);
    s.characters.forEach((actor, i) => {
      const before = previous?.characters[i];
      if (!before || actor.mode !== before.mode) {
        trace.modes[i].push({ mode: actor.mode, cycle: s.cycle, stage: s.stage, ms: f.ms });
        if (actor.mode === 'entering') trace.entries.push({ role: i, cycle: s.cycle, stage: s.stage, ms: f.ms });
        if (actor.mode === 'exiting') trace.exits.push({ role: i, cycle: s.cycle, stage: s.stage, ms: f.ms });
      }
      // Detect crossing a plane; twice-speed walking can skip a narrow position band.
      if (before && before.x < -7 && actor.x >= -7 && actor.mode === 'entering') trace.crossings.push({ role: i, direction: 'in', ms: f.ms });
      if (before && before.x > -7 && actor.x <= -7 && actor.mode === 'exiting') trace.crossings.push({ role: i, direction: 'out', ms: f.ms });
      if (actor.visible && ['entering', 'exiting'].includes(actor.mode) && actor.z < -.67) violation('walking through a desk', { role: i, ...f });
    });
    previous = f;
  }
  requestAnimationFrame(observe);
});

try {
  const response = await page.goto(base, { waitUntil: 'domcontentloaded', timeout });
  assert.equal(response.status(), 200);
  await page.waitForFunction(() => window.__SHIPBOSS_DEMO__ && document.querySelector('#loading').hidden, null, { timeout });
  const initial = await state();
  await check('AUTO starts at cycle 1 dispatch', () => { assert.equal(initial.cycle, 1); assert.equal(initial.stage, 0); assert.equal(initial.playing, true); });

  // Do not manually advance or accelerate AUTO. Each bounded wait watches the next
  // settled stage; the complete two-cycle recording takes approximately one minute.
  for (const [cycle, stage] of sequence) {
    await page.waitForFunction(([cycle, stage]) => {
      const s = window.__SHIPBOSS_DEMO__.getState();
      return s.cycle === cycle && s.stage === stage && s.settled;
    }, [cycle, stage], { timeout });
    await assertStage(page, cycle, stage, `AUTO ${cycle}:${stage}`);
    console.log(`AUTO cycle ${cycle}, stage ${stage}: settled`);
    if (cycle === 1 && stage === 1) await capture('engineer');
    if (stage === 3) {
      await check(`cycle ${cycle}: active PM label opens callback report`, async () => {
        await page.locator('.station-label[data-station="0"]').click();
        assert.equal(await page.locator('#detail-title').textContent(), '产品经理');
        assert.equal(await page.locator('#detail-report').isVisible(), true);
        assert.equal(await page.locator('.report-stamp:visible').textContent(), 'PASS');
        if (cycle === 2) await capture('review');
      });
      await page.keyboard.press('Escape');
    }
  }
  await page.waitForFunction(() => {
    const s = window.__SHIPBOSS_DEMO__.getState();
    return s.cycle === 2 && s.stage === 4 && s.settled && !s.playing && s.paused;
  }, null, { timeout });
  await page.waitForTimeout(650);
  trace = await page.evaluate(() => { window.__study03Trace.active = false; return window.__study03Trace; });
  await capture('complete');
  await check('complete uninterrupted AUTO sequence across both cycles', () => {
    assert.deepEqual(trace.stages.map(({ cycle, stage }) => [cycle, stage]), sequence);
    assert.ok(trace.frames.length > 500, `Only ${trace.frames.length} animation frames observed`);
    assert.ok(trace.elapsedMs >= 50000, 'AUTO did not include real walking and settled holds');
    assert.deepEqual(trace.violations, []); assert.equal(trace.maxVisible, 1); assert.equal(trace.doorOpened, true);
  });
  await check('PM enters for dispatch and callbacks, with one shared seated dispatch', () => {
    assert.deepEqual(trace.entries.filter(e => e.role === 0).map(e => [e.cycle, e.stage]), [[1, 0], [1, 3], [2, 3]]);
    for (let role = 0; role < 3; role++) {
      const expected = role === 0 ? 3 : 2;
      assert.equal(trace.entries.filter(e => e.role === role).length, expected);
      assert.equal(trace.exits.filter(e => e.role === role).length, expected);
      for (const direction of ['in', 'out']) assert.equal(trace.crossings.filter(e => e.role === role && e.direction === direction).length, expected);
      for (const mode of ['entering', 'sitting', 'working', 'standing', 'exiting', 'absent']) assert.ok(trace.modes[role].some(e => e.mode === mode), `Role ${role} never ${mode}`);
    }
    const callback = trace.frames.findIndex(f => f.cycle === 1 && f.stage === 3 && f.settled);
    const nextRole = trace.frames.findIndex(f => f.cycle === 2 && f.stage === 1);
    assert.ok(callback >= 0 && nextRole > callback);
    const seated = trace.frames.slice(callback, nextRole);
    assert.ok(seated.some(f => f.cycle === 2 && f.stage === 0));
    seated.forEach(f => assert.deepEqual(f.characters[0], { role: 0, mode: 'working', visible: true, seated: 1, x: -4.6, z: -.33 }));
  });
  await check('AUTO holds every settled stage and stops at empty standby', async () => {
    for (let i = 0; i < sequence.length; i++) {
      const [cycle, stage] = sequence[i];
      const ready = trace.frames.find(f => f.cycle === cycle && f.stage === stage && f.settled);
      const end = i + 1 < sequence.length ? trace.stages[i + 1] : trace.frames.find(f => f.stage === 4 && !f.playing);
      assert.ok(ready && end, `Missing ready/hold event for ${cycle}:${stage}`);
      assert.ok(end.ms - ready.ms >= 3400, `Stage ${cycle}:${stage} skipped its settled hold: ${end.ms - ready.ms}ms`);
    }
    const final = await state(), ui = await uiState();
    assert.equal(final.stage, 4); assert.equal(final.playing, false); assert.equal(final.paused, true);
    assert.deepEqual(final.screens, [false, false, false]); assert.equal(final.characters.filter(a => a.visible).length, 0);
    assert.deepEqual(ui.labels, []); assert.equal(ui.deliveryVisible, true);
  });
  await check('delivery label exposes completed report', async () => {
    await page.getByRole('button', { name: '查看交付台', exact: true }).click();
    assert.equal(await page.locator('.report-stamp:visible').textContent(), 'PASS');
    await page.keyboard.press('Escape');
  });

  await check('rapid role changes settle on the latest requested role', async () => {
    await page.locator('[data-stage="0"]').click(); await page.waitForTimeout(350);
    for (const stage of [2, 1, 0, 2]) { await page.locator(`[data-stage="${stage}"]`).click(); await page.waitForTimeout(120); }
    await settle(); await assertStage(page, 2, 2, 'rapid transition');
  });
  await check('inactive workstation remains clickable through the 3D raycast', async () => {
    assert.equal(await page.locator('.station-label[data-station="1"]').isVisible(), false);
    await clickWorld(0, 1.2, -1.45);
    assert.equal(await page.locator('#detail-panel').isVisible(), true);
    assert.equal(await page.locator('#detail-title').textContent(), '工程师');
    await page.keyboard.press('Escape');
  });
  await check('delivery report stays pending before callback', async () => {
    await clickWorld(4.5, .9, 3.25);
    assert.equal(await page.locator('#detail-title').textContent(), '一页纸交付');
    assert.equal(await page.locator('.report-pending').isVisible(), true);
    assert.equal(await page.locator('.report-stamp:visible').count(), 0);
    await page.keyboard.press('Escape');
  });
  await check('paper stacks interpolate during the 1.65-second transfer', async () => {
    await page.locator('[data-stage="1"]').click();
    await page.waitForFunction(() => {
      const stacks = window.__SHIPBOSS_DEMO__.getState().stacks;
      return stacks[1] > 1 && stacks[1] < 11 && stacks[2] > 1 && stacks[2] < 11;
    }, null, { timeout: 5000 });
    const transfer = await state();
    assert.ok(Math.abs(transfer.stacks.reduce((a, b) => a + b, 0) - 12) < .02);
  });
  await check('pause freezes walking, stack transfer, and door motion', async () => {
    await page.getByRole('button', { name: '自动播放演示', exact: true }).click();
    await page.getByRole('button', { name: '暂停演示', exact: true }).click();
    const paused = await state(); await page.waitForTimeout(650); const after = await state();
    assert.equal(after.paused, true); assert.equal(after.playing, false);
    for (const field of ['characters', 'stacks', 'doorAngle', 'stage', 'cycle']) assert.deepEqual(after[field], paused[field], `${field} changed while paused`);
    // Stage selection resumes preview motion without restarting the AUTO cycle.
    await page.locator('[data-stage="1"]').click(); await settle();
  });
  await check('camera zoom and reset controls', async () => {
    await page.getByRole('button', { name: '拉近', exact: true }).click(); assert.ok((await state()).cameraZoom > 1);
    await page.getByRole('button', { name: '恢复默认等轴视角', exact: true }).click(); assert.equal((await state()).cameraZoom, 1);
  });

  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(350);
  await page.locator('[data-stage="1"]').click(); await settle();
  await assertStage(page, 2, 1, 'mobile engineer');
  mobileLayout = await uiState();
  await check('390×844 mobile fits active bubble and all five stage buttons', () => {
    assert.ok(mobileLayout.scrollWidth <= 390); assert.equal(mobileLayout.labels.length, 1);
    assert.deepEqual(mobileLayout.buttons.map(b => b.stage), [0, 1, 2, 3, 4]);
    const inside = r => r.x >= 0 && r.y >= 0 && r.right <= 390 && r.bottom <= 844;
    assert.ok(inside(mobileLayout.labels[0].rect), 'Active bubble clipped by viewport');
    assert.ok(inside(mobileLayout.playback), 'Playback bar clipped by viewport');
    for (const button of mobileLayout.buttons) { assert.ok(button.visible); assert.ok(inside(button.rect), `Stage ${button.stage} clipped`); }
    for (let i = 1; i < mobileLayout.buttons.length; i++) assert.ok(mobileLayout.buttons[i - 1].rect.right <= mobileLayout.buttons[i].rect.x + 1, 'Stage buttons overlap');
    assert.ok(mobileLayout.labels[0].rect.bottom < mobileLayout.playback.y, 'Active bubble overlaps stage controls');
  });
  await capture('mobile');
  await check('mobile active bubble opens and closes its role detail', async () => {
    await page.locator('.station-label[data-station="1"]').click();
    assert.equal(await page.locator('#detail-title').textContent(), '工程师');
    assert.equal(await page.locator('#detail-panel').isVisible(), true);
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    assert.equal(await page.locator('#detail-panel').isVisible(), false);
  });

  reducedPage = await browser.newPage({ reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } });
  reducedPage.setDefaultTimeout(timeout); reducedPage.setDefaultNavigationTimeout(timeout); watchErrors(reducedPage);
  await reducedPage.goto(base, { waitUntil: 'domcontentloaded', timeout });
  await reducedPage.waitForFunction(() => window.__SHIPBOSS_DEMO__ && document.querySelector('#loading').hidden, null, { timeout });
  for (let stage = 0; stage < 5; stage++) {
    await reducedPage.locator(`[data-stage="${stage}"]`).click();
    await assertStage(reducedPage, 1, stage, `reduced motion ${stage}`);
    if (stage === 3) await check('reduced motion PM callback report', async () => {
      await reducedPage.locator('.station-label[data-station="0"]').click();
      assert.equal(await reducedPage.locator('.report-stamp:visible').textContent(), 'PASS');
      await reducedPage.keyboard.press('Escape');
    });
  }
  await check('replay from completed standby resets to cycle 1 dispatch', async () => {
    await reducedPage.getByRole('button', { name: '自动播放演示', exact: true }).click();
    const replay = await state(reducedPage);
    assert.equal(replay.cycle, 1); assert.equal(replay.stage, 0); assert.equal(replay.playing, true);
  });
  await reducedPage.close(); reducedPage = null;
} catch (error) {
  failures.push({ check: 'smoke runner', message: error.stack || error.message });
  console.error(error);
  try { await capture('failure'); } catch { /* Preserve the original browser error. */ }
} finally {
  try {
    if (!trace) trace = await page.evaluate(() => { const t = window.__study03Trace; if (t) t.active = false; return t; });
  } catch { /* The page may have failed before diagnostics were installed. */ }
  if (trace) await writeFile(`${artifacts}/study03-frame-trace.json`, JSON.stringify(trace));
  if (reducedPage) await reducedPage.close();
  videoPath = await page.video()?.path();
  await context.close(); await browser.close();
}
await check('no browser JavaScript or console errors', () => assert.deepEqual(errors, []));
const { frames, ...traceSummary } = trace || {};
const result = {
  result: failures.length ? 'FAIL' : 'PASS', url: base, startedAt, finishedAt: new Date().toISOString(),
  checks, failures, checkpoints, trace: { ...traceSummary, frameCount: frames?.length || 0, path: `${artifacts}/study03-frame-trace.json` },
  mobileLayout, screenshots, videoPath, errors, consoleWarnings,
};
await writeFile(`${artifacts}/study03-smoke-result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ result: result.result, checks: checks.length, failures, traceFrames: frames?.length || 0, autoDurationMs: trace?.elapsedMs, screenshots, videoPath, resultPath: `${artifacts}/study03-smoke-result.json` }, null, 2));
if (failures.length) process.exitCode = 1;
