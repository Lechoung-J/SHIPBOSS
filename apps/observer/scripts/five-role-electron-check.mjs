// Five-role native->writer->desktop->headpoint->single-slot DOM, same source/app input.
import assert from 'node:assert/strict';
import { _electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp,mkdir,readFile,writeFile,rename,readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(import.meta.url),args=process.argv.slice(2);
const option=key=>{const i=args.indexOf(key);return i<0?null:args[i+1];};
const appPath=option('--app');if(appPath&&!path.isAbsolute(appPath))throw Error('--app requires absolute path');
const out=path.resolve(option('--out')||path.join(root,'artifacts/complete-roles',appPath?'package':'source',`run-${Date.now()}-${process.pid}`));await mkdir(out,{recursive:true});
const fixture=await mkdtemp(path.join(os.tmpdir(),'EXAMPLE-054-five-roles-')),statePath=path.join(fixture,'state.json');
const roles=['pm','eng-a','eng-b','verifier','recording'];let virtualNow=Date.now(),app,page,timer,queue=Promise.resolve(),payload,projectId;
const evidence={passed:false,completed:false,kind:'engineering self-check; synthetic five-role native events; not independent acceptance',sourceOrApp:appPath||'source',fixture,stages:[],errors:[],screenshots:[]};
function producer(action='init',role='pm'){
 const result=spawnSync('python3',[path.join(root,'runtime/five_role_fixture.py'),'--directory',fixture,'--out',statePath,'--action',action,'--role',role,'--clock',String(virtualNow/1000)],{cwd:root,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
}
async function reloadFixture(action,role){await queue;producer(action,role);payload=JSON.parse(await readFile(statePath,'utf8'));}
async function publish(){queue=queue.then(async()=>{payload.generatedAt=new Date().toISOString();await writeFile(statePath+'.tmp',JSON.stringify(payload));await rename(statePath+'.tmp',statePath);});return queue;}
async function state(){return page.evaluate(()=>window.__SHIPBOSS_WIDGET__.getState());}
async function clock(delta){virtualNow+=delta;await page.evaluate(now=>window.__ACTIVITY_TEST__.now=now,virtualNow);}
async function expect(role,pattern){await page.waitForFunction(({id,role,pattern})=>window.__SHIPBOSS_WIDGET__.getState().activityBubbles.some(b=>b.key===`${id}/${role}`&&b.visible&&new RegExp(pattern).test(b.text)),{id:projectId,role,pattern},{timeout:30000});}
async function absent(role){await page.waitForFunction(({id,role})=>!window.__SHIPBOSS_WIDGET__.getState().activityBubbles.some(b=>b.key===`${id}/${role}`&&b.visible),{id:projectId,role},{timeout:20000});}
async function checkpoint(label){
 const s=await state();const rectangles=await page.evaluate(()=>[...document.querySelectorAll('.activity-bubble:not([hidden])')].map(n=>({key:n.dataset.key,text:n.textContent,rect:n.getBoundingClientRect().toJSON()})));
 assert.equal(new Set(rectangles.map(r=>r.key)).size,rectangles.length);
 for(let i=0;i<rectangles.length;i++)for(const b of rectangles.slice(i+1)){const a=rectangles[i].rect,c=b.rect;assert.ok(a.right<=c.left||a.left>=c.right||a.bottom<=c.top||a.top>=c.bottom,'visible bubble rectangles do not overlap');}
 evidence.stages.push({label,at:Date.now(),virtualNow,bubbles:s.activityBubbles.filter(b=>b.visible),rectangles,rooms:s.rooms.map(r=>({id:r.id,collected:r.collected,inView:r.inView,characters:r.scene.characters,scribe:r.scene.scribe,waiting:r.scene.waiting})),frames:s.rendering.frames});
 return s;
}
async function shot(name){await page.locator('#observer').screenshot({path:path.join(out,name+'.png')});evidence.screenshots.push(name+'.png');}
async function hashes(directory,relative=''){const result={};for(const entry of await readdir(path.join(directory,relative),{withFileTypes:true})){const rel=path.join(relative,entry.name);if(entry.isDirectory())Object.assign(result,await hashes(directory,rel));else if(entry.isFile())result[rel]=crypto.createHash('sha256').update(await readFile(path.join(directory,rel))).digest('hex');}return result;}
try{
 await reloadFixture('init');projectId=payload.projects.find(p=>p.name==='five-roles').id;
 timer=setInterval(()=>publish().catch(e=>evidence.errors.push(e.message)),500);
 const executablePath=appPath?.endsWith('.app')?path.join(appPath,'Contents/MacOS/SHIPBOSS Observer'):appPath;
 const env={...process.env,SHIPBOSS_TEST_MODE:'1',SHIPBOSS_TEST_RUN_ID:`five-role-${process.pid}`,SHIPBOSS_ACTIVITY_PREVIEW:'1',SHIPBOSS_OBSERVER_STATE:statePath};delete env.ELECTRON_RUN_AS_NODE;delete env.SHIPBOSS_DEV_URL;
 app=await _electron.launch({executablePath:executablePath||require('electron'),args:executablePath?[]:[path.join(root,'desktop/main.cjs')],cwd:root,env,timeout:30000});page=await app.firstWindow();page.on('pageerror',e=>evidence.errors.push(e.message));
 await page.addInitScript(now=>{window.__ACTIVITY_TEST__={now,random:.2};},virtualNow);await page.reload();
 await page.waitForFunction(()=>window.__SHIPBOSS_WIDGET__?.getState().rooms.length===2&&window.__SHIPBOSS_WIDGET__.getState().rendering.frames>1);
 evidence.identity=await app.evaluate(({app})=>({name:app.getName(),exe:app.getPath('exe'),appPath:app.getAppPath(),userData:app.getPath('userData')}));
 const input=appPath?.endsWith('.app')?path.join(appPath,'Contents/Resources/app'):root;evidence.hashes={desktop:await hashes(path.join(input,'desktop')),dist:await hashes(path.join(input,'dist'))};
 const entry=[];const deadline=Date.now()+45000;
 while(Date.now()<deadline){const s=await state();const r=s.rooms.find(r=>r.id===projectId);entry.push({at:Date.now(),animationTime:s.rendering.animationTime,characters:r.scene.characters,scribe:r.scene.scribe});if(r.scene.characters.every(c=>c.mode==='working')&&r.scene.scribe.mode==='reading')break;await page.waitForTimeout(120);}
 evidence.entrySamples=entry;assert.ok(entry.some(e=>e.characters.some(c=>c.mode==='entering')||e.scribe.mode==='entering'),'normal entry is sampled');
 const final=(await state()).rooms.find(r=>r.id===projectId);assert.ok(final.scene.characters.every(c=>c.mode==='working'));assert.equal(final.scene.scribe.mode,'reading');
 const received=await page.evaluate(()=>window.shipbossObserver.getState());const p=received.projects.find(p=>p.id===projectId);assert.equal(p.actors.length,4);assert.equal(p.recordingActor.id,'recording');assert.ok(p.recordingActor.toolActivity);
 for(const role of roles){await expect(role,role==='eng-a'?'修改文件':role==='eng-b'?'执行命令':role==='verifier'?'找调用位置':'读文件');const point=await page.evaluate(({id,index})=>window.__SHIPBOSS_WIDGET__.actorHeadPoint(id,index),{id:projectId,index:roles.indexOf(role)});assert.ok(Number.isFinite(point.x)&&Number.isFinite(point.y),`${role} has its own finite head point`);await checkpoint('native tool visible '+role);}
 await shot('01-five-tools-small');
 // One native role at a time receives matching step after tool result. Other
 // roles remain in real tools. Cooling is injectable; no simultaneous five fun.
 for(const role of roles){
  await clock(1200);await reloadFixture('thinking',role);await publish();
  await page.waitForFunction(({id,role})=>{const p=window.__SHIPBOSS_WIDGET__.getState().rooms.find(r=>r.id===id);return(role==='recording'?p.recordingActivity:p.actorActivities.find(a=>a.id===role))?.toolActivity?.thinking;},{id:projectId,role});
  await clock(5000);await page.waitForTimeout(180);await clock(2100);
  await expect(role,'省心|下一步|专心|少绕弯|理一理|认真敲|仔细|细节|关键|线索|记录');
  const s=await checkpoint('native thinking local phrase '+role);assert.ok(s.activityBubbles.filter(b=>b.visible&&b.kind==='fun').length<=2);await shot('02-thinking-'+role);
  await reloadFixture('tool',role);await publish();await expect(role,'读文件');await checkpoint('tool preempts local phrase '+role);
 }
 await clock(1000);await reloadFixture('error','recording');await publish();await expect('recording','工具出错');await checkpoint('scribe error does not become task verdict');
 assert.ok(payload.projects.find(p=>p.id===projectId).tasks.every(t=>t.verdict===null));
 await clock(1500);await reloadFixture('unknown','recording');await publish();await expect('recording','状态未知');await checkpoint('scribe unknown priority');
 // Recover via only the synthetic registry; then test exact current tool state.
 const control=JSON.parse(await readFile(path.join(fixture,'control.json'),'utf8'));
 const recovery=spawnSync('python3',['-c',`import sys;sys.path.insert(0,${JSON.stringify(path.join(root,'runtime'))});from registry import update;update(${JSON.stringify(control.root)},'launch-recording',state='running')`],{encoding:'utf8'});assert.equal(recovery.status,0,recovery.stderr);
 await reloadFixture('tool','recording');await publish();await expect('recording','读文件');
 await page.emulateMedia({reducedMotion:'reduce'});await checkpoint('five slots readable with reduced motion');
 await page.evaluate(()=>window.shipbossDesktop.hide());await clock(40000);await page.waitForTimeout(600);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());
 for(const role of roles)await expect(role,'读文件');await checkpoint('hidden restore latest tools no backlog');
 await page.evaluate(()=>window.shipbossDesktop.setExpanded(true));await page.waitForFunction(()=>window.__SHIPBOSS_WIDGET__.getState().width>700);await shot('03-five-tools-expanded');
 const floor=await page.evaluate(id=>window.__SHIPBOSS_WIDGET__.roomPoint(id),projectId);await page.mouse.click(floor.x,floor.y,{button:'right'});await page.locator('#collect-room').click();
 await page.waitForFunction(id=>window.__SHIPBOSS_WIDGET__.getState().rooms.find(r=>r.id===id).collected,projectId);for(const role of roles)await absent(role);await checkpoint('collected all five paused');
 await page.locator('#collection-fallback').click();await page.locator('.collection-row').click();await page.locator('#collection-close').click();for(const role of roles)await expect(role,'读文件');await checkpoint('collection restores latest five tools');
 await page.mouse.move(300,400);await page.mouse.down();await page.mouse.move(2300,2400,{steps:8});await page.mouse.up();for(const role of roles)await absent(role);await checkpoint('offscreen all five paused');await page.locator('#reset-camera').click();for(const role of roles)await expect(role,'读文件');
 clearInterval(timer);timer=null;await queue;await writeFile(statePath,'{broken');await page.waitForFunction(()=>window.__SHIPBOSS_WIDGET__.getState().observer.status==='stale');for(const role of roles)await expect(role,'状态未知');await checkpoint('disconnect five roles unknown');
 await publish();timer=setInterval(()=>publish().catch(e=>evidence.errors.push(e.message)),500);for(const role of roles)await expect(role,'读文件');
 for(const role of ['eng-a','eng-b','verifier','recording']){await reloadFixture('exit',role);await publish();await absent(role);await checkpoint('explicit role exit '+role);}
 assert.equal(evidence.errors.length,0,JSON.stringify(evidence.errors));evidence.passed=true;evidence.completed=true;
}catch(error){evidence.failure={message:error.message,stack:error.stack};if(page){evidence.failureState=await state().catch(()=>null);await shot('failure').catch(()=>{});}console.error(error.stack);process.exitCode=1;}
finally{clearInterval(timer);await queue.catch(()=>{});if(app)await app.close().catch(e=>{evidence.closeError=e.message;evidence.passed=false;evidence.completed=false;process.exitCode=1;});await writeFile(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2));}
console.log(JSON.stringify({passed:evidence.passed,completed:evidence.completed,stages:evidence.stages.length,out,identity:evidence.identity}));
