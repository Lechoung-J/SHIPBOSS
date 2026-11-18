import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { createOffice } from './office.js';
import './style.css';

const $ = selector => document.querySelector(selector);
const stages = [
  { heading: '想法到站，开始排任务。', subtitle: 'PM 接收消息，把这一轮工作安排好。', name: 'PM 整理与派发', roles: ['排任务 · 准备派发', '等待任务', '等待交付'] },
  { heading: '收到，这就开工。', subtitle: '工程师快步入场。电脑亮起，待办开始处理。', name: '工程师实现中', roles: ['已离场', '实现中 · 敲敲敲', '等待交付'] },
  { heading: '做好了，再独立检查一次。', subtitle: '工程师离场，验收员接手，逐项核对交付。', name: '独立验收中', roles: ['等待回调', '已离场', '独立检查中'] },
  { heading: '结果回来了，PM 再看一眼。', subtitle: '验收结果回调给 PM；查看报告，再决定下一步。', name: 'PM 查看验收结果', roles: ['查看报告 · 安排下一步', '已离场', '验收已完成'] },
  { heading: '这一批完成，工作室待命。', subtitle: '没有新的待办，PM 离场。交付台留着本轮汇报。', name: '交付完成 · 等待新消息', roles: ['已离场', '已离场', '已离场'] },
];
const roles = ['产品经理', '工程师', '验收员'];
const descriptions = [
  '把想法整理成可检查的任务，协调派发，并把结论汇成一页纸。',
  '收到任务后进门，走到亮起的电脑前实现。完成后离场，待办交给验收员。',
  '轮到验收时进门独立检查。完成后回调给 PM，由 PM 查看结果和安排下一步。',
];
let cycle = 1;
const totalCycles = 2;
let stage = 0, playing = false, paused = false, selected = null, stageTime = 0, elapsed = 0, readyAt = null;
const stageDuration = 3.5;
let lastRoleSignature = "";
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
} catch (error) {
  $('#loading').innerHTML = '<div class="load-error">暂时无法启动 3D 工作室。<br/>请使用支持 WebGL 的浏览器，并开启图形加速。</div>';
  throw error;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.06;
$('#scene').appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color('#cecdc5');
const environment = new RoomEnvironment();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(environment, .06).texture;
scene.environmentIntensity = .35;
environment.dispose(); pmrem.dispose();
const camera = new THREE.OrthographicCamera(-12, 12, 8, -8, .1, 150);
camera.position.set(22, 22.7, 22);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, .7, 0); controls.enableDamping = true; controls.dampingFactor = .09;
controls.enablePan = false; controls.minZoom = .8; controls.maxZoom = 1.65;
controls.minPolarAngle = Math.PI / 5; controls.maxPolarAngle = Math.PI / 2.65;
controls.minAzimuthAngle = -.55; controls.maxAzimuthAngle = 1.25;
controls.rotateSpeed = .4; controls.zoomSpeed = .65;
controls.update(); controls.saveState();
const hemi = new THREE.HemisphereLight('#eeeae2', '#827d73', 1.3); scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff4df', 2.8);
sun.position.set(-3, 18, 9); sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096); sun.shadow.camera.left = -13; sun.shadow.camera.right = 13;
sun.shadow.camera.top = 12; sun.shadow.camera.bottom = -12; sun.shadow.camera.near = 1; sun.shadow.camera.far = 45;
sun.shadow.bias = -.00015; sun.shadow.normalBias = .02; sun.shadow.radius = 5; scene.add(sun);
const fill = new THREE.DirectionalLight('#dce3e4', .85); fill.position.set(8, 9, -5); scene.add(fill);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: '#a8a69e', roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -.445; ground.receiveShadow = true; scene.add(ground);
const office = createOffice(scene);
const composer = new EffectComposer(renderer);
composer.renderTarget1.samples = 4; composer.renderTarget2.samples = 4;
const ao = new SSAOPass(scene, camera, innerWidth, innerHeight, 16);
ao.ssaoMaterial.defines.PERSPECTIVE_CAMERA = 0;
ao.depthRenderMaterial.defines.PERSPECTIVE_CAMERA = 0;
ao.kernelRadius = .38; ao.minDistance = .0003; ao.maxDistance = .03;
composer.addPass(new RenderPass(scene, camera)); composer.addPass(ao); composer.addPass(new OutputPass());
const labels = roles.map((role, i) => {
  const button = document.createElement('button'); button.className = 'station-label';
  button.dataset.station = String(i); button.setAttribute('aria-label', `查看${role}工位`);
  button.innerHTML = `<span class="status-light"></span><span><strong>${role}</strong><span class="role-status"></span></span>`;
  button.addEventListener('click', () => showDetail(i)); $('#scene-labels').appendChild(button); return button;
});
const deliveryLabel = document.createElement('button'); deliveryLabel.className = 'station-label delivery-label';
deliveryLabel.setAttribute('aria-label', '查看交付台'); deliveryLabel.innerHTML = '<span><strong>交付台 ↗</strong><span class="role-status">等待验收通过</span></span>';
deliveryLabel.addEventListener('click', () => showDetail('delivery')); $('#scene-labels').appendChild(deliveryLabel);

function setStage(next) {
  stage = next; stageTime = elapsed; readyAt = null; office.setStage(stage); lastRoleSignature = "";
  const state = stages[stage];
  $('.task-id').textContent = `TASK 0${cycle}`;
  $('.task-name').textContent = stage === 4 ? '本批已完成 · 等待新消息' : `第 ${cycle} / ${totalCycles} 项 · 待办 ${totalCycles - cycle}`;
  $('#scene-heading').textContent = state.heading; $('#scene-subtitle').textContent = stage === 3 ? (cycle < totalCycles ? 'PM 查看验收结果。还有下一项待办，准备继续派发。' : 'PM 查看验收结果。待办已清空，整理汇报后收工。') : state.subtitle;
  document.querySelectorAll('.step').forEach((button, i) => {
    button.classList.toggle('active', i === stage); button.classList.toggle('visited', i < stage); button.setAttribute('aria-pressed', String(i === stage));
  });
  labels.forEach((label, i) => {
    label.querySelector('.role-status').textContent = state.roles[i];
    label.dataset.active = String(office.snapshot().screens[i]); label.hidden = !office.snapshot().screens[i];
    label.dataset.complete = String(stage === 3);
  });
  deliveryLabel.hidden = stage !== 4;
  deliveryLabel.querySelector('.role-status').textContent = '一页纸汇报已就绪';
  deliveryLabel.dataset.complete = String(stage === 4);
  if (selected !== null) renderDetail();
  updatePlaybackCaption();
}
function updateRoleLabels() {
  const state = office.snapshot();
  const modeNames = { entering: '进门 · 前往工位', sitting: '正在落座', working: '', standing: '工作结束 · 起身', exiting: '下班 · 正在出门' };
  const signature = state.characters.map(a => a.mode).join('/') + stage + ':' + cycle;
  if (signature !== lastRoleSignature) {
    labels.forEach((label, i) => {
      const actor = state.characters[i];
      label.hidden = !state.screens[i];
      label.querySelector('.role-status').textContent = actor.mode === 'absent' ? (state.screens[i] ? '收到消息 · 即将进门' : stages[stage].roles[i]) : actor.mode === 'working' ? (stage === 3 ? (cycle < totalCycles ? '查看报告 · 继续派发' : '查看报告 · 准备收工') : stages[stage].roles[i]) : modeNames[actor.mode];
    });
    if (selected !== null && selected !== 'delivery') $('#detail-state').textContent = labels[selected].querySelector('.role-status').textContent;
    lastRoleSignature = signature;
  }
  return state;
}
function updatePlaybackCaption() {
  if (stage === 4 && paused) { $('#playback-caption').textContent = '本批完成 · 点击播放重演'; return; }
  if (paused) { $('#playback-caption').textContent = '演示已暂停'; return; }
  if (!playing) { $('#playback-caption').textContent = '阶段预览 · 点击播放看完整交班'; return; }
  $('#playback-caption').textContent = readyAt === null ? '自动演示 · 进出与交接中' : `自动演示 · ${Math.max(1, Math.ceil(stageDuration - (elapsed - readyAt)))} 秒后交班`;
}
function togglePlay(next = !playing) {
  if (next && stage === 4) { cycle = 1; setStage(0); }
  playing = next; paused = !next;
  $('#toggle-play').setAttribute('aria-label', playing ? '暂停演示' : '自动播放演示');
  $('#toggle-play').innerHTML = playing ? '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M5 4h3v12H5zM12 4h3v12h-3z"/></svg>' : '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M6 4.5v11L15 10 6 4.5Z"/></svg>';
  updatePlaybackCaption();
}
function showDetail(value) { selected = value; office.select(typeof value === 'number' ? value : null); renderDetail(); $('#detail-panel').hidden = false; }
function renderDetail() {
  const delivery = selected === 'delivery';
  const reviewing = selected === 0 && stage === 3;
  $('#detail-eyebrow').textContent = delivery ? 'DELIVERY / ONE-PAGE REPORT' : reviewing ? 'CALLBACK / PM REVIEW' : `WORKSTATION 0${selected + 1}`;
  $('#detail-title').textContent = delivery ? '一页纸交付' : roles[selected];
  $('#detail-description').textContent = delivery ? '一份任务，留下可追溯的结论。工程师提交之后，仍需独立验收。' : descriptions[selected];
  $('#detail-state').textContent = delivery ? stages[stage].name : labels[selected].querySelector('.role-status').textContent;
  const report = $('#detail-report'); report.hidden = !delivery && !reviewing;
  if (delivery || reviewing) {
    report.innerHTML = stage >= 3
      ? '<div class="report-stamp">PASS</div><p class="report-row"><strong>改了什么</strong><br/>本项独立验收已完成，结果回调给 PM 查看。</p><p class="report-row"><strong>验证记录 · 示例</strong><br/>实现交付、独立检查、PM 复核。</p><p class="report-row"><strong>风险</strong><br/>当前为假数据演示，尚未接入真实事件。</p><p class="report-row"><strong>需要你</strong><br/>看一眼画面气质，决定下一版方向。</p>'
      : '<div class="report-pending">交付台还没有完成的汇报。<br/>等待独立验收通过后，汇报才会出现在这里。</div>';
  }
  labels.forEach((label, i) => label.classList.toggle('selected', selected === i));
  deliveryLabel.classList.toggle('selected', delivery);
}
function closeDetail() { selected = null; $('#detail-panel').hidden = true; office.select(null); labels.forEach(l => l.classList.remove('selected')); deliveryLabel.classList.remove('selected'); }
$('#close-detail').addEventListener('click', closeDetail);
window.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetail(); });
document.querySelectorAll('.step').forEach(button => button.addEventListener('click', () => { togglePlay(false); paused = false; setStage(Number(button.dataset.stage)); }));
$('#toggle-play').addEventListener('click', () => togglePlay());
$('#reset-view').addEventListener('click', () => { controls.reset(); resize(); });
function rotate(delta) {
  const offset = camera.position.clone().sub(controls.target); const spherical = new THREE.Spherical().setFromVector3(offset);
  spherical.theta = THREE.MathUtils.clamp(spherical.theta + delta, controls.minAzimuthAngle, controls.maxAzimuthAngle);
  camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical)); controls.update();
}
$('#rotate-left').addEventListener('click', () => rotate(-.2)); $('#rotate-right').addEventListener('click', () => rotate(.2));
function zoom(factor) { camera.zoom = THREE.MathUtils.clamp(camera.zoom * factor, controls.minZoom, controls.maxZoom); camera.updateProjectionMatrix(); }
$('#zoom-in').addEventListener('click', () => zoom(1.12)); $('#zoom-out').addEventListener('click', () => zoom(1 / 1.12));

const raycaster = new THREE.Raycaster(); const pointer = new THREE.Vector2(); let pointerStart = null;
function hitAt(event) {
  const bounds = renderer.domElement.getBoundingClientRect(); pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
  raycaster.setFromCamera(pointer, camera); return raycaster.intersectObjects(office.hitTargets, false)[0]?.object;
}
renderer.domElement.addEventListener('pointerdown', e => { pointerStart = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!pointerStart || Math.hypot(e.clientX - pointerStart.x, e.clientY - pointerStart.y) > 7) { pointerStart = null; return; }
  const hit = hitAt(e); if (hit) showDetail(hit.userData.kind === 'station' ? hit.userData.index : 'delivery'); else closeDetail(); pointerStart = null;
});
renderer.domElement.addEventListener('pointermove', e => {
  if (e.pointerType !== 'mouse' || e.buttons) { $('#hover-hint').hidden = true; return; }
  const hit = hitAt(e); renderer.domElement.style.cursor = hit ? 'pointer' : 'grab';
  const hint = $('#hover-hint'); hint.hidden = !hit;
  if (hit) { hint.textContent = hit.userData.kind === 'station' ? `查看${roles[hit.userData.index]}工位` : '打开交付卷宗'; hint.style.left = `${Math.min(e.clientX + 16, innerWidth - 155)}px`; hint.style.top = `${e.clientY - 32}px`; }
});
renderer.domElement.addEventListener('pointerleave', () => { $('#hover-hint').hidden = true; pointerStart = null; });

function resize() {
  const w = $('#scene').clientWidth, h = $('#scene').clientHeight, aspect = w / h;
  const vertical = Math.max(17.8, 21.5 / aspect);
  camera.left = -vertical * aspect / 2; camera.right = vertical * aspect / 2; camera.top = vertical / 2; camera.bottom = -vertical / 2;
  camera.updateProjectionMatrix(); renderer.setSize(w, h); composer.setSize(w, h);
}
window.addEventListener('resize', resize); resize(); setStage(0); togglePlay(true);
const projected = new THREE.Vector3();
function positionLabel(element, position) {
  projected.copy(position).project(camera);
  const bubble = !element.classList.contains('delivery-label');
  const px = (projected.x * .5 + .5) * renderer.domElement.clientWidth;
  const py = (-projected.y * .5 + .5) * renderer.domElement.clientHeight;
  const half = element.offsetWidth / 2;
  element.style.left = `${THREE.MathUtils.clamp(px + (bubble ? 36 : 0), half + 10, innerWidth - half - 10)}px`;
  element.style.top = `${py - (bubble ? 12 : 0)}px`;
  element.style.visibility = projected.z > 1 || projected.z < -1 ? 'hidden' : 'visible';
}
let lastTime = performance.now(), previousSecond = -1, visible = !document.hidden;
function frame(now) {
  requestAnimationFrame(frame);
  const delta = Math.min((now - lastTime) / 1000, .05); lastTime = now;
  if (!visible) return;
  if (!paused) elapsed += delta;
  office.update(elapsed);
  if (office.settled() && readyAt === null) readyAt = elapsed;
  if (playing && readyAt !== null && elapsed - readyAt >= stageDuration) {
    if (stage === 3 && cycle < totalCycles) { cycle++; setStage(0); }
    else if (stage === 4) togglePlay(false);
    else setStage(stage + 1);
  }
  updateRoleLabels();
  const second = Math.floor(elapsed); if (second !== previousSecond) { updatePlaybackCaption(); previousSecond = second; }
  controls.update();
  ao.ssaoMaterial.uniforms.cameraProjectionMatrix.value.copy(camera.projectionMatrix);
  ao.ssaoMaterial.uniforms.cameraInverseProjectionMatrix.value.copy(camera.projectionMatrixInverse);
  composer.render();
  labels.forEach((label, i) => positionLabel(label, office.anchors[i])); positionLabel(deliveryLabel, office.deliveryAnchor);
}
document.addEventListener('visibilitychange', () => { visible = !document.hidden; lastTime = performance.now(); });
renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); togglePlay(false); $('#loading').style.opacity = '1'; $('#loading').hidden = false; $('#loading').innerHTML = '<div class="load-error">图形上下文已暂停。请刷新页面重新打开工作室。</div>'; });
requestAnimationFrame(frame);
requestAnimationFrame(() => { $('#loading').style.opacity = '0'; setTimeout(() => { $('#loading').hidden = true; }, 550); });
// Read-only diagnostics for the visual smoke check; no task execution API.
window.__SHIPBOSS_DEMO__ = {
  getState: () => ({ stage, cycle, pendingTasks: totalCycles - cycle, playing, paused, selected, ...office.snapshot(), drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, cameraZoom: camera.zoom, demo: true }),
  project: (x, y, z) => { const p = new THREE.Vector3(x, y, z).project(camera); return { x: (p.x * .5 + .5) * innerWidth, y: (-p.y * .5 + .5) * innerHeight }; },
};
