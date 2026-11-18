import assert from 'node:assert/strict';
import { sampleTimeOfDay } from '../src/time-of-day.js';
import { observationLabel } from '../src/observation-label.js';
const at = hour => new Date(2026, 10, 13, Math.floor(hour), Math.floor((hour % 1) * 60));
const night = sampleTimeOfDay(at(0));
for (const hour of [0, 1, 2, 3, 3.4, 4, 4.75, 21, 23.5]) {
  const s = sampleTimeOfDay(at(hour));
  assert.equal(s.label, '夜晚');
  assert.equal(s.sky.getHexString(), night.sky.getHexString(), `night sky at ${hour}`);
  assert.equal(s.sunIntensity, .08, `no daytime sunlight at ${hour}`);
  assert.equal(s.interiorIntensity, 32, `indoor lamps at ${hour}`);
}
const dawn = sampleTimeOfDay(at(6.5)), day = sampleTimeOfDay(at(13)), dusk = sampleTimeOfDay(at(18.6));
assert.equal(dawn.label, '清晨'); assert.equal(day.label, '白天'); assert.equal(dusk.label, '黄昏');
assert.notEqual(day.sky.getHexString(), night.sky.getHexString());
assert.ok(dawn.sunIntensity > .08 && dawn.sunIntensity < day.sunIntensity);
for (const boundary of [4.8, 6.5, 7.5, 16.5, 18.2, 19.4, 20.5]) {
  const before = sampleTimeOfDay(new Date(2026, 10, 13, 0, 0, Math.round(boundary * 3600) - 1));
  const after = sampleTimeOfDay(new Date(2026, 10, 13, 0, 0, Math.round(boundary * 3600) + 1));
  assert.ok(Math.abs(before.sunIntensity - after.sunIntensity) < .01, `smooth light at ${boundary}`);
  assert.ok(Math.hypot(before.sky.r-after.sky.r, before.sky.g-after.sky.g, before.sky.b-after.sky.b) < .01, `smooth sky at ${boundary}`);
}
const label = args => observationLabel({ count: 10, bridge: true, status: 'live', hour: 3 + 22 / 60 + 59 / 3600, phase: '夜晚', ...args });
assert.equal(label(), '10 个项目 · 实时同步 · 夜晚 03:22');
assert.match(label({status:'stale'}), /同步中断/);
assert.match(label({status:'waiting'}), /等待状态/);
assert.match(label({bridge:false}), /演示/);
assert.match(label({preview:true,hour:21.5}), /预览 夜晚 21:30/);
assert.match(label({hour:23 + 59 / 60 + 59 / 3600}), /23:59$/);
console.log('PASS overnight palette stays night, dawn/day/dusk remain smooth, live status distinguishes sync/preview/demo.');
