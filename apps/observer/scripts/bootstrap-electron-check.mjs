// EXAMPLE-055: actual bootstrap first spawn; isolated installation, native fixtures, Node Inspector.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, cp, writeFile, readFile, realpath, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
const require = createRequire(import.meta.url);
const source = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const value = name => { const i=argv.indexOf(name); return i<0?null:argv[i+1]; };
const runtimeSource = value('--runtime-source') || path.join(source,'runtime');
const fixture = await realpath(await mkdtemp(path.join(os.tmpdir(),'shipboss-bootstrap-gui-')));
const stage = path.join(fixture,'source app');
const dest = path.join(fixture,'installed skill');
const service = path.join(fixture,'service');
const evidencePath = value('--out') || path.join(fixture,'evidence.json');
const evidence = {passed:false, kind:'engineering self-check; synthetic DSH success files, actual bootstrap-spawned installed Electron; no seeded PIDs', fixture, stages:[]};
let socket, cleanup;
const run = (command,args,env=process.env) => {
 const p=spawnSync(command,args,{cwd:source,env,encoding:'utf8',timeout:45000});
 assert.equal(p.status,0,p.stdout+'\n'+p.stderr);return p.stdout.trim();
};
async function freePort() {
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
let nextId=0;
const requests=new Map();
async function inspect(expression) {
 const id=++nextId;
 const response=await new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>{requests.delete(id);reject(new Error('Inspector evaluation timeout'));},10000);
   requests.set(id,{resolve:value=>{clearTimeout(timeout);resolve(value);},reject});
   socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));
 });
 assert.equal(response.exceptionDetails,undefined,JSON.stringify(response));
 return response.result.value;
}
async function state() {
 return JSON.parse(await inspect(`JSON.stringify((()=>{const {app,BrowserWindow}=process.mainModule.require('electron');const w=BrowserWindow.getAllWindows()[0];return {pid:process.pid,name:app.getName(),appPath:app.getAppPath(),userData:app.getPath('userData'),title:w?.getTitle(),visible:w?.isVisible(),windowCount:BrowserWindow.getAllWindows().length};})())`));
}
async function waitVisible(visible) {
 const deadline=Date.now()+15000;
 while(Date.now()<deadline){const current=await state();if(current.visible===visible)return current;await new Promise(resolve=>setTimeout(resolve,100));}
 throw new Error('actual BrowserWindow visibility did not become '+visible);
}
try {
 await mkdir(stage,{recursive:true});
 for (const folder of ['scripts','desktop']) await cp(path.join(source,folder),path.join(stage,folder),{recursive:true});
 await cp(runtimeSource,path.join(stage,'runtime'),{recursive:true,filter:p=>!p.includes('__pycache__')});
 const renderer=path.join(fixture,'renderer dist');
 run('node',[path.join(path.dirname(require.resolve('vite/package.json')),'bin/vite.js'),'build','--outDir',renderer,'--emptyOutDir']);
 const electron=require('electron');
 const env={...process.env,PYTHONDONTWRITEBYTECODE:'1'};
 delete env.DSH_SESSION_ID;delete env.SHIPBOSS_OBSERVER_HOME;delete env.ELECTRON_RUN_AS_NODE;delete env.SHIPBOSS_OBSERVER_SERVICE_DIR;
 const installed=JSON.parse(run('python3',[path.join(stage,'scripts/observer-install.py'),'--destination',dest,'--with-observer','--renderer-dist',renderer,'--electron-binary',electron,'--no-start'],env));
 assert.equal(installed.readiness.ready,true,JSON.stringify(installed.readiness));
 assert.equal(installed.startup.attempted,false);
 assert.equal(installed.files.some(f=>f.path.includes('node_modules')||f.path.includes('artifacts/')),false);
 evidence.install={readiness:installed.readiness,startup:installed.startup,fileCount:installed.files.length};
 const project=path.join(fixture,'repo A with spaces');
 const home=path.join(fixture,'native home');
 await mkdir(project);await mkdir(service);
 const sid=crypto.randomUUID();
 function native(root,id) {
  const expression=`import sys\nsys.path.insert(0,${JSON.stringify(path.join(source,'scripts'))})\nfrom test_observer_bootstrap import native\nfrom pathlib import Path\nnative(Path(${JSON.stringify(home)}),Path(${JSON.stringify(root)}),${JSON.stringify(id)})\n`;
  run('python3',['-c',expression],env);
 }
 native(project,sid);
 const installedApp=path.join(dest,'observer');
 const prefs=path.join(installedApp,'artifacts/runtime/shipboss-observer/preferences.json');
 await mkdir(path.dirname(prefs),{recursive:true});
 const preferences={version:1,pinned:false,expanded:false,bounds:{x:140,y:120,width:440,height:360},collections:{bridge:['p-preserve-fixture'],demo:[]}};
 await writeFile(prefs,JSON.stringify(preferences));
 const inspectorPort=await freePort();
 // Only this temp executable adds loopback instrumentation. Product desktop is byte-identical.
 const wrapper=path.join(fixture,'electron inspect wrapper');
 await writeFile(wrapper,`#!/usr/bin/env python3\nimport os, sys\nos.execv(${JSON.stringify(electron)},[${JSON.stringify(electron)},'--inspect=127.0.0.1:${inspectorPort}',*sys.argv[1:]])\n`);
 await chmod(wrapper,0o755);
 const appEnv={...env,DSH_HOME:home,DSH_SESSION_ID:sid,SHIPBOSS_ELECTRON_BINARY:wrapper};
 const entry=path.join(dest,'scripts/observer-bootstrap.py');
 const call=(action,root=project,id=sid)=>JSON.parse(run('python3',[entry,action,'--project',root,'--owner-session',id,'--service-dir',service],appEnv));
 cleanup=()=>call('stop');
 const first=call('start');
 assert.deepEqual(first.started,['writer','app']);assert.equal(first.first_show_requested,true);
 const manifest=JSON.parse(await readFile(path.join(service,'processes.json'),'utf8'));
 evidence.processManifest=manifest;
 assert.equal(first.app_pid,manifest.app.pid);
 const targets=await (await fetch(`http://127.0.0.1:${inspectorPort}/json/list`)).json();
 socket=new WebSocket(targets[0].webSocketDebuggerUrl);
 socket.addEventListener('message',event=>{const message=JSON.parse(event.data);const pending=requests.get(message.id);if(pending){requests.delete(message.id);message.error?pending.reject(new Error(JSON.stringify(message.error))):pending.resolve(message.result);}});
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 // Main-process Inspector sees the actual BrowserWindow, not a screenshot or launch assumption.
 const initial=await waitVisible(true);
 assert.equal(initial.pid,first.app_pid);assert.equal(initial.visible,true);assert.equal(initial.windowCount,1);
 assert.equal(initial.name,'SHIPBOSS Observer');assert.doesNotMatch(initial.title,/preview|体验版|预览/i);
 assert.ok(initial.userData.startsWith(dest));assert.ok(initial.appPath.startsWith(dest));
 evidence.identity=initial;evidence.stages.push('bootstrap from zero PIDs spawns installed Electron; actual BrowserWindow visible');
 await inspect(`process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].hide()`);
 assert.equal((await state()).visible,false);
 const repeat=call('start');assert.deepEqual(repeat.started,[]);assert.equal(repeat.first_show_requested,false);
 assert.equal((await state()).visible,false);evidence.stages.push('A repeat remains hidden; same app/writer');
 const projectB=path.join(fixture,'repo B');await mkdir(projectB);const sidB=crypto.randomUUID();native(projectB,sidB);
 const b=call('start',projectB,sidB);assert.equal(b.app_pid,initial.pid);assert.equal(b.writer_pid,first.writer_pid);assert.deepEqual(b.started,[]);assert.equal(b.first_show_requested,true);
 assert.equal((await waitVisible(true)).visible,true);evidence.stages.push('B first load shows same existing PID');
 await inspect(`process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].hide()`);
 assert.equal(call('start',projectB,sidB).first_show_requested,false);assert.equal((await state()).visible,false);
 evidence.stages.push('B repeat remains hidden');
 const registry=path.join(project,'.delegate/observer/runtime.json');const before=await readFile(registry,'utf8');
 const newSid=crypto.randomUUID();native(project,newSid);const newer=call('start',project,newSid);
 assert.equal(newer.app_pid,initial.pid);assert.equal(newer.first_show_requested,true);assert.equal((await waitVisible(true)).visible,true);
 assert.equal(await readFile(registry,'utf8'),before);evidence.stages.push('A new session shows same PID; immutable owner/registry bytes preserved');
 await inspect(`process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].hide()`);
 assert.equal(call('start',project,newSid).first_show_requested,false);assert.equal((await state()).visible,false);
 const shown=call('show');assert.equal(shown.app_pid,initial.pid);assert.equal((await waitVisible(true)).visible,true);assert.equal((await state()).windowCount,1);
 evidence.stages.push('same session repeat hidden, explicit show restores one window');
 const saved=JSON.parse(await readFile(prefs,'utf8'));assert.deepEqual(saved.collections,preferences.collections);assert.equal(saved.pinned,false);
 evidence.preferences={collections:saved.collections,pinned:saved.pinned};evidence.stages.push('temp existing prefs and collections preserved');
 const autoInstall=JSON.parse(run('python3',[path.join(stage,'scripts/observer-install.py'),'--destination',dest,'--observer-home',installedApp,'--electron-binary',electron,'--project',project],{...appEnv,DSH_SESSION_ID:newSid,SHIPBOSS_OBSERVER_SERVICE_DIR:service}));
 assert.equal(autoInstall.startup.attempted,true);assert.equal(autoInstall.startup.exit_code,0,JSON.stringify(autoInstall.startup));
 const auto=JSON.parse(autoInstall.startup.output);assert.deepEqual(auto.started,[]);assert.equal(auto.app_pid,initial.pid);
 evidence.install.verifiedSessionStartup=autoInstall.startup;evidence.stages.push('installer default with verified native session reuses actual bootstrap app');
 evidence.passed=true;
} catch(error) {
 evidence.failure={message:error.message,stack:error.stack};console.error(error.stack);process.exitCode=1;
} finally {
 if(socket)socket.close();
 if(cleanup)try{cleanup();evidence.ownedProcessesStopped=true;}catch(e){evidence.cleanupError=e.message;evidence.passed=false;process.exitCode=1;}
 await mkdir(path.dirname(evidencePath),{recursive:true});await writeFile(evidencePath,JSON.stringify(evidence,null,2));
}
console.log(JSON.stringify({passed:evidence.passed,out:evidencePath,identity:evidence.identity,install:evidence.install,stages:evidence.stages,ownedProcessesStopped:evidence.ownedProcessesStopped}));
