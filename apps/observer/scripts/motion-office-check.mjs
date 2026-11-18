// Full source office geometry/pose simulation with a canvas raster stub.
// No GPU pixels, native window or Electron claims. Real Three objects/joints/routes.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createOffice } from '../src/office.js';
import { writeFile, mkdir } from 'node:fs/promises';
const ctx=new Proxy({}, {get(o,k){if(k==='createImageData'||k==='getImageData')return(w,h)=>({data:new Uint8ClampedArray(w*h*4),width:w,height:h});if(k==='measureText')return t=>({width:String(t).length*8});if(k==='createLinearGradient'||k==='createRadialGradient')return()=>({addColorStop(){}});return o[k]??(()=>{});},set(o,k,v){o[k]=v;return true;}});
globalThis.document={createElement:()=>({width:512,height:512,getContext:()=>ctx})};
let reduced=false;globalThis.window={matchMedia:()=>({matches:reduced})};
const ids=['pm','eng-a','eng-b','verifier'];
let now=0; const scene=new THREE.Scene();const office=createOffice(scene,{parallel:true,projectId:'pose-fixture'});
const project={id:'pose-fixture',status:'implementing',skillsUsed:19,isIdle:false,actors:ids.map(id=>({id,active:true,motion:'working',taskId:id,papers:1})),reports:[],recording:true};
const samples=[];
function run(seconds){for(let n=0;n<seconds*60;n++){
 if(n%30===0){project.activity='refresh '+now;office.setProject(project,true);}
 now+=1/60;office.update(now);if(n%3===0)samples.push({t:now,...office.snapshot()});
}}
run(23);
for(const id of ids){const a=samples.map(s=>s.characters.find(a=>a.id===id));assert.ok(a.some(a=>a.mode==='entering'));assert.ok(a.some(a=>a.seated>0&&a.seated<1));assert.equal(a.at(-1).mode,'working');assert.ok(new Set(a.filter(a=>a.mode==='working').map(a=>a.joints.shoulders[0])).size>3);assert.ok(new Set(a.filter(a=>a.mode==='entering').map(a=>a.joints.thighs[0])).size>3);}
assert.ok(samples.some(s=>s.scribe.mode==='entering'));assert.equal(office.snapshot().scribe.mode,'reading');assert.ok(new Set(samples.filter(s=>s.scribe.mode==='reading').map(s=>s.scribe.joints.headX)).size>3);
project.actors[1].motion=project.actors[2].motion='testing';office.setProject(project);run(8);
assert.equal(office.snapshot().characters[1].mode,'resting');assert.equal(office.snapshot().characters[2].mode,'pacing');
let start=samples.length;run(1);
assert.equal(new Set(samples.slice(start).map(s=>s.characters[1].joints.shoulders[0])).size,1);
assert.ok(new Set(samples.slice(start).map(s=>s.characters[2].x)).size>3);
project.actors[1].motion=project.actors[2].motion='working';office.setProject(project);run(7);
assert.equal(office.snapshot().characters[1].mode,'working');assert.equal(office.snapshot().characters[2].mode,'working');
project.actors[1].motion='testing';office.setProject(project);run(.7);project.actors[1].motion='working';office.setProject(project);run(5);
project.recording=false;project.actors.forEach(a=>a.active=false);office.setProject(project);run(1);
project.recording=true;project.actors.forEach(a=>a.active=true);office.setProject(project);run(17);
const stable=office.snapshot();project.actors.forEach(a=>{a.active=false;a.uncertain=true;});project.recordingUncertain=true;office.setProject(project);run(2);
assert.deepEqual(office.snapshot().characters.map(a=>[a.x,a.z]),stable.characters.map(a=>[a.x,a.z]));assert.ok(office.snapshot().characters.every(a=>a.mode==='uncertain'));
project.actors.forEach(a=>{a.active=true;a.uncertain=false;});project.recordingUncertain=false;office.setProject(project);run(2);
project.actors.forEach(a=>a.active=false);project.recording=false;office.setProject(project);run(22);
assert.ok(office.snapshot().characters.every(a=>!a.visible));assert.equal(office.snapshot().scribe.visible,false);assert.ok(office.snapshot().doorAngle<.001);
// Short subsequent activation, including the scribe: cancel before reaching desk.
project.actors.forEach(a=>a.active=true);project.recording=true;office.setProject(project);run(.25);
project.actors.forEach(a=>a.active=false);project.recording=false;office.setProject(project);run(5);
assert.ok(office.snapshot().characters.every(a=>!a.visible));assert.equal(office.snapshot().scribe.visible,false);
for(let i=1;i<samples.length;i++){
 const old=[...samples[i-1].characters,samples[i-1].scribe],next=[...samples[i].characters,samples[i].scribe];
 for(let j=0;j<next.length;j++)assert.ok(Math.hypot(next[j].x-old[j].x,next[j].z-old[j].z)<.5,'continuous full office geometry');
 assert.ok(next.filter(a=>a.crossingDoor).length<=1,'one shared door owner');
}
assert.equal(office.snapshot().skillBoxesShown,19);
reduced=true;const simple=createOffice(new THREE.Scene(),{parallel:true,projectId:'reduced'});project.actors.forEach(a=>a.active=true);project.recording=true;simple.setProject(project);assert.equal(simple.snapshot().characters[0].seated,1);assert.equal(simple.snapshot().scribe.mode,'reading');
const output=process.argv[2];if(output){await mkdir(new URL('.',`file://${output}`).pathname,{recursive:true});await writeFile(output,JSON.stringify({passed:true,kind:'source-geometry-no-GPU',samples},null,2));}
console.log(`Full office geometry: ${samples.length} continuous pose samples, working joints, sofa/pace/return/exit/interruption/uncertainty/reduced OK (not Electron)`);
