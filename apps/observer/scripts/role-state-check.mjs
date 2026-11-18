import assert from 'node:assert/strict';
import { createBridgeModel } from '../src/observer-adapter.js';

let now = Date.parse('2026-11-12T12:00:00Z');
const actors = ['pm', 'eng-a', 'eng-b', 'verifier'].map(id => ({
  id, role: id.startsWith('eng-') ? 'engineer' : id,
  active: id === 'eng-a', motion: id === 'eng-a' ? 'testing' : 'idle',
  taskId: id === 'eng-a' ? 'IMPLEMENT' : null, activity: '', papers: 0,
}));
const project = {
  id: 'registered-project', name: 'Registered', source: 'explicit assignment',
  status: 'implementing', activity: '工程师自测', actors,
  needsAttention: false, awaitingUser: false, pendingQuestion: null,
  recording: false, tasks: [{ id: 'IMPLEMENT', status: 'implementing' }],
  reports: [], skillsUsed: 2,
};
const envelope = () => ({ status: 'live', generatedAt: new Date(now).toISOString(), projects: [structuredClone(project)] });
const bridge = createBridgeModel(envelope(), { now: () => now });
assert.equal(bridge.getProject(project.id).actors[1].role, 'engineer');
assert.equal(bridge.getProject(project.id).actors[1].motion, 'testing');
assert.equal(bridge.getProject(project.id).actors[3].active, false);
now += 31000;
assert.equal(bridge.getStatus().status, 'stale');
assert.equal(bridge.getProject(project.id).actors.some(a => a.active), false);
assert.match(bridge.getProject(project.id).activity, /状态未知/);
assert.equal(bridge.getProject(project.id).recording, false);
assert.equal(bridge.getProject(project.id).id, project.id);
bridge.setState(envelope());
assert.equal(bridge.getStatus().status, 'live');
assert.equal(bridge.getProject(project.id).actors[1].active, true);
bridge.setState({ ...envelope(), status: 'stale', error: { type: 'invalid-json' } });
assert.equal(bridge.getProject(project.id).actors.some(a => a.active), false);
assert.equal(bridge.getProject(project.id).needsAttention, false);
assert.equal(bridge.getProject(project.id).pendingQuestion, null);
assert.equal(bridge.getProject(project.id).skillsUsed, 2);
bridge.setState({ ...envelope(), generatedAt: 'not-a-time' });
assert.equal(bridge.getStatus().status, 'stale');
console.log('PASS role identity stays separate from activity; stale/invalid bridge pauses actors without fake questions; fresh data recovers.');
