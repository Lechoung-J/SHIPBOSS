// Same native->writer fixture, file bridge, real window and time/random input for source / --app.
import assert from 'node:assert/strict';
import { _electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rename, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const value = flag => { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1]; };
const appPath = value('--app');
if (appPath && !path.isAbsolute(appPath)) throw new Error('--app requires absolute path');
const out = path.resolve(value('--out') || path.join(root, 'artifacts/activity-check', appPath ? 'package' : 'source', `run-${Date.now()}-${process.pid}`));
await mkdir(out, { recursive: true });
const fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'EXAMPLE-052-activity-'));
const statePath = path.join(fixtureDir, 'state.json');
const built = spawnSync('python3', [path.join(root, 'runtime/test_tool_activity.py'), '--fixture', statePath], { cwd: root, encoding: 'utf8' });
assert.equal(built.status, 0, built.stderr);
const payload = JSON.parse(await readFile(statePath, 'utf8'));
const project = payload.projects[0], projectId = project.id;
// The writer fixture now starts with actual 83/91-character opaque native IDs.
// Only normalized wire IDs cross the file bridge; no renderer limit changes.
for (const actor of project.actors.slice(0, 2)) {
 assert.equal(actor.toolActivity.runningCount, 1);
 assert.match(actor.toolActivity.calls[0].callId, /^native-sha256-[a-f0-9]{64}$/);
}
const baseAt = Date.now(); let fixtureNow = baseAt;
for (const actor of project.actors) if (actor.toolActivity) for (const c of actor.toolActivity.calls) {
 c.timestamp = baseAt - 800; c.startedAt = baseAt - 800;
}
// Fixture name is explicit; this is never a real project activity claim.
project.name = '活动气泡 fixture'; project.source = 'EXAMPLE-052 synthetic native file-bridge fixture';
const evidence = { passed: false, kind: 'engineering self-check; synthetic native fixtures, not independent acceptance', sourceOrApp: appPath || 'source', nativeInput: { callIdLengths: [83, 91], containsPipe: true, mappedBy: 'runtime native_call_id; per-session SHA256', wireIds: project.actors.slice(0,2).map(actor=>actor.toolActivity.calls[0].callId) }, fixtureDir, stages: [], errors: [], screenshots: [] };
let app = null, page = null, timer = null, queue = Promise.resolve();
async function publish() {
 queue = queue.then(async () => {
  payload.generatedAt = new Date().toISOString();
  await writeFile(statePath + '.tmp', JSON.stringify(payload)); await rename(statePath + '.tmp', statePath);
 });
 return queue;
}
async function checkpoint(label) {
 const current = await page.evaluate(() => window.__SHIPBOSS_WIDGET__.getState());
 const bubbles = current.activityBubbles.filter(b => b.visible);
 const rectangles = await page.evaluate(()=>[...document.querySelectorAll('.activity-bubble:not([hidden])')].map(node=>({key:node.dataset.key,text:node.textContent,rect:node.getBoundingClientRect().toJSON()})));
 for (let i=0;i<rectangles.length;i++) for(const right of rectangles.slice(i+1)) {
  const a=rectangles[i].rect,b=right.rect;
  assert.ok(a.right<=b.left || a.left>=b.right || a.bottom<=b.top || a.top>=b.bottom,'actual text rectangles do not overlap');
 }
 assert.equal(new Set(bubbles.map(b => b.key)).size, bubbles.length, 'single slot per actor');
 evidence.stages.push({ label, observedAt: Date.now(), clock: fixtureNow, bubbles, rectangles, rooms: current.rooms.map(r => ({ id:r.id,collected:r.collected,inView:r.inView,scene:r.scene.characters })) });
 return current;
}
const bubble = id => `${projectId}/${id}`;
async function expectBubble(id, match) {
 await page.waitForFunction(({key,match}) => window.__SHIPBOSS_WIDGET__.getState().activityBubbles.some(b => b.key === key && b.visible && new RegExp(match).test(b.text)), { key: bubble(id), match }, { timeout: 20000 });
}
async function setClock(delta) { fixtureNow += delta; await page.evaluate(now => { window.__ACTIVITY_TEST__.now = now; }, fixtureNow); }
async function replace(id, category, state = 'started', extra = {}) {
 const actor = project.actors.find(a => a.id === id);
 actor.toolActivity.calls = [{ callId:`call-${id}-${fixtureNow}`,sequence:Math.round(fixtureNow-baseAt)+100,state,category,target:category === 'read' || category === 'edit' ? 'app.ts' : '',timestamp:fixtureNow,startedAt:fixtureNow,...extra }];
 actor.toolActivity.runningCount = state === 'started' ? 1 : 0;
 actor.toolActivity.thinking = false;
 await publish();
}
async function shot(name) { await page.locator('#observer').screenshot({ path: path.join(out, name+'.png') }); evidence.screenshots.push(name+'.png'); }
async function hashes(base, rel = '') {
 const result = {};
 for (const item of await readdir(path.join(base,rel),{withFileTypes:true})) {
  const next = path.join(rel,item.name);
  if (item.isDirectory()) Object.assign(result,await hashes(base,next));
  else if (item.isFile()) result[next] = crypto.createHash('sha256').update(await readFile(path.join(base,next))).digest('hex');
 }
 return result;
}
try {
 await publish(); timer = setInterval(() => { publish().catch(e=>evidence.errors.push(e.message)); }, 500);
 const executablePath = appPath?.endsWith('.app') ? path.join(appPath,'Contents/MacOS/SHIPBOSS Observer') : appPath;
 const env = {...process.env,SHIPBOSS_TEST_MODE:'1',SHIPBOSS_TEST_RUN_ID:`activity-check-${process.pid}`,SHIPBOSS_ACTIVITY_PREVIEW:'1',SHIPBOSS_OBSERVER_STATE:statePath};
 delete env.ELECTRON_RUN_AS_NODE; delete env.SHIPBOSS_DEV_URL;
 app = await _electron.launch({ executablePath: executablePath || require('electron'),args:executablePath ? []:[path.join(root,'desktop/main.cjs')],cwd:root,env,timeout:30000 });
 page = await app.firstWindow(); page.on('pageerror',e=>evidence.errors.push(e.message));
 await page.addInitScript(({now})=>{window.__ACTIVITY_TEST__={now,random:.2};},{now:fixtureNow});
 await page.reload();
 await page.waitForFunction(()=>window.__SHIPBOSS_WIDGET__?.getState().rendering.frames>1);
 evidence.identity = await app.evaluate(({app})=>({name:app.getName(),exe:app.getPath('exe'),appPath:app.getAppPath(),userData:app.getPath('userData')}));
 const input = appPath?.endsWith('.app') ? path.join(appPath,'Contents/Resources/app') : root;
 evidence.hashes = {desktop:await hashes(path.join(input,'desktop')),dist:await hashes(path.join(input,'dist'))};
 assert.match(evidence.identity.name,/体验版/);
 assert.match(evidence.identity.userData,/activity-check-/);
 const received = await page.evaluate(()=>window.shipbossObserver.getState());
 assert.equal(received.projects[0].actors[1].toolActivity.sessionId,'eng-worker');
 assert.equal(JSON.stringify(received).includes('SECRET'),false);
 await expectBubble('pm','读文件'); await expectBubble('eng-a','修改文件');
 await checkpoint('native read/edit independently visible'); await shot('01-read-edit-small');
 for (const [category,label] of [['command','执行命令'],['test','跑测试'],['delegate','请同事检查'],['other','使用工具']]) {
  await setClock(1000); await replace('eng-a',category); await expectBubble('eng-a',label); await checkpoint(category);
 }
 const a = project.actors[1];
 a.toolActivity.calls.push({...a.toolActivity.calls[0],callId:'parallel-new',sequence:999999,category:'read'});a.toolActivity.runningCount=2;await publish();
 await expectBubble('eng-a','2并行');
 a.toolActivity.calls[0].state='ended';a.toolActivity.runningCount=1;await publish();await expectBubble('eng-a','读文件');
 await checkpoint('old result preserves newer active call');
 await setClock(1000);await replace('eng-a','read','ended');await expectBubble('eng-a','刚完成');
 await setClock(1200);
 await page.waitForFunction(key=>!window.__SHIPBOSS_WIDGET__.getState().activityBubbles.some(b=>b.key===key&&b.visible),bubble('eng-a'));
 await checkpoint('duplicate completion does not replay');
 // Explicit thinking only. PM remains in a real tool, so at most one fun bubble.
 a.toolActivity.calls=[];a.toolActivity.runningCount=0;a.toolActivity.thinking=true;await publish();
 await page.waitForFunction(()=>window.__SHIPBOSS_WIDGET__.getState().rooms[0].actorActivities[1].toolActivity?.thinking);
 await setClock(100);
 const frame = await page.evaluate(()=>window.__SHIPBOSS_WIDGET__.getState().rendering.frames);
 await page.waitForFunction(f=>window.__SHIPBOSS_WIDGET__.getState().rendering.frames>f+1,frame);
 await setClock(2100);
 await expectBubble('eng-a','愿代码|理一理|认真敲'); await checkpoint('stable thinking local phrase');await shot('02-local-fun');
 const phrase = (await checkpoint('same phrase no per-frame draw')).activityBubbles.find(b=>b.key===bubble('eng-a')).text;
 await setClock(1000); await expectBubble('eng-a',phrase.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
 await replace('eng-a','command');await expectBubble('eng-a','执行命令');await checkpoint('tool preempts fun');
 a.toolActivity.calls=[];a.toolActivity.runningCount=0;a.toolActivity.thinking=true;await publish();await setClock(3000);await page.waitForTimeout(650);
 assert.equal((await checkpoint('cooldown remains after tool')).activityBubbles.some(b=>b.key===bubble('eng-a')&&b.visible),false);
 await setClock(25000);await expectBubble('eng-a','愿代码|理一理|认真敲');
 await setClock(100);await replace('eng-a','edit','error');await expectBubble('eng-a','工具出错');await checkpoint('tool error is not task verdict');
 assert.equal(project.tasks[0].verdict,null);
 project.awaitingUser=true;project.needsAttention=true;await publish();
 await page.waitForFunction(()=>window.__SHIPBOSS_WIDGET__.getState().rooms[0].scene.questionVisible);
 await page.waitForFunction(key=>!window.__SHIPBOSS_WIDGET__.getState().activityBubbles.some(b=>b.key===key&&b.visible),bubble('pm'));
 await checkpoint('human priority over PM tool');
 project.awaitingUser=false;project.needsAttention=false; a.uncertain=true;await publish();await expectBubble('eng-a','状态未知');await checkpoint('unknown priority');
 a.uncertain=false;await replace('eng-a','read');
 await page.emulateMedia({reducedMotion:'reduce'});await expectBubble('eng-a','读文件');await checkpoint('reduced motion still readable');
 // Hide via actual desktop bridge; no stale phrase backlog on restore.
 await page.evaluate(()=>window.shipbossDesktop.hide());await setClock(50000);await page.waitForTimeout(650);
 await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].show();});
 await expectBubble('eng-a','读文件');await checkpoint('hide restore current tool');
 await page.evaluate(()=>window.shipbossDesktop.setExpanded(true));await expectBubble('eng-a','读文件');await shot('03-expanded');
 const floor = await page.evaluate(id=>window.__SHIPBOSS_WIDGET__.roomPoint(id),projectId);
 await page.mouse.click(floor.x,floor.y,{button:'right'});await page.locator('#collect-room').click();
 await page.waitForFunction(()=>window.__SHIPBOSS_WIDGET__.getState().rooms[0].collected);
 await page.waitForFunction(()=>!window.__SHIPBOSS_WIDGET__.getState().activityBubbles.some(b=>b.visible));
 await checkpoint('collected room has no bubbles');
 await setClock(1000);await replace('eng-a','edit','ended');await page.waitForTimeout(650);
 await page.locator('#collection-fallback').click();await page.locator('.collection-row').click();await page.locator('#collection-close').click();
 await page.waitForFunction(()=>!window.__SHIPBOSS_WIDGET__.getState().rooms[0].collected);
 await page.waitForTimeout(200);
 assert.equal((await checkpoint('restore does not replay collected completion')).activityBubbles.some(b=>b.key===bubble('eng-a')&&b.visible),false);
 await replace('eng-a','read');await expectBubble('eng-a','读文件');
 await page.mouse.move(300,400);await page.mouse.down();await page.mouse.move(2300,2400,{steps:8});await page.mouse.up();
 await page.waitForFunction(()=>!window.__SHIPBOSS_WIDGET__.getState().activityBubbles.some(b=>b.visible));await checkpoint('camera offscreen pauses bubbles');
 await page.locator('#reset-camera').click();await expectBubble('eng-a','读文件');await checkpoint('camera restore current tool');
 await page.mouse.move(300,300);await page.mouse.wheel(0,-180);await page.waitForTimeout(150);await expectBubble('eng-a','读文件');await checkpoint('zoom preserves readable 2D tool');
 clearInterval(timer);timer=null;await queue;await writeFile(statePath,'{broken');
 await page.waitForFunction(()=>window.__SHIPBOSS_WIDGET__.getState().observer.status==='stale');await expectBubble('eng-a','状态未知');await checkpoint('disconnect masks detailed tool');
 await publish();timer=setInterval(()=>{publish().catch(e=>evidence.errors.push(e.message));},500);await expectBubble('eng-a','读文件');
 a.active=false;a.motion='idle';await publish();
 await page.waitForFunction(key=>!window.__SHIPBOSS_WIDGET__.getState().activityBubbles.some(b=>b.key===key&&b.visible),bubble('eng-a'));await checkpoint('role exit removes bubble without verdict');
 assert.equal(evidence.errors.length,0,JSON.stringify(evidence.errors));
 evidence.completed=true; evidence.passed=true;
} catch (error) {
 evidence.completed=false;evidence.passed=false;evidence.failure={message:error.message,stack:error.stack};
 if (page) {
  evidence.failureState = await page.evaluate(async()=>({state:window.__SHIPBOSS_WIDGET__?.getState(),envelope:await window.shipbossObserver.getState(),testing:window.shipbossObserver.activityTesting,clock:window.__ACTIVITY_TEST__})).catch(()=>null);
  await shot('failure').catch(()=>{});
 }
 console.error(error.stack);process.exitCode=1;
} finally {
 clearInterval(timer);await queue.catch(()=>{});
 if(app)await app.close().catch(e=>{evidence.closeError=e.message;evidence.passed=false;evidence.completed=false;process.exitCode=1;});
 await writeFile(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2));
}

console.log(JSON.stringify({passed:evidence.passed,completed:evidence.completed,out,identity:evidence.identity,stages:evidence.stages.length}));
