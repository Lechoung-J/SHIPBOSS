// Actual stage command -> runtime snapshot -> desktop normalization -> bridge ->
// real source office geometry. No Electron/GPU/window claim.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridgeModel } from '../src/observer-adapter.js';
import { createOffice } from '../src/office.js';
const ctx=new Proxy({}, {get(o,k){if(k==='createImageData'||k==='getImageData')return(w,h)=>({data:new Uint8ClampedArray(w*h*4),width:w,height:h});if(k==='measureText')return t=>({width:String(t).length*8});if(k==='createLinearGradient'||k==='createRadialGradient')return()=>({addColorStop(){}});return o[k]??(()=>{});},set(o,k,v){o[k]=v;return true;}});
globalThis.document={createElement:()=>({width:512,height:512,getContext:()=>ctx})};globalThis.window={matchMedia:()=>({matches:false})};
const runtime=fileURLToPath(new URL('../runtime',import.meta.url));const require=createRequire(import.meta.url);const {normalizeObserverState}=require('../desktop/observer-state.cjs');
const root=await mkdtemp(path.join(os.tmpdir(),'EXAMPLE-047-stage-motion-'));
function py(code){const r=spawnSync('python3',['-c',`import sys,json\nsys.path.insert(0,${JSON.stringify(runtime)})\nfrom registry import activate,bind,update,read\nfrom observer_state import build\nroot=${JSON.stringify(root)}\n${code}`],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});assert.equal(r.status,0,r.stderr);return r.stdout;}
py("activate(root,'owner','owner')\nfor slot in ['eng-a','eng-b']:\n bind(root,assignment=slot,task='T-'+slot,role='engineer',slot=slot,policy='new',context_id=slot,session_id=slot,job_id='job-'+slot)\n update(root,slot,state='running')");
await writeFile(path.join(root,'real_test.py'),'import time,unittest\nclass RealTest(unittest.TestCase):\n def test_actual_result(self):\n  time.sleep(9)\n  self.assertEqual(6*7,42)\n');
const office=createOffice(new THREE.Scene(),{parallel:true,projectId:'stage-motion'});const bridge=createBridgeModel();let t=0;const samples=[];
function refresh(){const n=normalizeObserverState(JSON.parse(py('print(json.dumps(build([root])))')));assert.equal(n.ok,true);bridge.setState(n.payload);office.setProject(bridge.snapshot()[0]);}
async function advance(seconds){const end=performance.now()+seconds*1000;let refreshed=0,last=performance.now();while(performance.now()<end){const now=performance.now();if(now-refreshed>=500){refresh();refreshed=now;}t+=Math.min(.1,(now-last)/1000);last=now;office.update(t);samples.push({t,...office.snapshot()});await new Promise(r=>setTimeout(r,30));}}
refresh();await advance(8);
assert.equal(office.snapshot().characters[1].mode,'working');assert.equal(office.snapshot().characters[2].mode,'working');
const children=['eng-a','eng-b'].map(slot=>{const p=spawn('python3',[path.join(runtime,'runtime.py'),'--root',root,'stage',slot,'--phase','testing','--','python3','-m','unittest','real_test.py'],{cwd:root,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:'pipe'});let output='';p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>output+=d);return {p,done:new Promise((resolve,reject)=>{p.on('error',reject);p.on('exit',c=>c===0?resolve(output):reject(Error('actual test failed '+c+' '+output)));})};});
try{
 await advance(7);
 assert.equal(office.snapshot().characters[1].mode,'resting');assert.equal(office.snapshot().characters[2].mode,'pacing');
 await Promise.all(children.map(c=>c.done));await advance(7);
 assert.equal(office.snapshot().characters[1].mode,'working');assert.equal(office.snapshot().characters[2].mode,'working');
 const r=JSON.parse(py('print(json.dumps(read(root)["assignments"]))'));
 for(const slot of ['eng-a','eng-b']){assert.equal(r[slot].state,'running');assert.equal(r[slot].phase,'working');assert.equal(r[slot].verdict,null);}
 if(process.argv[2])await writeFile(process.argv[2],JSON.stringify({passed:true,kind:'actual-unittest-stage-to-source-geometry-no-GPU',root,samples},null,2));
 console.log('Actual managed unittest -> testing snapshot -> sofa/pacing -> working return OK (not Electron)');
}finally{for(const c of children){if(c.p.exitCode===null)c.p.kill('SIGTERM');await c.done.catch(()=>{});}}
