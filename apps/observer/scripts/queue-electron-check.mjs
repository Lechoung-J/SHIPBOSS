// EXAMPLE-056 real isolated Electron + queue + writer. Journals and EPERM are synthetic.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, cp, writeFile, readFile, realpath, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
const require=createRequire(import.meta.url);
const source=fileURLToPath(new URL('..',import.meta.url));
const args=process.argv.slice(2);const flag=name=>args[args.indexOf(name)+1];
const runtime=flag('--runtime-source');assert.ok(runtime);
const fixture=await realpath(await mkdtemp(path.join(os.tmpdir(),'shipboss-request-gui-')));
const appRoot=path.join(fixture,'observer');const home=path.join(fixture,'official fixture home');
const service=path.join(fixture,'own service');const stateFile=path.join(service,'observer-state.json');
const output=args.includes('--out')?flag('--out'):path.join(fixture,'evidence.json');
const evidence={passed:false,fixture,kind:'engineering self-check; synthetic official journals and simulated EPERM; actual isolated Electron/writer',stages:[]};
let socket,cleanup;let next=0;const pending=new Map();
function run(command,argv,env=process.env){const r=spawnSync(command,argv,{cwd:source,env,encoding:'utf8',timeout:40000});assert.equal(r.status,0,r.stdout+'\n'+r.stderr);return r.stdout.trim();}
async function port(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const p=server.address().port;await new Promise(r=>server.close(r));return p;}
async function inspect(expression){const id=++next;return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Inspector timeout'));},10000);pending.set(id,{resolve:r=>{clearTimeout(timer);if(r.exceptionDetails)reject(new Error(JSON.stringify(r)));else resolve(r.result.value);},reject});socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));});}
async function actual(){return JSON.parse(await inspect(`JSON.stringify((()=>{const {app,BrowserWindow}=process.mainModule.require('electron');const w=BrowserWindow.getAllWindows()[0];return {pid:process.pid,visible:w?.isVisible(),windows:BrowserWindow.getAllWindows().length,title:w?.getTitle(),userData:app.getPath('userData'),appPath:app.getAppPath()};})())`));}
async function wait(check,label){const deadline=Date.now()+15000;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out: '+label);}
async function journal(project,sid,wrong=false){const file=path.join(home,'.codex/sessions/2026/11/16',`rollout-fixture-${sid}.jsonl`);await mkdir(path.dirname(file),{recursive:true});const at=new Date().toISOString();const rows=[{type:'session_meta',timestamp:at,payload:{id:wrong?crypto.randomUUID():sid,cwd:project,source:'vscode',originator:'Codex Desktop'}},{type:'event_msg',timestamp:at,payload:{type:'task_started',turn_id:'fixture-turn'}},{type:'response_item',timestamp:at,payload:{type:'function_call',call_id:'fixture-call',name:'read_file',arguments:JSON.stringify({file_path:'fixture.txt'})}}];await writeFile(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');}
try{
 await mkdir(appRoot,{recursive:true});await mkdir(service);await mkdir(home);
 for(const folder of ['scripts','desktop'])await cp(path.join(source,folder),path.join(appRoot,folder),{recursive:true});
 await cp(runtime,path.join(appRoot,'runtime'),{recursive:true,filter:p=>!p.includes('__pycache__')});
 // Test-only reader home injection. Production runtime and HOME are unchanged.
 const writer=path.join(appRoot,'runtime/observer_state.py');const original=await readFile(writer,'utf8');
 const prefix=`import external_journal as _journal\nfrom pathlib import Path as _FixturePath\n_JournalBase=_journal.OfficialJournalReader\nclass _FixtureJournal(_JournalBase):\n def __init__(self,cache=None,**kwargs):\n  super().__init__(cache,home=_FixturePath(${JSON.stringify(home)}))\n_journal.OfficialJournalReader=_FixtureJournal\n`;
 await writeFile(writer,prefix+original);
 run('node',[path.join(path.dirname(require.resolve('vite/package.json')),'bin/vite.js'),'build','--outDir',path.join(appRoot,'dist'),'--emptyOutDir']);
 const p=await port();const electron=require('electron');const wrapper=path.join(fixture,'instrumented electron');
 await writeFile(wrapper,`#!/usr/bin/env python3\nimport os,sys\nos.execv(${JSON.stringify(electron)},[${JSON.stringify(electron)},'--inspect=127.0.0.1:${p}',*sys.argv[1:]])\n`);await chmod(wrapper,0o755);
 const env={...process.env,PYTHONDONTWRITEBYTECODE:'1',DSH_HOME:path.join(fixture,'native home'),SHIPBOSS_ELECTRON_BINARY:wrapper};
 for(const key of ['CODEX_THREAD_ID','CLAUDE_SESSION_ID','SHIPBOSS_OBSERVER_HOME','ELECTRON_RUN_AS_NODE'])delete env[key];
 const a=path.join(fixture,'DSH repo');const b=path.join(fixture,'Codex repo with spaces');await mkdir(a);await mkdir(b);
 const aId=crypto.randomUUID(),bId=crypto.randomUUID();
 run('python3',['-c',`import sys\nsys.path.insert(0,${JSON.stringify(path.join(source,'scripts'))})\nfrom pathlib import Path\nfrom test_observer_bootstrap import native\nnative(Path(${JSON.stringify(env.DSH_HOME)}),Path(${JSON.stringify(a)}),${JSON.stringify(aId)})`],env);
 const entry=path.join(appRoot,'scripts/observer-service.py');
 const call=(action,extra=[])=>JSON.parse(run('python3',[entry,action,'--service-dir',service,'--project',a,'--harness','dsh','--owner-session',aId,...extra],env));
 cleanup=()=>call('stop');const first=call('start');assert.deepEqual(first.started,['writer','app']);
 const targets=await(await fetch(`http://127.0.0.1:${p}/json/list`)).json();socket=new WebSocket(targets[0].webSocketDebuggerUrl);
 socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const h=pending.get(m.id);pending.delete(m.id);m.error?h.reject(new Error(JSON.stringify(m.error))):h.resolve(m.result);}});
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 await wait(async()=>Boolean((await actual()).visible),'initial show');
 evidence.identity=await actual();assert.ok(evidence.identity.userData.startsWith(fixture));assert.equal(evidence.identity.windows,1);
 await wait(async()=>{try{return JSON.parse(await readFile(path.join(service,'helper-status.json'),'utf8')).status==='ready';}catch{return false;}},'helper ready metadata');
 evidence.stages.push('existing real helper advertises bounded metadata queue');
 const hide=()=>inspect(`process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].hide()`);
 await hide();
 function queued(action='start',sid=bId,project=b){
  const script=`import importlib.util,json,os\nfrom unittest.mock import patch\nspec=importlib.util.spec_from_file_location('service',${JSON.stringify(entry)})\ns=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)\nwith patch('subprocess.run',side_effect=PermissionError(1,'Operation not permitted','ps')) as ps,patch('subprocess.Popen',side_effect=AssertionError('launch forbidden')):\n result=s.main(${JSON.stringify([action,'--harness','codex','--owner-session',sid,'--context-id',sid,'--project',project,'--service-dir',service])})\n assert result==0 and ps.call_count==0\n`;
  const result=JSON.parse(run('python3',['-c',script],{...env,DSH_SESSION_ID:'session-parent-dsh-wrong'}));assert.equal(result.queued,true);assert.equal(result.shown,false);return result;
 }
 queued();await new Promise(r=>setTimeout(r,1700));assert.equal((await actual()).visible,false);
 assert.equal(await readFile(path.join(service,'helper-status.json'),'utf8').then(JSON.parse).then(v=>v.appPid),first.app_pid);
 evidence.stages.push('zero-ps queue with no official journal does not show or grant PM');
 await journal(b,bId);
 await wait(async()=>Boolean((await actual()).visible),'official journal validated request shows');
 await wait(async()=>JSON.parse(await readFile(stateFile,'utf8')).projects.length===2,'DSH/Codex multi-project same diagram');
 const payload=JSON.parse(await readFile(stateFile,'utf8'));const project=payload.projects.find(p=>p.name===path.basename(b));
 assert.equal(project.actors[0].active,true);assert.equal((await actual()).pid,first.app_pid);assert.equal((await actual()).windows,1);
 evidence.projects=payload.projects.map(p=>({name:p.name,owner:p.ownerSessionId,pmActive:p.actors[0].active}));evidence.stages.push('official-schema Codex Desktop journal validates; request shows same single window with two projects');
 const bytes=await readFile(path.join(b,'.delegate/observer/runtime.json'),'utf8');
 await hide();queued();await new Promise(r=>setTimeout(r,1700));assert.equal((await actual()).visible,false);
 assert.equal(await readFile(path.join(b,'.delegate/observer/runtime.json'),'utf8'),bytes);evidence.stages.push('duplicate firstload keeps hidden and immutable registry');
 queued('show');await wait(async()=>(await actual()).visible,'explicit queued show');evidence.stages.push('explicit queued show creates a fresh request and restores same PID');
 const invalid=path.join(fixture,'wrong official identity');await mkdir(invalid);const badId=crypto.randomUUID();await journal(invalid,badId,true);await hide();queued('start',badId,invalid);
 await new Promise(r=>setTimeout(r,1700));assert.equal((await actual()).visible,false);assert.equal((await actual()).windows,1);evidence.stages.push('wrong official journal identity is not accepted for presentation');
 evidence.helper=JSON.parse(await readFile(path.join(service,'helper-status.json'),'utf8'));assert.ok(evidence.helper.seenRequestIds.length<=256);
 evidence.passed=true;
}catch(error){evidence.failure={message:error.message,stack:error.stack};console.error(error.stack);process.exitCode=1;}
finally{if(socket)socket.close();if(cleanup)try{cleanup();evidence.ownedProcessesStopped=true;}catch(e){evidence.cleanupError=e.message;evidence.passed=false;process.exitCode=1;}await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(evidence,null,2));}
console.log(JSON.stringify({passed:evidence.passed,out:output,identity:evidence.identity,stages:evidence.stages,ownedProcessesStopped:evidence.ownedProcessesStopped}));
