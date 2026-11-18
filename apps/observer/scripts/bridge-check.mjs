import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createBridgeModel } from '../src/observer-adapter.js';

const require = createRequire(import.meta.url);
const { normalizeObserverState } = require('../desktop/observer-state.cjs');
const root = fileURLToPath(new URL('..', import.meta.url));
let checks = 0;
const check = (name, run) => { run(); checks += 1; console.log(`✓ ${name}`); };
const actor = (id, active = false, motion = 'idle', taskId = null) => ({
  id, role: { pm: 'pm', 'eng-a': 'engineer', 'eng-b': 'engineer', verifier: 'verifier' }[id],
  name: id, active, taskId, motion: active ? motion : 'idle', activity: active ? '真实活动' : '', papers: active ? 1 : 0,
});
const task = (overrides = {}) => ({
  id: 'EXAMPLE-900', title: '真实任务', status: 'implementing', assignee: 'eng-a', attempt: 1,
  motion: 'working', activity: '实现中', verdict: null, verification: null, evidence: [], simulated: false, ...overrides,
});
const project = (overrides = {}) => ({
  id: 'shipboss', name: 'SHIPBOSS', source: 'shipboss-skill · test', skillsUsed: 0, status: 'implementing',
  activity: '1 项进行中', needsAttention: false, awaitingUser: false, pendingQuestion: null,
  recording: false, scribeActivity: '', tasks: [task()],
  actors: [actor('pm'), actor('eng-a', true, 'working', 'EXAMPLE-900'), actor('eng-b'), actor('verifier')],
  reports: [], epoch: 1, time: 12, ...overrides,
});
const wrap = (projects, extra = {}) => ({ version: 1, generatedAt: '2026-11-12T00:00:00.000Z', source: 'shipboss-skill', projects, ...extra });

const example = wrap([project(), project({id: 'website', name: 'Example website'}), project({id: 'tool', name: 'Example tool'})]);
const exampleResult = normalizeObserverState(example);
assert.equal(exampleResult.ok, true);
assert.equal(exampleResult.payload.projects.length, 3);
assert.deepEqual(exampleResult.payload.projects.map(item => item.id), ['shipboss', 'website', 'tool']);
checks += 1; console.log('✓ the shipped example satisfies the v1 contract');

check('reference writer quirks are normalized without losing the project', () => {
  const result = normalizeObserverState(wrap([project({
    status: 'needs-human', needsAttention: true, awaitingUser: false,
    pendingQuestion: '需要老板决定装不装',
    tasks: [task({ id: 'EXAMPLE-900', status: 'needs-human', motion: 'waiting', activity: 'blocked' })],
  })]));
  assert.equal(result.ok, true);
  const item = result.payload.projects[0];
  assert.equal(item.pendingQuestion.question, '需要老板决定装不装');
  assert.equal(item.pendingQuestion.id, 'pending-question');
  const pm = item.actors.find(entry => entry.id === 'pm');
  assert.equal(pm.active, true, 'waiting PM must be active');
  assert.equal(pm.motion, 'waiting');
  assert.equal(item.counts.queued, 1, 'needs-human task counts as queued');
});

check('one bad project does not take down a good project', () => {
  const result = normalizeObserverState(wrap([project(), { id: 'broken', actors: [] }]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload.projects.map(item => item.id), ['shipboss']);
});

check('invalid wrappers are rejected so main keeps the prior snapshot', () => {
  for (const value of [null, [], {}, { ...wrap([project()]), version: 2 }, { version: 1, projects: 'x' }]) {
    const result = normalizeObserverState(value);
    assert.equal(result.ok, false, JSON.stringify(value)?.slice(0, 80));
  }
  assert.equal(normalizeObserverState(wrap([])).ok, true, 'an empty project list is valid');
  const allBad = normalizeObserverState(wrap([{ id: 'x' }, { id: 'y' }]));
  assert.equal(allBad.ok, false);
  assert.equal(allBad.error, 'no-valid-projects');
});

check('invalid enums fall back instead of crashing the room', () => {
  const result = normalizeObserverState(wrap([project({
    status: 'mystery',
    actors: [actor('pm'), actor('eng-a', true, 'dancing', 'EXAMPLE-900'), actor('eng-b'), actor('verifier', true, 'mystery', 'EXAMPLE-900')],
    tasks: [task({ status: 'mystery', motion: 'dancing', assignee: 'nobody' })],
  })]));
  assert.equal(result.ok, true);
  const item = result.payload.projects[0];
  assert.equal(item.actors[1].motion, 'idle');
  assert.equal(item.tasks[0].status, 'queued');
  assert.equal(item.tasks[0].motion, 'idle');
  assert.equal(item.tasks[0].assignee, 'pm');
  assert.equal(item.status, 'dispatching', 'unknown task data must not be declared done');
});

check('adapter exposes only the read-only model surface and ignores invalid updates', () => {
  const model = createBridgeModel();
  assert.deepEqual(Object.keys(model).sort(), ['getProject', 'getProjects', 'getStatus', 'kind', 'setState', 'snapshot', 'tick']);
  assert.equal(model.snapshot().length, 0);
  model.tick(1); assert.equal(model.snapshot().length, 0, 'bridge tick never advances demo events');
  model.setState({ projects: [project()] });
  assert.equal(model.getProject('shipboss').name, 'SHIPBOSS');
  assert.equal(model.getProjects()[0].id, 'shipboss');
  assert.equal(model.getProject('missing'), undefined);
  model.setState(null); assert.equal(model.snapshot().length, 1, 'invalid updates keep the last snapshot');
});

console.log(`Bridge checks passed: ${checks} groups.`);
