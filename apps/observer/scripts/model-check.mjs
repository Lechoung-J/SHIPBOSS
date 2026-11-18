import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createProjectModel, PROJECT_CYCLE_SECONDS } from '../src/project-model.js';
import { createParallelShifts } from '../src/parallel-shifts.js';

let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`✓ ${name}`); };
const actor = (project, id) => project.actors.find(item => item.id === id);
const task = (project, assignee) => project.tasks.find(item => item.assignee === assignee);
const activeIds = project => project.actors.filter(item => item.active).map(item => item.id);
const slots = ['pm', 'eng-a', 'eng-b', 'verifier'];
const motions = new Set(['working', 'thinking', 'testing', 'rejected', 'waiting', 'idle']);
const timeline = () => {
  const model = createProjectModel(); let now = 0;
  return { model, at(time) { model.tick(time - now); now = time; return model.getProject('shipboss'); } };
};

check('three stable projects, four actor slots, and explicit simulated outcomes', () => {
  const model = createProjectModel();
  assert.deepEqual(model.getProjects().map(({ id, name }) => [id, name]), [
    ['shipboss', 'SHIPBOSS'], ['website', '网站改版'], ['tool', '小工具'],
  ]);
  for (const project of model.snapshot()) {
    assert.match(project.source, /^(DSH|Codex) · 演示$/);
    assert.equal(project.simulated, true);
    assert.deepEqual(project.actors.map(({ id }) => id), slots);
    assert.equal(project.actors.filter(item => item.role === 'pm').length, 1);
    for (const item of project.actors) {
      assert.equal(typeof item.active, 'boolean'); assert.equal(typeof item.papers, 'number');
      assert.ok(motions.has(item.motion)); assert.match(item.activity, /演示/);
    }
  }
  const initial = model.getProject('shipboss');
  assert.deepEqual(activeIds(initial), ['pm']); assert.equal(actor(initial, 'pm').motion, 'thinking');
  assert.equal(initial.counts.queued, 2); assert.equal(initial.awaitingUser, false); assert.equal(initial.pendingQuestion, null);
  assert.notEqual(task(initial, 'eng-a').id, task(initial, 'eng-b').id);
  assert.equal(model.getProject('tool').status, 'done'); assert.equal(model.getProject('tool').reports.length, 1);
  assert.equal(model.getProject('unknown'), undefined); assert.equal(PROJECT_CYCLE_SECONDS, 90);
});

check('waiting website keeps a seated-capable PM and a persistent, simulated question', () => {
  const model = createProjectModel(), initial = model.getProject('website');
  assert.equal(initial.status, 'needs-human'); assert.equal(initial.needsAttention, true); assert.equal(initial.awaitingUser, true);
  assert.deepEqual(activeIds(initial), ['pm']); assert.equal(actor(initial, 'pm').motion, 'waiting');
  assert.equal(actor(initial, 'pm').papers, 1); assert.equal(actor(initial, 'pm').taskId, initial.tasks[0].id);
  assert.equal(initial.pendingQuestion.sessionId, 'demo'); assert.equal(initial.pendingQuestion.simulated, true);
  assert.ok(initial.pendingQuestion.id.startsWith('website-e1-')); assert.match(initial.pendingQuestion.question, /演示.*？/);
  assert.equal(initial.reports[0].verdict, 'NEEDS-HUMAN · 演示');
  assert.deepEqual(Object.keys(initial.pendingQuestion).sort(), ['id', 'question', 'sessionId', 'simulated']);
  model.tick(1000);
  const later = model.getProject('website');
  for (const key of ['tasks', 'actors', 'reports', 'events', 'pendingQuestion', 'needsAttention', 'awaitingUser']) assert.deepEqual(later[key], initial[key]);
  assert.equal(later.time, initial.time + 1000);
});

check('think, code, and test phases overlap independently and tests remain implementation', () => {
  const { at, model } = timeline();
  assert.deepEqual(activeIds(at(4)), ['pm', 'eng-a']); assert.equal(actor(model.getProject('shipboss'), 'eng-a').motion, 'thinking');
  assert.deepEqual(activeIds(at(6)), ['pm', 'eng-a', 'eng-b']);
  const workingA = at(7);
  assert.deepEqual(activeIds(workingA), ['eng-a', 'eng-b']); assert.equal(actor(workingA, 'eng-a').motion, 'working');
  assert.equal(actor(workingA, 'eng-b').motion, 'thinking');
  assert.equal(actor(at(10), 'eng-b').motion, 'working');
  const testingA = at(14);
  assert.equal(actor(testingA, 'eng-a').motion, 'testing'); assert.equal(testingA.counts.implementing, 2); assert.equal(testingA.counts.testing, 1);
  assert.equal(testingA.engineerCount, 2); assert.deepEqual(model.getProjects()[0].counts, testingA.counts);
  assert.equal(actor(at(21), 'eng-a').motion, 'working');
  const firstVerification = at(22);
  assert.equal(task(firstVerification, 'eng-a').status, 'verifying'); assert.equal(actor(firstVerification, 'eng-a').active, false);
  assert.equal(actor(firstVerification, 'verifier').motion, 'thinking'); assert.equal(firstVerification.reports.length, 0);
  assert.equal(actor(at(25), 'verifier').motion, 'testing');
  const testingB = at(28);
  assert.equal(actor(testingB, 'eng-b').motion, 'testing'); assert.equal(testingB.counts.implementing, 1); assert.equal(testingB.counts.testing, 1);
});

check('A fails, retains FAIL during rework, then passes a separate recorded attempt', () => {
  const { at } = timeline();
  const initial = at(0), idA = task(initial, 'eng-a').id, idB = task(initial, 'eng-b').id;
  const rejected = at(31);
  assert.equal(task(rejected, 'eng-a').status, 'rework'); assert.equal(task(rejected, 'eng-a').attempt, 1);
  assert.equal(task(rejected, 'eng-a').verdict, 'FAIL · 演示'); assert.equal(task(rejected, 'eng-a').verification, 'rejected');
  assert.deepEqual(activeIds(rejected), ['eng-b', 'verifier']); assert.equal(actor(rejected, 'verifier').motion, 'rejected');
  assert.equal(actor(rejected, 'verifier').taskId, idA); assert.equal(rejected.verifierCount, 1);
  assert.equal(rejected.counts.rework, 1); assert.equal(rejected.counts.done, 0); assert.equal(rejected.queuedReports, 0);
  const failedReport = rejected.reports[0];
  assert.equal(failedReport.taskId, idA); assert.equal(failedReport.attempt, 1); assert.equal(failedReport.verdict, 'FAIL · 演示');
  assert.equal(failedReport.eventId, rejected.latestEvent.id); assert.equal(failedReport.time, 31);
  assert.equal(actor(at(34.999), 'verifier').motion, 'rejected');
  const rework = at(35);
  assert.equal(task(rework, 'eng-a').status, 'implementing'); assert.equal(task(rework, 'eng-a').attempt, 2);
  assert.equal(task(rework, 'eng-a').verdict, 'FAIL · 演示'); assert.equal(task(rework, 'eng-a').id, idA);
  assert.deepEqual(activeIds(rework), ['eng-a', 'eng-b']); assert.equal(actor(rework, 'eng-a').motion, 'thinking');
  assert.equal(actor(rework, 'eng-b').motion, 'testing');
  assert.equal(actor(at(38), 'eng-a').motion, 'working'); assert.equal(actor(at(39), 'eng-b').motion, 'working');
  assert.equal(actor(at(47), 'eng-a').motion, 'testing'); assert.equal(actor(at(53), 'eng-a').motion, 'working');
  const again = at(55);
  assert.equal(task(again, 'eng-a').verification, 'active'); assert.equal(task(again, 'eng-a').verdict, 'FAIL · 演示');
  assert.equal(actor(again, 'verifier').motion, 'thinking'); assert.equal(actor(again, 'eng-b').active, true);
  assert.equal(actor(at(58), 'verifier').motion, 'testing');
  const queued = at(60);
  assert.deepEqual(queued.verificationQueue, [idB]); assert.equal(actor(queued, 'verifier').taskId, idA);
  assert.equal(task(queued, 'eng-b').verification, 'queued');
  const passed = at(64);
  assert.equal(task(passed, 'eng-a').verdict, 'PASS · 演示'); assert.equal(task(passed, 'eng-a').status, 'reviewing');
  assert.equal(task(passed, 'eng-b').verification, 'queued'); assert.deepEqual(activeIds(passed), ['pm']);
  assert.equal(actor(passed, 'pm').taskId, idA); assert.equal(passed.queuedReports, 1); assert.equal(passed.counts.done, 0);
  assert.deepEqual(passed.reports.map(item => [item.taskId, item.attempt, item.verdict]), [[idA, 1, 'FAIL · 演示'], [idA, 2, 'PASS · 演示']]);
  assert.deepEqual(passed.reports[0], failedReport); assert.notEqual(passed.reports[0].id, passed.reports[1].id);
  assert.equal(task(passed, 'eng-a').evidence.length, 2);
  assert.deepEqual(passed.events.filter(item => /verification-(rejected|passed)/.test(item.type)).map(item => [item.time, item.attempt]), [[31, 1], [64, 2]]);
  const verifyingB = at(65);
  assert.deepEqual(activeIds(verifyingB), ['pm', 'verifier']); assert.equal(actor(verifyingB, 'verifier').taskId, idB);
  assert.equal(actor(at(68), 'verifier').motion, 'testing');
  assert.equal(task(at(70), 'eng-a').status, 'done');
  const callbackB = at(75);
  assert.equal(actor(callbackB, 'pm').taskId, idB); assert.equal(callbackB.reports.length, 3); assert.deepEqual(activeIds(callbackB), ['pm']);
  const complete = at(82);
  assert.equal(complete.status, 'done'); assert.equal(complete.counts.done, 2); assert.deepEqual(activeIds(complete), []);
  assert.equal(complete.tasks[0].id, idA); assert.equal(complete.tasks[1].id, idB);
  assert.equal(at(89.99).epoch, 1);
  const repeated = at(90);
  assert.equal(repeated.epoch, 2); assert.equal(repeated.time, 0); assert.equal(repeated.reports.length, 0);
  assert.deepEqual(activeIds(repeated), ['pm']); assert.notEqual(task(repeated, 'eng-a').id, idA);
});

check('unselected clocks advance and static outcomes persist across many epochs', () => {
  const model = createProjectModel(), website = model.getProject('website'), tool = model.getProject('tool');
  model.tick(32);
  assert.equal(task(model.getProject('shipboss'), 'eng-a').status, 'rework');
  assert.equal(actor(model.getProject('shipboss'), 'eng-b').motion, 'testing');
  model.tick(1000);
  for (const initial of [website, tool]) {
    const current = model.getProject(initial.id);
    for (const key of ['tasks', 'actors', 'reports', 'latestEvent', 'status', 'needsAttention', 'epoch']) assert.deepEqual(current[key], initial[key]);
    assert.equal(current.time, initial.time + 1032); assert.equal(current.elapsed, 1032);
  }
});

check('serial ownership, report history, and ordered events remain valid over three loops', () => {
  const model = createProjectModel(), lastEvents = new Map();
  for (let step = 0; step < PROJECT_CYCLE_SECONDS * 3 * 4; step++) {
    model.tick(.25);
    for (const project of model.snapshot()) {
      const expected = { implementing: 0, testing: 0, rework: 0, verifying: 0, reviewing: 0, done: 0, queued: 0 };
      for (const item of project.tasks) {
        assert.ok(item.status in expected); expected[item.status]++;
        if (item.status === 'implementing' && item.motion === 'testing') expected.testing++;
        assert.ok(item.id.startsWith(`${project.id}-e${project.epoch}-`)); assert.equal(item.simulated, true);
        assert.ok(item.attempt === 1 || item.attempt === 2);
        for (const evidence of item.evidence) assert.match(evidence, /演示/);
      }
      assert.deepEqual(project.counts, expected);
      assert.equal(new Set(project.tasks.map(item => item.id)).size, project.tasks.length);
      assert.equal(new Set(project.reports.map(item => `${item.taskId}/${item.attempt}`)).size, project.reports.length);
      assert.equal(new Set(project.reports.map(item => item.id)).size, project.reports.length);
      assert.equal(new Set(project.verificationQueue).size, project.verificationQueue.length);
      const verifier = actor(project, 'verifier'), verifying = project.tasks.filter(item => item.verification === 'active');
      assert.ok(verifying.length <= 1); assert.equal(project.verifierCount, Number(verifier.active));
      if (verifier.motion === 'rejected') {
        assert.equal(verifying.length, 0); assert.equal(project.tasks.find(item => item.id === verifier.taskId).verification, 'rejected');
      } else {
        assert.equal(verifier.active, verifying.length === 1); if (verifier.active) assert.equal(verifier.taskId, verifying[0].id);
      }
      for (const id of project.verificationQueue) {
        assert.equal(project.tasks.find(item => item.id === id)?.verification, 'queued'); assert.notEqual(id, verifier.taskId);
      }
      assert.equal(project.engineerCount, project.actors.filter(item => item.role === 'engineer' && item.active).length);
      for (const id of ['eng-a', 'eng-b']) {
        const engineer = actor(project, id);
        assert.equal(engineer.active, task(project, id)?.status === 'implementing');
        if (engineer.taskId) assert.equal(engineer.taskId, task(project, id).id);
        assert.ok(motions.has(engineer.motion));
      }
      assert.equal(project.latestEvent.projectId, project.id); assert.equal(project.latestEvent.simulated, true);
      const prior = lastEvents.get(project.id);
      if (prior?.epoch === project.epoch) assert.ok(project.latestEvent.seq >= prior.seq);
      lastEvents.set(project.id, project.latestEvent);
      assert.equal(project.events.at(-1).id, project.latestEvent.id);
      project.events.forEach((event, index) => {
        assert.equal(event.seq, index + 1); assert.equal(event.id, `${project.id}-e${project.epoch}-event-${event.seq}`);
        assert.equal(event.projectId, project.id); assert.equal(event.simulated, true);
        if (index) assert.ok(event.time >= project.events[index - 1].time);
        if (event.taskId) assert.ok(project.tasks.some(item => item.id === event.taskId));
      });
      assert.ok(project.actors.filter(item => item.role === 'pm' && item.active).length <= 1);
      if (project.id === 'shipboss') {
        assert.equal(project.queuedReports, project.counts.reviewing);
        if (project.queuedReports) {
          assert.equal(actor(project, 'pm').active, true); assert.equal(actor(project, 'pm').papers, project.queuedReports);
          assert.equal(project.tasks.find(item => item.id === actor(project, 'pm').taskId).status, 'reviewing');
        }
      }
      for (const report of project.reports) {
        assert.equal(report.simulated, true); assert.ok(project.tasks.some(item => item.id === report.taskId));
        assert.ok(project.events.some(item => item.id === report.eventId && item.attempt === report.attempt));
        for (const key of ['title', 'verdict', 'changed', 'verified', 'risk', 'needsYou']) assert.match(report[key], /演示/);
      }
    }
  }
});

check('large, frame-sized, and partitioned ticks have identical deterministic results', () => {
  const direct = createProjectModel(), frames = createProjectModel(); direct.tick(PROJECT_CYCLE_SECONDS);
  for (let frame = 0; frame < PROJECT_CYCLE_SECONDS * 60; frame++) frames.tick(1 / 60);
  assert.deepEqual(frames.snapshot(), direct.snapshot());
  const partitioned = createProjectModel(); let total = 0;
  for (const dt of [4, 2, 1, 7, 7, 1, 3, 3, 3, 4, 12, 6, 2, 5, 4, 1, 5, 5, 7, 8]) {
    total += dt; partitioned.tick(dt);
    const oneTick = createProjectModel(); oneTick.tick(total); assert.deepEqual(partitioned.snapshot(), oneTick.snapshot());
  }
  const skipped = createProjectModel(); skipped.tick(PROJECT_CYCLE_SECONDS * 10000 + 64);
  const current = skipped.getProject('shipboss');
  assert.equal(current.epoch, 10001); assert.equal(current.time, 64); assert.equal(current.reports.length, 2);
  assert.equal(current.counts.reviewing, 1); assert.equal(current.verificationQueue.length, 1);
  const before = skipped.snapshot(); skipped.tick(0); assert.deepEqual(skipped.snapshot(), before);
});

check('addProject is a pure idle-demo insertion with atomic duplicate and metadata handling', () => {
  const model = createProjectModel(); model.tick(70); const original = model.snapshot();
  const added = model.addProject({ id: 'docs', name: '文档站', source: 'Codex' });
  assert.equal(added.id, 'docs'); assert.equal(added.name, '文档站'); assert.equal(added.source, 'Codex · 演示');
  assert.equal(added.status, 'idle'); assert.equal(added.simulated, true); assert.equal(added.time, 70);
  assert.deepEqual(added.tasks, []); assert.deepEqual(added.actors.map(item => item.id), slots); assert.deepEqual(activeIds(added), []);
  assert.equal(added.latestEvent.type, 'project-added'); assert.equal(added.latestEvent.time, 70); assert.equal(added.pendingQuestion, null);
  assert.deepEqual(model.snapshot().slice(0, 3), original); assert.deepEqual(model.getProjects().map(item => item.id), ['shipboss', 'website', 'tool', 'docs']);
  const stable = model.snapshot();
  assert.throws(() => model.addProject({ id: 'docs', name: 'other' }), RangeError);
  for (const input of [undefined, null, {}, { id: 'bad id', name: 'name' }, { id: 'x', name: ' ' }, { id: 'x', name: 'name', source: 1 }]) assert.throws(() => model.addProject(input), TypeError);
  assert.deepEqual(model.snapshot(), stable);
  added.actors[0].active = true; added.events[0].type = 'mutated'; assert.deepEqual(model.snapshot(), stable);
  model.tick(25); assert.equal(model.getProject('docs').time, 95); assert.equal(model.getProject('docs').status, 'idle');
  assert.equal(createProjectModel().getProjects().length, 3, 'insertion cannot leak into another model');
});

check('detached snapshots and summaries cannot mutate questions, events, reports, or other instances', () => {
  const model = createProjectModel(), separate = createProjectModel(), separateBefore = separate.snapshot(); model.tick(64);
  const expected = model.snapshot(), copy = model.getProject('shipboss');
  copy.tasks[0].status = 'queued'; copy.tasks[0].evidence.push('mutated'); copy.actors[0].active = false;
  copy.reports[0].verified = 'mutated'; copy.counts.reviewing = 999; copy.verificationQueue.push('mutated');
  copy.latestEvent.projectId = 'website'; copy.events[0].activity = 'mutated'; model.snapshot()[0].tasks.length = 0;
  model.getProject('website').pendingQuestion.sessionId = 'real'; model.getProjects()[1].pendingQuestion.question = 'mutated';
  model.getProjects()[0].counts.testing = 999; model.getProjects()[0].name = 'mutated';
  assert.deepEqual(model.snapshot(), expected); assert.deepEqual(separate.snapshot(), separateBefore);
});

check('invalid deltas fail atomically and reads do not advance time', () => {
  const model = createProjectModel(); model.tick(31); const before = model.snapshot();
  for (const dt of [-1, NaN, Infinity, -Infinity, '1', null, undefined]) {
    assert.throws(() => model.tick(dt), RangeError); assert.deepEqual(model.snapshot(), before);
  }
  model.getProject('website'); model.getProjects(); assert.deepEqual(model.snapshot(), before);
});

function fixture(reducedMotion = false, options = {}) {
  const desks = [-5.1, -1.7, 1.7, 5.1].map(x => {
    const character = { root: new THREE.Object3D(), lastPose: null, pose(seated, time, walking, working, still) { this.lastPose = { seated, time, walking, working, still }; } };
    return { x, z: -1.45, character };
  });
  const door = { hinge: new THREE.Object3D() }, shifts = createParallelShifts(desks, door, reducedMotion, options);
  let time = 0;
  const advance = (duration, inspect = () => {}) => {
    const frames = Math.ceil(duration * 120), delta = duration / frames;
    for (let frame = 0; frame < frames; frame++) {
      const positions = desks.map(desk => desk.character.root.position.clone());
      time += delta; shifts.update(time, delta);
      const snapshot = shifts.snapshot();
      assert.ok(snapshot.filter(item => item.crossingDoor).length <= 1, 'only one actor may cross this room doorway');
      desks.forEach((desk, index) => {
        assert.ok(desk.character.root.position.distanceTo(positions[index]) <= 5.6 * delta + 1e-6, 'routes never teleport between frames');
        const { x, z } = desk.character.root.position;
        assert.ok(z >= -.331 && z <= 3.71, 'paths remain in front of desks and away from the back bookcase');
        if (x < -6.84 && x > -7.2) assert.ok(z > .55 && z < 1.96, 'wall crossing stays inside the doorway');
        if (desk.character.lastPose?.working) assert.equal(snapshot[index].motion, 'working');
      });
      inspect(snapshot);
    }
  };
  return { shifts, desks, door, advance };
}
const states = active => slots.map(id => ({ id, taskId: `demo-${id}`, active: id in active, motion: active[id] || 'idle', activity: '演示：动作检查' }));
const physical = (room, id) => room.shifts.snapshot().find(item => item.id === id);

check('normal snapshots walk to lounge/pacing and waiting PM, without immediate restoration', () => {
  const room = fixture(false, {
    restPositions: { 'eng-a': new THREE.Vector3(-5.43, .04, 3.23), 'eng-b': new THREE.Vector3(-3.97, .04, 3.23) },
    pacingCorridor: { minX: -2, maxX: 2, z: 2.1 },
  });
  room.shifts.sync(states({ pm: 'waiting', 'eng-a': 'testing', 'eng-b': 'testing', verifier: 'rejected' }), true);
  assert.ok(room.shifts.snapshot().every(a => a.mode === 'absent' && !a.visible), 'normal immediate does not bypass entry');
  room.advance(14);
  const pm = physical(room, 'pm'), a = physical(room, 'eng-a'), b = physical(room, 'eng-b'), verifier = physical(room, 'verifier');
  assert.equal(pm.mode, 'working'); assert.equal(pm.motion, 'waiting'); assert.equal(pm.seated, 1); assert.equal(pm.x, -5.2);
  assert.equal(a.mode, 'resting'); assert.equal(a.seatState, 'sofa'); assert.equal(a.seated, 1);
  assert.deepEqual(a.position, { x: -5.43, y: .04, z: 3.23 }); assert.equal(room.desks[1].character.root.rotation.y, Math.PI);
  assert.equal(b.mode, 'pacing'); assert.equal(b.seated, 0); assert.equal(b.z, 2.1); assert.ok(b.x >= -2 && b.x <= 2);
  assert.equal(verifier.mode, 'working'); assert.equal(verifier.motion, 'rejected'); assert.equal(verifier.seated, 1);
  for (const [index, desk] of room.desks.entries()) {
    assert.equal(desk.character.lastPose.working, false);
    assert.equal(desk.character.lastPose.still, index !== 2, 'only the pacing engineer keeps walking');
  }
  room.shifts.sync(states({ pm: 'thinking', verifier: 'testing' }), true);
  room.advance(10);
  assert.equal(physical(room, 'pm').mode, 'working'); assert.equal(physical(room, 'verifier').mode, 'working');
  assert.equal(physical(room, 'eng-a').visible, false); assert.equal(physical(room, 'eng-b').visible, false);
  room.advance(.5);
  assert.equal(room.desks[0].character.lastPose.working, false); assert.equal(room.desks[3].character.lastPose.working, false);
  room.shifts.sync(states({ 'eng-b': 'testing', verifier: 'rejected' }).filter(item => item.active).reverse(), true);
  room.advance(10);
  assert.deepEqual(room.shifts.snapshot().filter(item => item.visible).map(item => item.id), ['eng-b', 'verifier']);
  assert.equal(physical(room, 'eng-b').mode, 'pacing'); assert.equal(physical(room, 'verifier').motion, 'rejected');
});

check('A reaches the sofa facing front, returns to work, and exits directly from the lounge', () => {
  const room = fixture(); room.shifts.sync(states({ 'eng-a': 'working' }), true);
  room.advance(4);
  room.shifts.sync(states({ 'eng-a': 'testing' }));
  let corridor = false;
  room.advance(3.2, snapshot => { if (snapshot[1].z === 1.7 && snapshot[1].x < -2) corridor = true; });
  assert.equal(corridor, true); assert.equal(physical(room, 'eng-a').mode, 'resting'); assert.equal(physical(room, 'eng-a').seated, 1);
  assert.equal(room.desks[1].character.root.rotation.y, Math.PI); assert.equal(room.desks[1].character.lastPose.working, false);
  const atRest = room.desks[1].character.root.position.clone();
  room.shifts.sync(states({ 'eng-a': 'working' })); assert.ok(room.desks[1].character.root.position.equals(atRest));
  room.advance(3.2); assert.equal(physical(room, 'eng-a').mode, 'working'); assert.equal(physical(room, 'eng-a').x, -1.8);
  assert.equal(physical(room, 'eng-a').z, -.33); assert.equal(room.desks[1].character.lastPose.working, true);
  room.shifts.sync(states({ 'eng-a': 'testing' }), true);
  room.advance(4);
  room.shifts.sync(states({})); assert.ok(room.desks[1].character.root.position.equals(atRest));
  room.advance(3, snapshot => { assert.ok(snapshot[1].x <= -5.429, 'lounge exit never detours or teleports to the desk'); });
  assert.equal(physical(room, 'eng-a').mode, 'absent'); assert.equal(physical(room, 'eng-a').visible, false);
});

check('B paces slowly within its own bounds and returns when testing ends', () => {
  const room = fixture(); room.shifts.sync(states({ 'eng-b': 'working', pm: 'waiting' }), true);
  room.advance(6);
  room.shifts.sync(states({ 'eng-b': 'testing', pm: 'waiting' })); room.advance(2);
  assert.equal(physical(room, 'eng-b').mode, 'pacing');
  let last = room.desks[2].character.root.position.clone(), min = Infinity, max = -Infinity;
  room.advance(7, snapshot => {
    const current = room.desks[2].character.root.position;
    assert.ok(current.distanceTo(last) <= 1.05 / 120 + 1e-6); last = current.clone();
    assert.equal(snapshot[2].z, 2.2); assert.ok(snapshot[2].x >= -2 && snapshot[2].x <= 1.2);
    min = Math.min(min, snapshot[2].x); max = Math.max(max, snapshot[2].x);
    assert.equal(snapshot[0].x, -5.2); assert.equal(snapshot[0].seated, 1); assert.equal(snapshot[0].motion, 'waiting');
    assert.equal(room.desks[2].character.lastPose.working, false);
  });
  assert.ok(min < -1.95 && max > 1.15);
  room.shifts.sync(states({ 'eng-b': 'thinking', pm: 'waiting' })); room.advance(2);
  assert.equal(physical(room, 'eng-b').mode, 'working'); assert.equal(physical(room, 'eng-b').seated, 1);
  assert.equal(physical(room, 'eng-b').motion, 'thinking'); assert.equal(room.desks[2].character.lastPose.working, false);
});

check('rest trips can reverse repeatedly from the actual path without stale-seat exits', () => {
  const room = fixture(); room.shifts.sync(states({ 'eng-a': 'working' }), true);
  room.advance(4);
  room.shifts.sync(states({ 'eng-a': 'testing' })); room.advance(1.1);
  assert.equal(physical(room, 'eng-a').mode, 'to-rest');
  const before = room.desks[1].character.root.position.clone();
  room.shifts.sync(states({ 'eng-a': 'working' })); assert.ok(room.desks[1].character.root.position.equals(before)); room.advance(.2);
  room.shifts.sync(states({})); room.advance(.15);
  room.shifts.sync(states({ 'eng-a': 'testing' })); room.advance(3.5);
  assert.equal(physical(room, 'eng-a').mode, 'resting');
  room.shifts.sync(states({})); room.advance(3); assert.equal(physical(room, 'eng-a').mode, 'absent');
  // Cancel an entry inside the doorway, then reactivate while it is reversing.
  room.shifts.sync(states({ 'eng-a': 'thinking' })); room.advance(.18);
  room.shifts.sync(states({})); room.advance(.08);
  room.shifts.sync(states({ 'eng-a': 'working' })); room.advance(4);
  assert.equal(physical(room, 'eng-a').mode, 'working'); assert.equal(physical(room, 'eng-a').seated, 1);
});

check('entry/exit doorway crossings serialize per room while separate rooms move independently', () => {
  const first = fixture(), second = fixture(), all = states({ pm: 'thinking', 'eng-a': 'testing', 'eng-b': 'testing', verifier: 'rejected' });
  first.shifts.sync(all); second.shifts.sync(all);
  first.shifts.update(.05, .05); second.shifts.update(.05, .05);
  assert.equal(first.shifts.snapshot().filter(item => item.crossingDoor).length, 0, 'door must open before a crossing');
  assert.equal(second.shifts.snapshot().filter(item => item.crossingDoor).length, 0);
  let firstCrossing = false, secondCrossing = false;
  first.advance(14, snapshot => { firstCrossing ||= snapshot.some(item => item.crossingDoor); });
  second.advance(14, snapshot => { secondCrossing ||= snapshot.some(item => item.crossingDoor); });
  assert.ok(firstCrossing && secondCrossing, 'both independent room doors actually admit actors');
  assert.equal(physical(first, 'eng-a').mode, 'resting'); assert.equal(physical(first, 'eng-b').mode, 'pacing');
  assert.equal(physical(first, 'pm').mode, 'working'); assert.equal(physical(first, 'verifier').mode, 'working');
  first.shifts.sync(states({})); first.advance(14);
  assert.ok(first.shifts.snapshot().every(item => item.mode === 'absent' && !item.visible));
  assert.ok(second.shifts.snapshot().every(item => item.visible));
});

check('reduced motion restores the current activity without replaying walks or typing', () => {
  const room = fixture(true), model = createProjectModel();
  room.shifts.sync(model.getProject('website').actors);
  assert.equal(physical(room, 'pm').motion, 'waiting'); assert.equal(physical(room, 'pm').mode, 'working');
  assert.equal(physical(room, 'pm').seated, 1); assert.equal(room.desks[0].character.lastPose.still, true);
  model.tick(28); room.shifts.sync(model.getProject('shipboss').actors);
  const before = room.shifts.snapshot(); room.advance(4); assert.deepEqual(room.shifts.snapshot(), before);
  assert.equal(physical(room, 'eng-b').mode, 'pacing'); assert.equal(physical(room, 'verifier').mode, 'working');
  assert.equal(room.desks[2].character.lastPose.working, false); assert.equal(room.desks[3].character.lastPose.working, false);
});

check('the full live timeline drives physical testers, rejection, rework and callbacks without route resets', () => {
  const room = fixture(), model = createProjectModel(); room.shifts.sync(model.getProject('shipboss').actors, true);
  const observed = new Set();
  for (let frame = 1; frame <= PROJECT_CYCLE_SECONDS * 60; frame++) {
    model.tick(1 / 60); const project = model.getProject('shipboss'); room.shifts.sync(project.actors);
    room.advance(1 / 60, snapshot => {
      if (snapshot[1].mode === 'resting') observed.add('A sofa');
      if (snapshot[2].mode === 'pacing') observed.add('B pacing');
      if (snapshot[3].motion === 'rejected' && snapshot[3].seated === 1) observed.add('verifier X seated');
      if (snapshot[1].motion === 'thinking' && task(project, 'eng-a').attempt === 2) observed.add('A rework');
      if (project.reports.some(item => item.verdict === 'PASS · 演示') && snapshot[0].mode === 'working') observed.add('PM callback');
    });
  }
  assert.deepEqual([...observed].sort(), ['A rework', 'A sofa', 'B pacing', 'PM callback', 'verifier X seated']);
});

console.log(`Model and movement checks passed: ${checks} behavioral groups; deterministic local simulation only.`);
