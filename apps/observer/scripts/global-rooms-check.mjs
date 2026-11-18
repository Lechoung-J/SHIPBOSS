// Dependency-free schema/adapter/box-model regression. Not a WebGL/Electron audition.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createBridgeModel } from '../src/observer-adapter.js';
const require = createRequire(import.meta.url);
const { normalizeObserverState } = require('../desktop/observer-state.cjs');
const actor = id => ({ id, role: { pm: 'pm', 'eng-a': 'engineer', 'eng-b': 'engineer', verifier: 'verifier' }[id], name: id, active: false, motion: 'idle' });
const project = (id, isIdle, skillsUsed) => ({ id, name: id, source: 'EXAMPLE-046 fixture', status: 'reviewing',
  isIdle, skillsUsed, skillPeriod: '今天用过的其它技能', lastActivityAt: '2026-11-12T00:00:00Z',
  idleForSeconds: isIdle ? 600 : 5, actors: ['pm', 'eng-a', 'eng-b', 'verifier'].map(actor), tasks: [], reports: [] });
const state = { version: 1, generatedAt: new Date().toISOString(), source: 'fixture',
  coverage: { complete: false, warnings: ['fixture coverage'] }, projects: [project('dim', true, 19), project('bright', false, 2)] };
const normalized = normalizeObserverState(state);
assert.equal(normalized.ok, true);
assert.equal(normalized.payload.coverage.complete, false);
assert.deepEqual(normalized.payload.projects.map(p => [p.isIdle, p.status, p.skillsUsed]), [[true, 'reviewing', 19], [false, 'reviewing', 2]]);
const bridge = createBridgeModel(normalized.payload);
assert.deepEqual(bridge.getProjects().map(p => p.isIdle), [true, false]);
const stale = createBridgeModel(normalized.payload, { now: () => Date.now() + 60000 });
assert.equal(stale.getProject('bright').status, 'reviewing');
assert.equal(stale.getProject('bright').isIdle, true);
bridge.setState({ ...normalized.payload, projects: [normalized.payload.projects[1]] });
assert.equal(bridge.getProject('dim').status, 'reviewing');
assert.equal(bridge.getProject('dim').isIdle, true);

// Execute the real pile builder against a minimal scene graph. This checks the
// visible box count and footprint math, not materials, pixels or GPU behavior.
class Vec { set(...values) { [this.x, this.y, this.z] = values; } setScalar(v) { this.set(v, v, v); } }
class Group { constructor() { this.children = []; this.position = new Vec(); this.scale = new Vec(); this.rotation = {}; this.userData = {}; } add(v) { this.children.push(v); } }
class Mesh extends Group { constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; } }
class Material { constructor(v) { Object.assign(this, v); } }
const stub = { Group, Mesh, MeshStandardMaterial: Material, BoxGeometry: class {}, PlaneGeometry: class {} };
globalThis.__ROOM_TEST_THREE__ = stub;
const source = (await readFile(new URL('../src/room-style.js', import.meta.url), 'utf8')).replace("import * as THREE from 'three';", 'const THREE = globalThis.__ROOM_TEST_THREE__;');
const { createSkillPile, roomIsIdle } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const room = new Group(); const pile = createSkillPile(room);
for (const count of [0, 2, 14, 15, 19, 64, 256, 300, 2]) {
  pile.setCount(count);
  assert.equal(pile.count, count);
  assert.equal(pile.shown, Math.min(count, 256));
  assert.equal(pile.group.children.filter(box => box.visible).length, Math.min(count, 256));
}
assert.equal(roomIsIdle(normalized.payload.projects[0]), true);
assert.equal(roomIsIdle(normalized.payload.projects[1]), false);
assert.equal(roomIsIdle({ status: 'idle' }), true);
assert.equal(roomIsIdle({ status: 'idle', isIdle: false }), false);
delete globalThis.__ROOM_TEST_THREE__;
console.log('EXAMPLE-046: two-room schema + adapter + light selector + 19-box model OK (not Electron/render verification)');
