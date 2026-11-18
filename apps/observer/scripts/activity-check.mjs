import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createActivityScheduler, layoutActivityBubbles } from '../src/activity-bubbles.js';
const { normalizeToolActivity } = createRequire(import.meta.url)('../desktop/activity-contract.cjs');
let at = 100000, draws = 0;
const scheduler = createActivityScheduler({ now: () => at, random: () => { draws++; return .2; } });
const call = (id, category = 'read', state = 'started', sequence = 1) => ({ callId: id, category, target: 'app.ts', state, sequence, timestamp: at, startedAt: at });
const actor = { id: 'eng-a', role: 'engineer', active: true, uncertain: false, motion: 'working', toolActivity: { version: 1, projectId: 'p-fixture', actorId: 'eng-a', sessionId: 's-worker', runningCount: 2, thinking: false, calls: [call('old'), call('new', 'edit', 'started', 2)] } };
const tick = options => scheduler.tick('p-fixture/eng-a', actor, options);
assert.equal(tick().callId, 'new');
actor.toolActivity.calls[0].state = 'ended'; actor.toolActivity.runningCount = 1;
assert.equal(tick().callId, 'new', 'old result must leave new call visible');
actor.toolActivity.calls[0].state = 'error'; actor.toolActivity.calls[0].callId = 'failure';
assert.equal(tick().kind, 'error');
assert.equal(tick().kind, 'error', 'error remains readable'); at += 1100;
assert.equal(tick().callId, 'new', 'snapshot replay must not retrigger terminal error');
actor.toolActivity.calls = ['a','b','c'].map(id => call(id,'read','ended')); actor.toolActivity.runningCount = 0;
assert.match(tick().text, /刚完成.*×3/);
at += 1100; assert.equal(tick(), null, 'completed summary expires despite duplicate snapshot');
actor.motion = 'thinking'; actor.toolActivity.calls = [];
assert.equal(tick(), null); at += 1999; assert.equal(tick(), null); at++;
assert.equal(tick().kind, 'fun'); assert.equal(draws, 1);
const first = tick().text;
at += 2000; assert.equal(tick().text, first); assert.equal(draws, 1, 'no per-frame random');
actor.toolActivity.calls = [call('interruption','command')]; actor.toolActivity.runningCount = 1;
assert.equal(tick().kind,'tool');
actor.toolActivity.calls = []; actor.toolActivity.runningCount = 0;
assert.equal(tick(),null); at += 3000; assert.equal(tick(),null,'cooldown survives tool interruption');
at += 22000; assert.equal(tick().kind,'fun'); assert.notEqual(tick().text, first);
assert.equal(tick({ visible:false }),null); at += 50000; assert.equal(tick(),null,'restore needs new stable thinking');
actor.motion = 'waiting'; at += 3000; assert.equal(tick(),null);
actor.uncertain = true; assert.equal(tick().kind,'unknown'); actor.uncertain = false;
actor.motion = 'working'; actor.toolActivity.calls = [call('hidden-complete','edit','ended')];
assert.equal(tick({ visible:false }),null); assert.equal(tick(),null,'no hidden completion backlog');
actor.toolActivity.calls = [call('latest','edit')]; actor.toolActivity.runningCount = 1;
assert.equal(tick().callId,'latest','current active tool is restored');
const valid = structuredClone(actor.toolActivity);
assert.ok(normalizeToolActivity(valid,'p-fixture','eng-a'));
for (const patch of [{version:2},{projectId:'other'},{actorId:'verifier'},{sessionId:''},{sessionId:null},{suppressed:true},{runningCount:33},{calls:Array(13).fill(valid.calls[0])}]) {
 assert.equal(normalizeToolActivity({...valid,...patch},'p-fixture','eng-a'),null,JSON.stringify(patch));
}
for (const patch of [{callId:'x'.repeat(81)},{sequence:-1},{timestamp:NaN},{timestamp:-1},{startedAt:Infinity},{state:'PASS'},{category:'bash'},{target:'/tmp/private'},{target:'SECRET\nCOMMAND'},{target:'a'.repeat(33)},{target:'.env'},{target:'api-key.json'},{target:'client.pem'},{target:'accessToken.ts'}]) {
 assert.equal(normalizeToolActivity({...valid,calls:[{...valid.calls[0],...patch}]},'p-fixture','eng-a'),null,JSON.stringify(patch));
}
console.log('Activity schema, identity bounds, parallel/replay, local fun cooldown and visibility checks passed');

const layout = layoutActivityBubbles([{key:'pm',kind:'tool',x:145,y:97,width:104,height:24},{key:'eng-a',kind:'tool',x:72,y:80,width:114,height:24},{key:'fun',kind:'fun',x:197,y:128,width:136,height:38}],{left:0,right:440,top:0,bottom:360});
assert.equal(layout.length,3);
for (let i=0;i<layout.length;i++) {
 const a=layout[i]; assert.ok(a.left>=0 && a.right<=440 && a.top>=44 && a.bottom<=326);
 for (const b of layout.slice(i+1)) assert.ok(a.right<=b.left || a.left>=b.right || a.bottom<=b.top || a.top>=b.bottom,'small-window text bubbles do not overlap');
}
