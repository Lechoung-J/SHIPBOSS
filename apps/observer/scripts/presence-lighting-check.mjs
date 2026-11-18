// Fixture-only schema/room/real office geometry. Not an Electron/GPU result.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createRequire } from 'node:module';
import { roomIsIdle } from '../src/room-style.js';
import { createOffice } from '../src/office.js';
import { createBridgeModel } from '../src/observer-adapter.js';
const { normalizeObserverState }=createRequire(import.meta.url)('../desktop/observer-state.cjs');
const ids=['pm','eng-a','eng-b','verifier'];
const project={id:'presence',name:'presence',source:'fixture',status:'idle',isIdle:true,lastActivityAt:'2020-01-01T00:00:00Z',idleForSeconds:99999,
 actors:ids.map((id,i)=>({id,role:['pm','engineer','engineer','verifier'][i],name:id,active:i===0,motion:i===0?'waiting':'idle',uncertain:false,activity:i===0?'PM waiting for background callback':'unknown'})),tasks:[],reports:[],recording:false,skillsUsed:19};
const envelope=p=>({version:1,generatedAt:new Date().toISOString(),source:'fixture',projects:[p]});
let normalized=normalizeObserverState(envelope(project));assert.equal(normalized.ok,true);
assert.equal(normalized.payload.projects[0].isIdle,false);assert.match(normalized.payload.projects[0].activity,/normalized/);
assert.equal(roomIsIdle(project),false,'direct renderer protects confirmed actor with stale timestamp');
assert.equal(roomIsIdle({...project,actors:[],recording:true}),false,'confirmed recording protects');
assert.equal(roomIsIdle({...project,actors:project.actors.map(a=>({...a,uncertain:true})),recording:true,recordingUncertain:true}),true,'unknown visible/paused is not confirmed presence');
const bridge=createBridgeModel(normalized.payload,{now:()=>Date.now()+60000});
assert.equal(roomIsIdle(bridge.getProject('presence')),true,'stale bridge clears confirmed work');
const ctx=new Proxy({}, {get(o,k){if(k==='createImageData'||k==='getImageData')return(w,h)=>({data:new Uint8ClampedArray(w*h*4),width:w,height:h});if(k==='measureText')return t=>({width:String(t).length*8});if(k==='createLinearGradient'||k==='createRadialGradient')return()=>({addColorStop(){}});return o[k]??(()=>{});},set(o,k,v){o[k]=v;return true;}});
globalThis.document={createElement:()=>({width:512,height:512,getContext:()=>ctx})};globalThis.window={matchMedia:()=>({matches:false})};
const office=createOffice(new THREE.Scene(),{parallel:true,projectId:'presence'});let time=0;
const advance=seconds=>{for(let i=0;i<seconds*120;i++){time+=1/120;office.update(time);}};
office.setProject(project);advance(8);
let state=office.snapshot();assert.equal(state.idle,false);assert.equal(state.presenceIdleConflict,true);assert.equal(state.characters[0].mode,'working');
assert.equal(state.characters[0].motion,'waiting');assert.equal(state.waiting,false,'background callback is not a user question');
assert.equal(state.characters[0].seated,1);assert.ok(state.characters.slice(1).every(a=>!a.visible));
const shoulder=state.characters[0].joints.shoulders;advance(1);assert.deepEqual(office.snapshot().characters[0].joints.shoulders,shoulder,'waiting PM does not type');
project.needsAttention=true;project.awaitingUser=true;office.setProject(project);assert.equal(office.snapshot().waiting,true,'existing special attention dim/question route retained');
project.needsAttention=false;project.awaitingUser=false;project.actors[0].active=false;project.actors[0].uncertain=true;office.setProject(project);
const frozen=office.snapshot().characters[0];advance(1);state=office.snapshot();
assert.equal(state.characters[0].mode,'uncertain');assert.equal(state.characters[0].visible,true);assert.deepEqual(state.characters[0].position,frozen.position);
project.actors[0].uncertain=false;office.setProject(project);advance(.5);assert.equal(office.snapshot().characters[0].mode,'exiting','known end starts real exit');advance(8);assert.equal(office.snapshot().characters[0].visible,false);
assert.equal(office.snapshot().idle,true);assert.equal(office.snapshot().skillBoxesShown,19);
console.log('Presence/lighting: active-vs-idle normalization, waiting/no typing, unknown freeze, known-end continuous exit, attention, recording and stale bridge OK (not GPU)');

// Same shape emitted by automatically discovered read-only registry overlay.
project.actors[2]={...project.actors[2],active:true,uncertain:false,motion:'working',taskId:'REGISTERED-EXTERNAL',papers:1};
office.setProject(project);advance(10);state=office.snapshot();
assert.equal(state.characters[2].mode,'working');assert.equal(state.characters[2].taskId,'REGISTERED-EXTERNAL');assert.equal(state.characters[2].seated,1);assert.equal(state.idle,false);
console.log('Registered external engineer B: continuous entry, real B workstation and confirmed light protection OK (not GPU)');
