// Read-only verification of the same compiled page and production state file.
// The test window is isolated; local browser time is not mocked.
import assert from 'node:assert/strict';
import { _electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const statePath = process.argv[2];
assert.ok(statePath, 'Supply the absolute live state path');
const out = path.join(root, 'artifacts/night-window');
await mkdir(out, {recursive:true});
const env = {...process.env, SHIPBOSS_TEST_MODE:'1', SHIPBOSS_TEST_RUN_ID:`night-window-${Date.now()}`, SHIPBOSS_OBSERVER_STATE:statePath};
delete env.ELECTRON_RUN_AS_NODE; delete env.SHIPBOSS_DEV_URL;
let app;
try {
 app = await _electron.launch({executablePath:require('electron'),args:[path.join(root,'desktop/main.cjs')],cwd:root,env,timeout:30000});
 const page = await app.firstWindow();
 await page.waitForFunction(()=>window.__SHIPBOSS_WIDGET__?.getState().rooms.length>0 && window.__SHIPBOSS_WIDGET__.getState().rendering.frames>1);
 const actual = await page.evaluate(async()=>({
  state:window.__SHIPBOSS_WIDGET__.getState(),
  envelope:await window.shipbossObserver.getState(),
  clock:new Date().toString(), zone:Intl.DateTimeFormat().resolvedOptions().timeZone,
  label:document.querySelector('.demo-tag').textContent,
  font:getComputedStyle(document.querySelector('.demo-tag')).fontSize,
  tagWidth:document.querySelector('.demo-tag').getBoundingClientRect().width,
  viewport:document.querySelector('#observer').getBoundingClientRect().width,
 }));
 assert.equal(actual.state.observer.mode,'bridge'); assert.equal(actual.state.observer.demo,false);
 assert.equal(actual.state.time.source,'local');
 assert.match(actual.label,/实时同步/);
 assert.ok(actual.label.includes(actual.state.time.label));
 assert.ok(actual.tagWidth < actual.viewport);
 assert.ok(parseFloat(actual.font)>=10);
 const hour = new Date().getHours();
 if(hour<4 || hour>=21)assert.equal(actual.state.time.label,'夜晚');
 await page.locator('#observer').screenshot({path:path.join(out,'small-current.png')});
 await page.evaluate(()=>window.shipbossDesktop.setExpanded(true));
 // Frame the same offices with the normal wheel/pan controls in this test window.
 await page.waitForFunction(()=>window.__SHIPBOSS_WIDGET__.getState().width>=718);
 await page.evaluate(()=>{
  const canvas=document.querySelector('#canvas-host canvas'),r=canvas.getBoundingClientRect();
  for(let i=0;i<40;i++)canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:120,clientX:r.x+r.width/2,clientY:r.y+r.height/2,bubbles:true,cancelable:true}));
 });
 const delta=await page.evaluate(()=>{
  const w=window.__SHIPBOSS_WIDGET__,s=w.getState(),points=s.rooms.map(r=>w.projectPoint(r.id,0,0,0));
  const r=document.querySelector('#observer').getBoundingClientRect();
  return {x:r.width/2-points.reduce((a,p)=>a+p.x,0)/points.length,y:r.height/2-points.reduce((a,p)=>a+p.y,0)/points.length};
 });
 await page.mouse.move(360,300);await page.mouse.down();await page.mouse.move(360+delta.x,300+delta.y,{steps:10});await page.mouse.up();await page.mouse.move(690,80);
 await page.locator('#observer').screenshot({path:path.join(out,'current-overview.png')});
 const previews=[];
 for(const [index,name,hour] of [[0,'morning',6.5],[1,'day',13],[2,'dusk',18.6],[3,'night',21.5]]) {
  await page.keyboard.press('t');
  await page.waitForFunction(h=>Math.abs(window.__SHIPBOSS_WIDGET__.getState().time.hour-h)<.01,hour);
  const frame=await page.evaluate(()=>window.__SHIPBOSS_WIDGET__.getState().rendering.frames);
  await page.waitForFunction(f=>window.__SHIPBOSS_WIDGET__.getState().rendering.frames>f,frame);
  const preview=await page.evaluate(()=>({time:window.__SHIPBOSS_WIDGET__.getState().time,label:document.querySelector('.demo-tag').textContent}));
  assert.match(preview.label,/预览/);
  await page.locator('#observer').screenshot({path:path.join(out,`${name}.png`)});
  previews.push({name,...preview});
 }
 await page.keyboard.press('t');
 await page.waitForFunction(()=>window.__SHIPBOSS_WIDGET__.getState().time.source==='local' && !document.querySelector('.demo-tag').textContent.includes('预览'));
 assert.equal(actual.envelope.projects.length,actual.state.rooms.length);
 const evidence={passed:true,kind:'isolated window; same compiled page, actual local clock and production snapshot; not an OS capture of the existing window',localTime:actual.clock,timezone:actual.zone,time:actual.state.time,label:actual.label,font:actual.font,roomCount:actual.state.rooms.length,previews};
 await writeFile(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify(evidence));
} finally { if(app)await app.close(); }
