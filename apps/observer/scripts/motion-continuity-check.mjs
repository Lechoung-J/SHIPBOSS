import assert from 'node:assert/strict';
import { assertMotionContinuity as check } from './motion-continuity.mjs';
const sample=(visualMs,frame,observedAt=visualMs)=>({animationTime:visualMs/1000,frame,observedAt});
const actor=(x,z,visible=true)=>({x,z,visible});
const start=actor(-4.908,1.7),end=actor(-6.625,1.554);
check(sample(1000,10),sample(1383,21),start,end,'reported delayed sample');
check(sample(1000,10),sample(1100,13),actor(0,0),actor(.56,0),'normal maximum speed');
assert.throws(()=>check(sample(1000,10),sample(1010,11),start,end),/no teleport/);
assert.throws(()=>check(sample(1000,10),sample(1090,13),actor(-8.55,1.25),actor(3,3)),/no teleport/);
check(sample(1000,10),sample(1090,13),actor(3,3,false),actor(-8.3,1.25),'reappear outside');
assert.throws(()=>check(sample(1000,10),sample(1090,13),actor(3,3,false),actor(3,3)),/no teleport/);
check(sample(1000,10),sample(1090,13),actor(3,3,false),actor(-8.55,1.25,false),'hidden reset');
check(sample(1000,10,1000),sample(1000,10,1650),start,start,'paused renderer');
check(sample(1000,10),sample(1650,29),start,start,'uncertain freeze');
assert.throws(()=>check(sample(1000,10),sample(1650,10),start,end),/without a rendered frame/);
assert.throws(()=>check(sample(1000,10),sample(999,11),start,start),/monotonic animation time/);
assert.throws(()=>check(sample(1000,10),sample(1100,9),start,start),/monotonic renderer frames/);
console.log('Motion continuity oracle OK: delayed PASS, short jump FAIL, visibility/freeze/time/frame checks');

// Observation age varies: these two poses span two idle frames, not 102ms.
check(sample(1000,1181,1080),sample(1166.7,1183,1182),actor(0,0),actor(.933,0),'two late observations');
assert.throws(()=>check(sample(1000,1181,1080),sample(1010,1183,1182),actor(0,0),actor(.933,0)),/no teleport/);
// A long wall-clock pause cannot buy movement in a frozen visual clock.
assert.throws(()=>check(sample(1000,10,1000),sample(1000,11,9000),start,actor(start.x+.01,start.z)),/without a rendered frame\/time advance/);
assert.throws(()=>check(sample(1000,10,1000),sample(1000,10,9000),actor(3,3,false),actor(-8.3,1.25)),/without a rendered frame\/time advance/);
console.log('Frame-clock oracle OK: late observation PASS, short visual interval jump FAIL, frozen clock FAIL');
