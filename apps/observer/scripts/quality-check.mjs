import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { detectQuality } from '../src/quality.js';

const base = process.env.SHIPBOSS_MAP_URL || 'http://127.0.0.1:5311/widget.html';
const checks = [], errors = [], samples = [];
const rendererFor = gpu => ({
  getContext: () => ({
    getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 0x9246 }),
    getParameter: () => gpu,
  }),
});
function detection(memory, cores, gpu) {
  Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: cores, deviceMemory: memory }, configurable: true });
  return detectQuality(rendererFor(gpu), null).tier;
}
assert.equal(detection(8, 8, 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)'), 'high');
assert.equal(detection(8, 8, 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)'), 'balanced');
assert.equal(detection(4, 8, 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)'), 'low');
assert.equal(detection(8, 8, 'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics, OpenGL 4.1)'), 'low');
checks.push('quality detection: M3 high, M1 balanced, 4GB/Intel low');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const lowPage = await browser.newPage({ viewport: { width: 760, height: 640 } });
  lowPage.on('pageerror', error => errors.push(error.message));
  await lowPage.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 4, configurable: true });
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 4, configurable: true });
  });
  await lowPage.goto(base, { waitUntil: 'networkidle' });
  await lowPage.waitForFunction(() => window.__SHIPBOSS_WIDGET__ && document.querySelector('#widget-loading').hidden);
  const low = await lowPage.evaluate(() => window.__SHIPBOSS_WIDGET__.getState());
  assert.equal(low.quality.tier, 'low');
  assert.equal(low.quality.ssao, false); assert.equal(low.quality.bloom, false);
  assert.equal(low.quality.shadows, 1024); assert.ok(low.rendering.frames > 0);
  checks.push('low-memory device selects low tier and disables SSAO/Bloom');
  await lowPage.close();

  const slowPage = await browser.newPage({ viewport: { width: 760, height: 640 } });
  slowPage.on('pageerror', error => errors.push(error.message));
  await slowPage.addInitScript(() => {
    const real = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => setTimeout(() => real(callback), 60);
  });
  await slowPage.goto(`${base}?quality=high`, { waitUntil: 'networkidle' });
  await slowPage.waitForFunction(() => window.__SHIPBOSS_WIDGET__ && document.querySelector('#widget-loading').hidden);
  await slowPage.waitForFunction(() => window.__SHIPBOSS_WIDGET__.getState().quality.downgrades > 0, null, { timeout: 25000 });
  const downgraded = await slowPage.evaluate(() => window.__SHIPBOSS_WIDGET__.getState().quality);
  assert.equal(downgraded.tier, 'balanced'); assert.equal(downgraded.shadows, 1536);
  checks.push('sustained slow frames downgrade high quality to balanced');
  await slowPage.close();

  const phases = [[13, '白天'], [18.6, '黄昏'], [21.5, '夜晚']];
  for (const [hour, label] of phases) {
    const page = await browser.newPage({ viewport: { width: 760, height: 640 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(value => {
      const RealDate = Date, fixed = new RealDate(2026, 0, 1, Math.floor(value), Math.round((value % 1) * 60)).getTime();
      class FakeDate extends RealDate {
        constructor(...args) { if (args.length) super(...args); else super(fixed); }
        static now() { return fixed; }
      }
      window.Date = FakeDate;
    }, hour);
    await page.goto(`${base}?quality=high`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__SHIPBOSS_WIDGET__ && document.querySelector('#widget-loading').hidden);
    const state = await page.evaluate(() => window.__SHIPBOSS_WIDGET__.getState());
    assert.equal(state.time.label, label); assert.equal(state.time.source, 'local');
    samples.push({ hour, label, exposure: state.time.exposure, tier: state.quality.tier });
    await page.close();
  }
  assert.ok(samples[0].exposure > samples[2].exposure);
  checks.push('day, dusk and night use distinct local-time lighting');

  const previewPage = await browser.newPage({ viewport: { width: 760, height: 640 } });
  previewPage.on('pageerror', error => errors.push(error.message));
  await previewPage.goto(`${base}?quality=high`, { waitUntil: 'networkidle' });
  await previewPage.waitForFunction(() => window.__SHIPBOSS_WIDGET__ && document.querySelector('#widget-loading').hidden);
  const previews = [];
  for (let index = 0; index < 5; index++) {
    await previewPage.keyboard.press('t'); await previewPage.waitForTimeout(100);
    previews.push(await previewPage.evaluate(() => window.__SHIPBOSS_WIDGET__.getState().time));
  }
  assert.deepEqual(previews.slice(0, 4).map(item => item.source), ['preview', 'preview', 'preview', 'preview']);
  assert.equal(previews[4].source, 'local');
  checks.push('T cycles dawn, day, dusk, night, then local time');
  await previewPage.close();
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
await mkdir('artifacts', { recursive: true });
const report = { passed: true, checks, samples, errors, simulated: true };
await writeFile('artifacts/quality-check.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
