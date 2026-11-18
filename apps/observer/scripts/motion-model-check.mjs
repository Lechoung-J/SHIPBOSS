import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createParallelShifts } from '../src/parallel-shifts.js';
function harness(reduced = false, hz = 60) {
 const desks = [-5.1,-1.4,2.2,5.1].map((x,i)=>({ x,z:-1.45, character:{root:new THREE.Group(),head:new THREE.Group(),pose(){},snapshot(){return {};}} }));
 desks.push({id:'recording',character:{root:new THREE.Group(),head:new THREE.Group(),pose(){},snapshot(){return {};}}});
 const door={hinge:{rotation:{y:0}}}; const shifts=createParallelShifts(desks,door,reduced);
 const state=['pm','eng-a','eng-b','verifier','recording'].map(id=>({id,active:false,motion:'working'}));
 let t=0; const history=[];
 function step(seconds) { for(let n=0;n<Math.round(seconds*hz);n++) { t+=1/hz; const before=shifts.snapshot(); shifts.sync(state,true); shifts.update(t,1/hz); const after=shifts.snapshot();
  after.forEach((a,i)=>assert.ok(Math.hypot(a.x-before[i].x,a.z-before[i].z)<.101,`jump ${a.id}`));
  after.forEach((a,i)=>{if(a.crossingDoor && Math.hypot(a.x-before[i].x,a.z-before[i].z)>.002)assert.ok(door.hinge.rotation.y>=1.2,'door open before crossing');});
  assert.ok(after.filter(a=>a.crossingDoor).length<=1,'one shared door owner'); history.push({t,actors:after,door:door.hinge.rotation.y}); } }
 return {state,shifts,door,step,history};
}
const h=harness(); h.state.forEach(a=>a.active=true);h.step(18);
for(const id of ['pm','eng-a','eng-b','verifier']) {
 const samples=h.history.flatMap(s=>s.actors.filter(a=>a.id===id));
 assert.ok(samples.some(a=>a.mode==='entering'&&a.x<-6));
 assert.ok(samples.some(a=>a.seated>0&&a.seated<1));
 assert.equal(samples.at(-1).mode,'working');
}
assert.ok(h.history.some(s=>s.door>1.2));assert.equal(h.shifts.snapshot()[4].mode,'reading');
h.state[1].motion=h.state[2].motion='testing';h.step(6);
assert.equal(h.shifts.snapshot()[1].mode,'resting');assert.equal(h.shifts.snapshot()[2].mode,'pacing');
h.state[1].motion=h.state[2].motion='working';h.step(6);assert.equal(h.shifts.snapshot()[1].mode,'working');
// Interrupt while rising, in a rest edge, on the shared door, and on exit.
h.state[1].motion='testing';h.step(.55);h.state[1].motion='working';h.step(4);
h.state[4].active=false;h.step(.5);h.state[4].active=true;h.step(4);assert.equal(h.shifts.snapshot()[4].mode,'reading');
h.state.forEach(a=>a.active=false);h.step(.5);h.state.forEach(a=>a.active=true);h.step(12);
const before=h.shifts.snapshot();h.state.forEach(a=>a.uncertain=true);h.step(1);
assert.deepEqual(h.shifts.snapshot().map(a=>[a.x,a.z]),before.map(a=>[a.x,a.z]));
h.state.forEach(a=>{a.uncertain=false;a.active=false;});h.step(14);assert.ok(h.shifts.snapshot().every(a=>!a.visible));assert.ok(h.door.hinge.rotation.y<.001);
const short=harness();short.state.forEach(a=>a.active=true);short.step(.25);short.state.forEach(a=>a.active=false);short.step(4);assert.ok(short.shifts.snapshot().every(a=>!a.visible));
const reduced=harness(true);reduced.state.forEach(a=>a.active=true);reduced.shifts.sync(reduced.state);assert.equal(reduced.shifts.snapshot()[0].mode,'working');assert.equal(reduced.shifts.snapshot()[4].mode,'reading');
console.log('Motion routes: entry/sit/shared door/rest/pace/return/interruption/freeze/exit/reduced OK');

// Door-ownership regression: at 120Hz the owner is acquired before the first movement.
for (const index of [0,4]) {
 const early=harness(false,120);early.state[index].active=true;early.step(10/120);
 const opening=early.shifts.snapshot()[index];
 assert.equal(opening.mode,'entering');assert.equal(opening.x,-8.55);
 assert.ok(early.door.hinge.rotation.y>1 && early.door.hinge.rotation.y<1.2);
 early.state[index].active=false;early.step(15/120);
 assert.equal(early.shifts.snapshot()[index].mode,'absent');
 const restart=early.history.length;
 for(const i of [0,1,4])early.state[i].active=true;
 early.step(20);
 for(const i of [0,1,4]) {
  const poses=early.history.slice(restart).map(s=>s.actors[i]);
  assert.ok(poses.some(a=>a.mode==='entering' && a.x<-6),'re-entry traverses outside');
  if(i!==4)assert.ok(poses.some(a=>a.seated>0 && a.seated<1),'re-entry sits continuously');
 }
 assert.deepEqual([0,1,4].map(i=>early.shifts.snapshot()[i].mode),['working','working','reading'],'early cancel releases only its own door');
 // Cancel an exit while waiting at the still-opening door, before crossing.
 early.state.forEach(a=>a.active=false);early.step(20);
 early.state[index].active=true;early.step(12);early.step(1);early.state[index].active=false;
 let waiting=false;
 for(let frame=0;frame<2400;frame++) {
  early.step(1/120);const a=early.shifts.snapshot()[index];
  if(a.mode==='exiting' && Math.abs(a.x+5.7)<.002 && Math.abs(a.z-1.7)<.002 && early.door.hinge.rotation.y<1.2){waiting=true;break;}
 }
 assert.ok(waiting,'sample exit before door crossing');
 early.state[index].active=true;early.state[1].active=true;early.step(20);
 assert.equal(early.shifts.snapshot()[index].mode,index===4?'reading':'working');
 assert.equal(early.shifts.snapshot()[1].mode,'working');
}
// Unknown is NOT cancellation: retain the opening owner's reservation.
const unknown=harness(false,120);unknown.state[0].active=true;unknown.step(10/120);
unknown.state[0].uncertain=true;unknown.state[0].active=false;
unknown.state[1].active=unknown.state[4].active=true;unknown.step(20);
assert.equal(unknown.shifts.snapshot()[0].x,-8.55);
assert.ok([1,4].every(i=>unknown.shifts.snapshot()[i].mode==='absent'),'unknown owner still blocks contenders');
unknown.state[0].uncertain=false;unknown.step(20);
assert.equal(unknown.shifts.snapshot()[1].mode,'working');assert.equal(unknown.shifts.snapshot()[4].mode,'reading');
console.log('120Hz PM/scribe pre-movement cancel, exit-door cancel, re-entry and unknown ownership OK');
