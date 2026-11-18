// Same continuously refreshed file-bridge inputs for source and explicit .app.
// Fixtures establish identities explicitly; they do NOT impersonate production work.
import assert from 'node:assert/strict';
import { assertMotionContinuity } from './motion-continuity.mjs';
import { _electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const require=createRequire(import.meta.url);
const runtime=path.join(root,'runtime');
const ids=['pm','eng-a','eng-b','verifier'];
export async function runMotionCheck({appPath=null,out=path.join(root,'artifacts/motion-source.json'), reduced=false}={}) {
 const fixture=await mkdtemp(path.join(os.tmpdir(),'EXAMPLE-047-motion-'));
 const statePath=path.join(fixture,'state.json');
 function py(code) {
  const r=spawnSync('python3',['-c',`import sys,json\nsys.path.insert(0,${JSON.stringify(runtime)})\nfrom registry import activate,bind,update,read\nfrom observer_state import build_project\nroot=${JSON.stringify(fixture)}\n${code}`],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  if(r.status!==0) throw Error(r.stderr);return r.stdout;
 }
 py(`activate(root,'owner','owner')\nfor slot,role in [('pm','pm'),('eng-a','engineer'),('eng-b','engineer'),('verifier','verifier'),('recording','recording')]:\n bind(root,assignment=slot,task='T-'+slot,role=role,slot=slot,policy='fresh' if role=='verifier' else 'new',context_id='ctx-'+slot,session_id='session-'+slot,job_id='job-'+slot,revision='fixture-revision' if role=='verifier' else None)\n update(root,slot,state='running')`);
 let app,page,timer,busy=false,refreshError=null,tick=0; const samples=[],errors=[],children=[];
 async function publish() {
  if(busy)return;busy=true;
  try {
   const project=JSON.parse(py('print(json.dumps(build_project(root)))'));
   project.skillsUsed=19; project.isIdle=false;project.activity += '; refresh '+(++tick);
   const idle={...structuredClone(project),id:'idle-fixture',name:'idle-fixture',status:'reviewing',isIdle:true,skillsUsed:2,
    recording:false,actors:project.actors.map(a=>({...a,active:false,uncertain:false})),tasks:[]};
   const payload={version:1,generatedAt:new Date().toISOString(),source:'EXAMPLE-047 isolated registered fixture',projects:[project,idle]};
   const staging=statePath+'.tmp';await writeFile(staging,JSON.stringify(payload));await rename(staging,statePath);
  } finally {busy=false;}
 }
 async function sample() {const s=await page.evaluate(()=>{const state=window.__SHIPBOSS_WIDGET__?.getState();return state ? {...state,observedAt:performance.now(),animationTime:state.rendering.animationTime,frame:state.rendering.frames} : null;});if(s?.rooms?.length) {samples.push({observedAt:s.observedAt,animationTime:s.animationTime,frame:s.frame,rooms:s.rooms});return s;} }
 async function until(predicate,label,timeout=23000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){const s=await sample();if(s&&predicate(s))return s;await new Promise(r=>setTimeout(r,90));}
  throw Error('Timed out: '+label);
 }
 const main=s=>s.rooms.find(r=>r.id!=='idle-fixture')?.scene;
 const wait=async ms=>{const end=Date.now()+ms;while(Date.now()<end){await sample();await new Promise(r=>setTimeout(r,85));}};
 const update=(slot,phase)=>py(`update(root,${JSON.stringify(slot)},${phase ? 'phase='+JSON.stringify(phase) : "state='completed',exit_code=0"})`);
 async function stage(slot) {
  const child=spawn('python3',[path.join(runtime,'runtime.py'),'--root',fixture,'stage',slot,'--phase','testing','--','python3','-m','unittest','slow_stage.py'],{cwd:fixture,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
  const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve(log):reject(Error('stage '+code+': '+log)));});done.catch(()=>{});children.push({child,done});return {child,done};
 }
 let evidence;
 try {
  await publish();timer=setInterval(()=>publish().catch(e=>refreshError=e),500);
  const selected=appPath?.endsWith('.app')?path.join(appPath,'Contents/MacOS/SHIPBOSS Observer'):appPath;
  const env={...process.env,SHIPBOSS_TEST_MODE:'1',SHIPBOSS_TEST_RUN_ID:`motion-${Date.now()}`,SHIPBOSS_OBSERVER_STATE:statePath};delete env.ELECTRON_RUN_AS_NODE;delete env.SHIPBOSS_DEV_URL;
  app=await _electron.launch({executablePath:selected||require('electron'),args:selected?[]:[path.join(root,'desktop/main.cjs')],cwd:root,env,timeout:30000});
  page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  if(reduced) await page.emulateMedia({reducedMotion:'reduce'}); // applied before reload/first fixture construction
  if(reduced) await page.reload();
  await until(s=>main(s)?.characters.every(a=>a.mode==='working')&&main(s)?.scribe.mode==='reading','initial complete entry');
  if(!reduced){
   for(const id of ids) {
    const a=samples.flatMap(s=>main(s)?.characters.filter(a=>a.id===id)||[]);
    assert.ok(a.some(a=>a.mode==='entering'&&a.x<-6),id+' entry');
    assert.ok(a.some(a=>a.seated>0&&a.seated<1),id+' sit transition');
   }
   assert.ok(samples.some(s=>main(s)?.doorAngle>1.2),'door opens');
   assert.ok(samples.some(s=>main(s)?.scribe.mode==='entering'&&main(s).scribe.x<-6),'scribe enters not only reading');
  }
  await wait(700);
  const typed=samples.filter(s=>main(s)?.characters[1].mode==='working').map(s=>main(s).characters[1].joints.shoulders[0]);
  if(!reduced)assert.ok(new Set(typed).size>2,'actual typing joints');
  await writeFile(path.join(fixture,'slow_stage.py'),'import time, unittest\nclass SlowStage(unittest.TestCase):\n def test_wait_for_result(self):\n  time.sleep(12)\n  self.assertEqual(2+2,4)\n');
  const aStage=await stage('eng-a'),bStage=await stage('eng-b');
  await until(s=>main(s)?.characters[1].mode==='resting'&&main(s)?.characters[2].mode==='pacing','real stage -> snapshot -> sofa and pacing');
  const restStart=samples.length;await wait(900);
  const rest=samples.slice(restStart).map(s=>main(s).characters[1].joints.shoulders[0]);assert.equal(new Set(rest).size,1,'no typing on sofa');
  const pace=samples.slice(restStart).map(s=>main(s).characters[2].x);if(!reduced)assert.ok(Math.max(...pace)-Math.min(...pace)>.2,'actual pacing');
  await Promise.all([aStage.done,bStage.done]);
  await until(s=>main(s)?.characters[1].mode==='working'&&main(s)?.characters[2].mode==='working','stage restores engineer phase and returns');
  // Abort a rest trip, then abort an exit/re-enter from the actual current edge.
  update('eng-a','testing');await publish();await wait(750);update('eng-a','working');await publish();
  await until(s=>main(s)?.characters[1].mode==='working','interrupt rest -> desk');
  // Registry phase/lifecycle remains real. For rapid cancel/reentry use a fresh
  // same-context explicit engineer continuation, never revive a terminal record.
  update('eng-a');await publish();await wait(1100);
  py("bind(root,assignment='eng-a-next',task='T-eng-a',role='engineer',slot='eng-a',policy='resume',context_id='ctx-eng-a',session_id='session-eng-a',job_id='job-next',predecessor='eng-a')\nupdate(root,'eng-a-next',state='running')");await publish();
  await until(s=>main(s)?.characters[1].mode==='working','exit interrupted by explicit continuation');
  // Hide/show only the isolated test window; no production window or service.
  const before=await sample();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].hide());await new Promise(r=>setTimeout(r,600));await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());await wait(600);
  assert.equal(main(before).characters[1].taskId,main(await sample()).characters[1].taskId,'hide/show preserves assignment');
  clearInterval(timer);timer=null;await writeFile(statePath,'{broken');
  await until(s=>main(s)?.characters.every(a=>a.uncertain),'invalid bridge freezes visual, marks unknown');
  const frozen=main(await sample()).characters.map(a=>[a.x,a.z]);await wait(650);assert.deepEqual(main(await sample()).characters.map(a=>[a.x,a.z]),frozen);
  timer=setInterval(()=>publish().catch(e=>refreshError=e),500);await publish();
  await until(s=>main(s)?.characters.every(a=>a.mode==='working'),'fresh reconnect continuous recovery');
  for(const slot of ['pm','eng-a-next','eng-b','verifier','recording'])update(slot);
  await publish();await until(s=>main(s)?.characters.every(a=>!a.visible)&&!main(s)?.scribe.visible,'all exit to outside',26000);await wait(650);
  if(!reduced){
   for(const id of [...ids,'recording']) {
    const a=samples.map(s=>id==='recording'?main(s)?.scribe:main(s)?.characters.find(a=>a.id===id)).filter(Boolean);
    assert.ok(a.some(a=>a.mode==='exiting'&&a.visible),id+' exit sampled');
   }
   assert.ok(main(samples.at(-1)).doorAngle<.01,'door closed');
  }
  // Later inactive -> active and a short assignment cancelled mid-entry.
  py("bind(root,assignment='eng-a-short',task='T-eng-a',role='engineer',slot='eng-a',policy='resume',context_id='ctx-eng-a',session_id='session-eng-a',job_id='job-short',predecessor='eng-a-next')\nupdate(root,'eng-a-short',state='running')");
  await publish();await until(s=>main(s)?.characters[1].mode===(reduced?'working':'entering'),'subsequent short entry');
  update('eng-a-short');await publish();await until(s=>!main(s)?.characters[1].visible,'cancel mid-entry exits continuously');
  const final=await sample();
  // Include the later re-entry/cancellation too; never bridge actor-hidden resets
  // as if they were visible walking. Animation time belongs to the sampled pose, not the observation wall clock.
  if(!reduced) for(const id of [...ids,'recording']) {
   const actor=s=>id==='recording'?main(s)?.scribe:main(s)?.characters.find(a=>a.id===id);
   for(let i=1;i<samples.length;i++) {
    const before=actor(samples[i-1]),after=actor(samples[i]);
    if(before&&after)assertMotionContinuity(samples[i-1],samples[i],before,after,id);
   }
  }
  assert.equal(final.rooms.length,2);assert.equal(main(final).skillBoxesShown,19);assert.equal(final.rooms.find(r=>r.id==='idle-fixture').scene.skillBoxesShown,2);
  const native=await app.evaluate(({BrowserWindow})=>{const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration};});
  assert.deepEqual(native,{sandbox:true,contextIsolation:true,nodeIntegration:false});assert.deepEqual(errors,[]);if(refreshError)throw refreshError;
  evidence={passed:true,target:appPath||'source Electron',reduced,fixture,refreshes:tick,native,samples,errors};
 }catch(error){evidence={passed:false,target:appPath||'source Electron',reduced,fixture,refreshes:tick,failure:error.stack,samples,errors};throw error;}
 finally{clearInterval(timer);for(const c of children){if(c.child.exitCode===null)c.child.kill('SIGTERM');await c.done.catch(()=>{});}await app?.close().catch(()=>{});await mkdir(path.dirname(out),{recursive:true});await writeFile(out,JSON.stringify(evidence,null,2)+'\n');}
 console.log(`Motion bridge OK: ${appPath||'source'}, ${samples.length} continuous samples, ${tick} refreshes, evidence ${out}`);
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const args=process.argv.slice(2);const value=flag=>args.includes(flag)?args[args.indexOf(flag)+1]:null;
 await runMotionCheck({appPath:value('--app')||process.env.SHIPBOSS_OBSERVER_APP||null,out:value('--out')||undefined,reduced:args.includes('--reduced')});
}
