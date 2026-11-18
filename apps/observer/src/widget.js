import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { createOffice } from './office.js';
import { createProjectModel } from './project-model.js';
import { createBridgeModel } from './observer-adapter.js';
import { sampleTimeOfDay, sunPosition } from './time-of-day.js';
import { observationLabel } from './observation-label.js';
import { CollectionState, normalizeCollectedIds } from './collection-state.js';
import { compactTargets, gridSlotPosition, cabinetTargetFor, cameraDepthAdjustment, COLLECTION_MOTION_MS, COLLECTION_SINK, COLLECTION_SCALE, makePoseTween, samplePoseTween, samePoseTarget } from './collection-layout.js';
import { createServerCabinet } from './server-cabinet.js';
import { QUALITY_PROFILES, detectQuality } from './quality.js';
import { createActivityOverlay } from './activity-bubbles.js';
import './widget.css';

const $ = selector => document.querySelector(selector);
const desktop = window.shipbossDesktop, observerBridge = window.shipbossObserver;
const bridgeMode = Boolean(observerBridge && observerBridge.mode === 'bridge');
const demoMode = !bridgeMode;
// In bridge mode the demo model is never created or advanced.
const model = bridgeMode ? createBridgeModel() : createProjectModel();
if (bridgeMode) {
  $('.demo-tag').textContent = '等待项目状态';
  $('.sheet-foot').textContent = '只读观察 · 在原会话中回答问题';
}
let bridgeInfo = { status: bridgeMode ? 'waiting' : 'demo', error: null };
const slots = ['pm', 'eng-a', 'eng-b', 'verifier'];
const activityOverlay = createActivityOverlay({
  now: () => observerBridge?.activityTesting && Number.isFinite(window.__ACTIVITY_TEST__?.now) ? window.__ACTIVITY_TEST__.now : Date.now(),
  random: () => observerBridge?.activityTesting && Number.isFinite(window.__ACTIVITY_TEST__?.random) ? window.__ACTIVITY_TEST__.random : Math.random(),
});
const statusNames = { queued: '待派发', implementing: '实现中', testing: '测试中', verifying: '独立验收', reviewing: 'PM 复核', rework: '返工中', done: '已完成', 'needs-human': '等待决定' };
const clean = text => String(text || '').replace(/^演示[：:]/, '').replace(/ · 演示/g, '');
const PIXELS_PER_UNIT = 21.5;
const rooms = new Map();
const collectionState = new CollectionState();
const collectionScope = bridgeMode ? 'bridge' : 'demo';
let collectionReady = false, collectionLayoutDirty = false, collectionPanelSignature = '', collectionPanelTrigger = null;
let roomMenuProjectId = null, cabinetTween = null, collectionSaveQueue = Promise.resolve();
const PREVIEW_TIMES = [{ hour: 6.5, label: '清晨' }, { hour: 13, label: '白天' }, { hour: 18.6, label: '黄昏' }, { hour: 21.5, label: '夜晚' }];
let previewCursor = -1;
let sheet = null, hovered = null, pointerDown = null, pointerPosition = null;
let nativeState = { pinned: false, expanded: false, visible: true }, nativeVisible = true;
let visualTime = 0, modelAt = performance.now(), visualAt = modelAt, lastRenderAt = 0, renderFrames = 0;
let disposed = false, ready = false, newProjectAdded = false, tooltipKey = '', lastSheetSignature = '', lastStatus = '';
const controller = new AbortController();
const listen = (element, name, handler, options = {}) => element.addEventListener(name, handler, { ...options, signal: controller.signal });
function isVisible() { return !document.hidden && nativeVisible; }
function toast(text) {
  $('#toast').textContent = text; $('#toast').hidden = false; clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 2600);
}
if (!desktop) {
  document.body.classList.add('preview'); $('#pin-window').disabled = true; $('#hide-window').disabled = true;
  $('#pin-window').title = 'Mac 桌面版支持置顶'; $('#hide-window').title = 'Mac 桌面版支持收进菜单栏';
}
function applyNativeState(state) {
  const wasVisible = nativeVisible; nativeState = state; nativeVisible = state.visible !== false;
  $('#pin-window').setAttribute('aria-pressed', String(state.pinned)); $('#pin-window').title = state.pinned ? '取消置顶' : '置顶观察窗';
  $('#expand-window').setAttribute('aria-pressed', String(state.expanded)); $('#expand-window').setAttribute('aria-label', state.expanded ? '收回小窗' : '展开观察窗');
  document.body.classList.toggle('expanded', state.expanded);
  if (ready && !wasVisible && nativeVisible) { modelTick(); visualAt = performance.now(); }
}
if (desktop) { desktop.getState().then(applyNativeState).catch(() => toast('无法读取窗口设置')); desktop.onState(applyNativeState); }
function applyObserverState(envelope) {
  if (!envelope || envelope.mode !== 'bridge' || !Array.isArray(envelope.projects)) return;
  model.setState(envelope);
  bridgeInfo = { status: envelope.status || 'live', error: envelope.error || null };
  updateObservationLabel();
  if (ready) syncProjects();
}
if (bridgeMode && observerBridge) {
  observerBridge.getState().then(applyObserverState).catch(() => {
    bridgeInfo = { status: 'waiting', error: { type: 'ipc-failed', at: new Date().toISOString() } };
    if (ready) syncProjects();
  });
  observerBridge.onState(applyObserverState);
}
listen($('#pin-window'), 'click', async () => { try { applyNativeState(await desktop.setPinned(!nativeState.pinned)); } catch { toast('置顶设置未更新'); } });
listen($('#expand-window'), 'click', async () => {
  try { if (desktop) applyNativeState(await desktop.setExpanded(!nativeState.expanded)); else applyNativeState({ ...nativeState, expanded: !nativeState.expanded }); }
  catch { toast('暂时无法调整窗口'); }
});
listen($('#hide-window'), 'click', async () => { try { await desktop.hide(); } catch { toast('暂时无法收起窗口'); } });

let renderer, scene, camera, controls, composer, ao, bloom, hemi, sun, fill, cabinet;
let qualityInfo, qualityTier, qualityProfile, slowFrames = 0, lastTimeUpdate = 0;
let timeState = sampleTimeOfDay();
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
  qualityInfo = detectQuality(renderer, new URLSearchParams(location.search).get('quality'));
  qualityTier = qualityInfo.tier; qualityProfile = QUALITY_PROFILES[qualityTier];
  renderer.setPixelRatio(Math.min(devicePixelRatio, qualityProfile.pixelRatio)); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.06;
  $('#canvas-host').appendChild(renderer.domElement);
  scene = new THREE.Scene(); scene.background = new THREE.Color('#c7c2b6');
  const pmrem = new THREE.PMREMGenerator(renderer), environment = new RoomEnvironment();
  scene.environment = pmrem.fromScene(environment, .025).texture; scene.environmentIntensity = .35; environment.dispose(); pmrem.dispose();
  camera = new THREE.OrthographicCamera(-12, 12, 8, -8, .1, 220); camera.position.set(32, 32.8, 32);
  controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0, .8, 0);
  controls.enableRotate = false; controls.enablePan = true; controls.screenSpacePanning = true; controls.enableDamping = false;
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: null };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
  controls.panSpeed = 1; controls.zoomSpeed = .65; controls.minZoom = .38; controls.maxZoom = 2.5; controls.zoomToCursor = true;
  controls.update(); controls.saveState();
  hemi = new THREE.HemisphereLight('#eeeae2', '#827d73', 1.3); scene.add(hemi);
  sun = new THREE.DirectionalLight('#fff4df', 2.8); sun.position.set(7, 36, 19); sun.target.position.set(9, 0, 6); scene.add(sun.target); sun.castShadow = true;
  sun.shadow.mapSize.set(qualityProfile.shadows, qualityProfile.shadows); sun.shadow.camera.left = -35; sun.shadow.camera.right = 35; sun.shadow.camera.top = 30; sun.shadow.camera.bottom = -30; sun.shadow.camera.far = 100;
  sun.shadow.bias = -.00015; sun.shadow.normalBias = .02; sun.shadow.radius = 4; scene.add(sun);
  fill = new THREE.DirectionalLight('#dce3e4', .85); fill.position.set(8, 9, -5); scene.add(fill);
  // The map uses one continuous backdrop. Room floors retain their own shadows;
  // an exterior terrain plane exposes its clip edge when zooming or panning.
  composer = new EffectComposer(renderer); composer.renderTarget1.samples = qualityProfile.msaa; composer.renderTarget2.samples = qualityProfile.msaa;
  composer.addPass(new RenderPass(scene, camera));
  if (qualityProfile.ssao) {
    ao = new SSAOPass(scene, camera, 440, 360, qualityTier === 'high' ? 12 : 8); ao.ssaoMaterial.defines.PERSPECTIVE_CAMERA = 0; ao.depthRenderMaterial.defines.PERSPECTIVE_CAMERA = 0;
    ao.kernelRadius = .38; ao.minDistance = .0003; ao.maxDistance = .03; composer.addPass(ao);
  }
  if (qualityProfile.bloom) { bloom = new UnrealBloomPass(new THREE.Vector2(440, 360), .16, .5, .9); composer.addPass(bloom); }
  composer.addPass(new OutputPass());
  cabinet = createServerCabinet(THREE); cabinet.position.set(10, 0, 0); scene.add(cabinet);
} catch (error) {
  $('#scene-error').hidden = false; $('#scene-error').textContent = '3D 地图暂时无法打开。请检查图形加速。'; $('#widget-loading').hidden = true; throw error;
}

// Stable discovery order supplies base grid slots; collection compacts only visible rooms.
function roomPosition(index) {
  return new THREE.Vector3(...gridSlotPosition(index));
}
function updateRecordBounds(record) {
  const scale = record.office.room.scale.x;
  record.bounds.copy(record.localBounds);
  record.bounds.min.multiplyScalar(scale).add(record.office.room.position);
  record.bounds.max.multiplyScalar(scale).add(record.office.room.position);
}
function registerProject(project) {
  if (rooms.has(project.id)) return rooms.get(project.id);
  const index = rooms.size;
  const themeIndex = { shipboss: 0, website: 1, tool: 2 }[project.id];
  const office = createOffice(scene, { parallel: true, projectId: project.id, themeIndex });
  office.statusIndicators.layer.userData.externalThoughts = true;
  office.room.position.copy(roomPosition(index)); office.room.userData.projectId = project.id;
  office.room.traverse(object => { if (object.userData.kind) object.userData.projectId = project.id; });
  const collected = collectionState.has(project.id);
  if (collected) { office.room.position.y = COLLECTION_SINK; office.room.scale.setScalar(COLLECTION_SCALE); office.room.visible = false; }
  const record = {
    office, index, bounds: new THREE.Box3(), localBounds: new THREE.Box3(new THREE.Vector3(-9.4, -.5, -5.3), new THREE.Vector3(7.3, 4.7, 5.3)),
    project, signature: '', inView: true, hiddenSettled: collected, transition: null,
    layoutTarget: null, collected,
  };
  updateRecordBounds(record); office.setEnvironment(timeState);
  rooms.set(project.id, record); collectionLayoutDirty = true; return record;
}
function poseOf(record) { return { position: record.office.room.position.toArray(), scale: record.office.room.scale.x }; }
function setPose(record, pose) {
  record.office.room.position.fromArray(pose.position); record.office.room.scale.setScalar(pose.scale); updateRecordBounds(record);
}
function moveCabinet(target, animate) {
  const goal = { position: [...target], scale: 1 };
  const existing = cabinet.userData.layoutTarget;
  if (samePoseTarget(existing, goal)) return;
  cabinet.userData.layoutTarget = goal;
  if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    cabinet.position.fromArray(goal.position); cabinetTween = null; return;
  }
  cabinetTween = makePoseTween({ position: cabinet.position.toArray(), scale: 1 }, goal, performance.now());
}
function ensureLayoutDepth(roomCount, rackTarget) {
  camera.updateMatrixWorld(true); scene.updateMatrixWorld(true);
  let nearestViewZ = -Infinity, farthestViewZ = Infinity;
  const includeBounds = bounds => {
    const viewBounds = bounds.clone().applyMatrix4(camera.matrixWorldInverse);
    nearestViewZ = Math.max(nearestViewZ, viewBounds.max.z);
    farthestViewZ = Math.min(farthestViewZ, viewBounds.min.z);
  };
  for (let index = 0; index < roomCount; index++) {
    const bounds = new THREE.Box3(new THREE.Vector3(-9.4, -.5, -5.3), new THREE.Vector3(7.3, 4.7, 5.3));
    includeBounds(bounds.translate(roomPosition(index)));
  }
  const currentRackBounds = new THREE.Box3().setFromObject(cabinet);
  includeBounds(currentRackBounds);
  const rackDelta = new THREE.Vector3(rackTarget[0] - cabinet.position.x, rackTarget[1] - cabinet.position.y, rackTarget[2] - cabinet.position.z);
  includeBounds(currentRackBounds.clone().translate(rackDelta));

  const adjustment = cameraDepthAdjustment(nearestViewZ, farthestViewZ, camera.near, camera.far);
  const oldFar = camera.far;
  if (adjustment.pullBack > 0) {
    const backward = camera.getWorldDirection(new THREE.Vector3()).negate();
    camera.position.addScaledVector(backward, adjustment.pullBack);
    controls.update();
  }
  camera.far = adjustment.far;
  if (adjustment.pullBack > 0 || camera.far !== oldFar) camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}
function applyCollectionLayout({ animate = true } = {}) {
  const order = [...rooms.keys()];
  const targets = compactTargets(order, new Set(collectionState.ids()), slot => roomPosition(slot).toArray());
  let visibleCount = 0;
  for (const id of order) {
    const record = rooms.get(id), target = targets.get(id), current = poseOf(record);
    const collected = target.collected;
    const position = collected ? [current.position[0], COLLECTION_SINK, current.position[2]] : target.position;
    const goal = { position, scale: collected ? COLLECTION_SCALE : 1 };
    record.collected = collected;
    record.layoutTarget ||= null;
    if (!collected) { record.hiddenSettled = false; record.office.room.visible = true; visibleCount++; }
    if (samePoseTarget(record.layoutTarget, goal)) continue;
    record.layoutTarget = goal;
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPose(record, goal); record.transition = null; record.hiddenSettled = collected;
      record.office.room.visible = !collected;
    } else {
      // Retarget from the current rendered transform, never from a stale tween origin.
      record.transition = makePoseTween(current, goal, performance.now(), COLLECTION_MOTION_MS);
    }
  }
  const rackTarget = cabinetTargetFor(visibleCount);
  moveCabinet(rackTarget, animate);
  ensureLayoutDepth(order.length, rackTarget);
  updateRoomVisibility(); updateCollectionFallback(); renderCollectionPanel();
}
function advanceCollectionLayout(now) {
  for (const record of rooms.values()) {
    if (!record.transition) continue;
    const sample = samplePoseTween(record.transition, now); setPose(record, sample.pose);
    if (sample.done) {
      record.transition = null; record.hiddenSettled = collectionState.has(record.project.id);
      record.office.room.visible = !record.hiddenSettled && record.inView;
    }
  }
  if (cabinetTween) {
    const sample = samplePoseTween(cabinetTween, now); cabinet.position.fromArray(sample.pose.position);
    if (sample.done) cabinetTween = null;
  }
}
function collectionStorageKey() { return `shipboss.observer.collections.v1:${collectionScope}`; }
async function readCollectionPreferences() {
  if (desktop) {
    const result = await desktop.getCollectedRooms(collectionScope);
    if (!result?.ok || !Array.isArray(result.ids)) throw new Error('invalid desktop collection preference response');
    return result.ids;
  }
  const raw = localStorage.getItem(collectionStorageKey());
  if (raw === null) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('invalid browser collection preference');
  return parsed;
}
function persistCollectionPreferences() {
  const ids = collectionState.ids();
  collectionSaveQueue = collectionSaveQueue.catch(() => {}).then(async () => {
    if (desktop) {
      const result = await desktop.setCollectedRooms(collectionScope, ids);
      if (!result?.ok) throw new Error('desktop preference write failed');
    } else localStorage.setItem(collectionStorageKey(), JSON.stringify(ids));
  });
  return collectionSaveQueue.catch(() => { toast('收纳偏好保存失败；当前仅本次运行有效'); return false; });
}
function updateCollectionFallback() {
  const button = $('#collection-fallback'), count = collectionState.ids().length;
  button.hidden = false;
  button.textContent = count ? `机柜 · ${count}` : '收纳柜';
  button.setAttribute('aria-label', count ? `打开收纳柜，${count} 间房间已收纳` : '打开收纳柜，当前列表为空');
}
function orderedCollectedIds() {
  const discovered = [...rooms.keys()].filter(id => collectionState.has(id));
  const known = new Set(discovered);
  return [...discovered, ...collectionState.ids().filter(id => !known.has(id))];
}
function renderCollectionPanel() {
  const panel = $('#collection-panel');
  if (panel.hidden) return;
  const ids = orderedCollectedIds();
  const signature = JSON.stringify(ids.map(id => [id, rooms.get(id)?.project.name || id]));
  if (signature === collectionPanelSignature) return;
  collectionPanelSignature = signature;
  const list = $('#collection-list'), empty = $('#collection-empty'); list.replaceChildren();
  const known = ids.filter(id => rooms.has(id));
  empty.hidden = known.length !== 0;
  empty.textContent = ids.length ? '收纳项目当前未出现在地图中；可清除本机收纳偏好，之后再次发现时正常显示。' : '这里还没有收纳的房间。';
  $('#collection-restore-all').disabled = ids.length === 0;
  for (const id of known) {
    const project = rooms.get(id).project;
    const item = document.createElement('div'); item.setAttribute('role', 'listitem');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'collection-row';
    button.dataset.projectId = id; button.textContent = `${project.name} · 恢复房间`;
    button.setAttribute('aria-label', `恢复 ${project.name} 房间`);
    button.addEventListener('click', () => changeCollection(id, false), { signal: controller.signal });
    item.appendChild(button); list.appendChild(item);
  }
}
function openCollectionPanel(trigger = null) {
  closeRoomMenu(); closeSheet(); collectionPanelTrigger = trigger;
  collectionPanelSignature = ''; $('#collection-panel').hidden = false; renderCollectionPanel();
  $('#collection-close').focus();
}
function closeCollectionPanel(returnFocus = false) {
  if ($('#collection-panel').hidden) return;
  $('#collection-panel').hidden = true; collectionPanelSignature = '';
  const trigger = collectionPanelTrigger; collectionPanelTrigger = null;
  if (returnFocus && trigger?.isConnected) trigger.focus();
}
function openRoomMenu(projectId, clientX, clientY) {
  const record = rooms.get(projectId);
  if (!record || collectionState.has(projectId)) return;
  closeCollectionPanel(false); closeSheet(); roomMenuProjectId = projectId;
  $('#room-context-title').textContent = record.project.name;
  const root = $('#observer').getBoundingClientRect(), menu = $('#room-context-menu');
  menu.hidden = false;
  const x = Math.max(6, Math.min(clientX - root.left, root.width - menu.offsetWidth - 6));
  const y = Math.max(6, Math.min(clientY - root.top, root.height - menu.offsetHeight - 6));
  menu.style.left = `${x}px`; menu.style.top = `${y}px`; $('#collect-room').focus();
}
function closeRoomMenu() { $('#room-context-menu').hidden = true; roomMenuProjectId = null; }
async function changeCollection(projectId, collected) {
  if (!rooms.has(projectId)) return;
  if (!collectionState.set(projectId, collected)) { toast('收纳列表已满或项目标识无效'); return; }
  if (collected) closeRoomMenu();
  applyCollectionLayout({ animate: true });
  renderCollectionPanel(); updateCollectionFallback();
  await persistCollectionPreferences();
}
listen($('#collect-room'), 'click', () => { if (roomMenuProjectId) void changeCollection(roomMenuProjectId, true); });
listen($('#collection-close'), 'click', () => closeCollectionPanel(true));
listen($('#collection-fallback'), 'click', event => openCollectionPanel(event.currentTarget));
listen($('#collection-restore-all'), 'click', async () => {
  collectionState.restoreAll(); applyCollectionLayout({ animate: true }); closeCollectionPanel(false);
  await persistCollectionPreferences();
});
listen(document, 'pointerdown', event => {
  if (!$('#room-context-menu').hidden && !event.target.closest('#room-context-menu')) closeRoomMenu();
  if (!$('#collection-panel').hidden && !event.target.closest('#collection-panel') && !event.target.closest('#collection-fallback')) closeCollectionPanel(false);
});
async function initializeCollectionPreferences() {
  try {
    const ids = await readCollectionPreferences(), normalized = normalizeCollectedIds(ids);
    if (normalized.length !== ids.length || normalized.some((id, index) => id !== ids[index])) throw new Error('malformed collection preference');
    collectionState.restoreAll();
    for (const id of normalized) if (!collectionState.set(id, true)) throw new Error('collection preference exceeds its bound');
  } catch (error) {
    collectionState.restoreAll(); toast('无法读取收纳偏好，已安全显示全部房间');
  }
  collectionReady = true; syncProjects(true); resize(); applyTimeOfDay(); ready = true;
  lastRenderAt = performance.now();
}
function updateObservationLabel() {
  if (!ready) return;
  const tag = $('.demo-tag');
  const status = bridgeMode ? model.getStatus().status : 'demo';
  const text = observationLabel({ count: model.getProjects().length, bridge: bridgeMode, status,
    hour: timeState.hour, phase: timeState.label, preview: previewCursor >= 0 });
  const displayText = observerBridge?.preview ? `体验版/未上线 · ${text}` : text;
  if (tag.textContent !== displayText) tag.textContent = displayText;
  tag.dataset.night = String(timeState.label === '夜晚');
  tag.setAttribute('aria-label', text);
}
function syncProjects(immediate = false) {
  if (!collectionReady) return;
  for (const project of model.snapshot()) {
    const record = registerProject(project);
    record.project = project;
    const signature = JSON.stringify([project.epoch, project.status, project.latestEvent?.id, project.needsAttention, project.awaitingUser, project.recording, project.recordingUncertain, project.skillsUsed, project.isIdle, project.activity,
      project.actors.map(actor => [actor.active, actor.uncertain, actor.motion, actor.taskId, actor.papers]),
      project.tasks.map(task => [task.id, task.status, task.attempt, task.motion, task.verification]), project.reports.length]);
    if (record.signature !== signature || immediate) {
      // Visual entry is independent of first observation or snapshot refresh.
      record.office.setProject(project); record.signature = signature;
    }
  }
  if (collectionLayoutDirty) { collectionLayoutDirty = false; applyCollectionLayout({ animate: ready }); }
  renderCollectionPanel(); updateCollectionFallback();
  updateObservationLabel();
  const waiting = [...rooms.values()].filter(record => record.project.needsAttention).length;
  const collected = collectionState.ids().length, collectionSummary = collected ? `${collected} 间房间已收纳。` : '';
  let text;
  if (bridgeMode) {
    const stale = bridgeInfo.status === 'stale' ? ' 状态文件暂不可用，显示上一份有效状态。' : '';
    text = rooms.size ? `${rooms.size} 个项目。${waiting ? `${waiting} 个项目等待回答。` : ''}${collectionSummary}${stale}` : (bridgeInfo.error ? '等待状态：状态文件暂不可用' : '等待 SKILL 状态');
  } else text = `${rooms.size} 个项目。${waiting ? `${waiting} 个项目等待回答。` : ''}${collectionSummary}`;
  if (text !== lastStatus) { $('#map-status').textContent = text; lastStatus = text; }
  if (sheet) {
    const project = rooms.get(sheet.projectId)?.project;
    const key = `${project?.latestEvent?.id}/${project?.epoch}/${project?.activity}/${project?.tasks.map(task => `${task.id}:${task.status}:${task.attempt}:${task.motion}`).join('|')}/${project?.reports.length}`;
    if (key !== lastSheetSignature) { renderSheet(); lastSheetSignature = key; }
  }
}
function modelTick(immediate = false) {
  const now = performance.now(), delta = Math.max(0, (now - modelAt) / 1000); modelAt = now; model.tick(delta);
  // A fourth simulated repository arrives to demonstrate append-only room placement.
  if (!bridgeMode && !newProjectAdded && model.getProject('shipboss')?.elapsed >= 70 && typeof model.addProject === 'function') {
    model.addProject({ id: 'docs-demo', name: '文档站', source: 'Codex · 演示', skillsUsed: 6 }); newProjectAdded = true;
  }
  if (isVisible()) syncProjects(immediate);
  else updateActivityBubbles();
}
function projectSummary(project) {
  if (project.needsAttention) return 'PM 正等你回答';
  const pieces = [];
  if (project.engineerCount) pieces.push(`${project.engineerCount} 位工程师工作中`);
  if (project.verifierCount) pieces.push('独立验收中');
  if (project.queuedReports) pieces.push('PM 查看回报');
  return pieces.join(' · ') || (project.status === 'dispatching' ? 'PM 排任务' : '工作室待命');
}

function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function appendQuestion(parent, project) {
  const question = project.pendingQuestion;
  const card = element('article', undefined, 'question-card'); card.appendChild(element('span', '?', 'question-symbol'));
  card.appendChild(element('h2', question?.question || '这项工作需要你的决定。'));
  card.appendChild(element('p', '请在原 Session 中回答。这里仅展示等待状态。'));
  card.appendChild(element('p', demoMode ? '当前问题为演示数据。尚未连接真实会话。' : '问题来自真实状态文件；观察窗不会回传回答。'));
  parent.appendChild(card);
}
function appendReport(parent, report) {
  const card = element('article', undefined, 'report-card'); card.appendChild(element('h2', clean(report.title)));
  const verdictClass = report.verdict.startsWith('FAIL') ? 'fail' : report.verdict.startsWith('NEEDS') ? 'attention' : '';
  card.appendChild(element('span', report.verdict, `verdict ${verdictClass}`));
  for (const [label, value] of [['改变', report.changed], ['检查', report.verified], ['风险', report.risk], ['需要你', report.needsYou]]) {
    const row = element('p'); row.appendChild(element('b', `${label}　`)); row.appendChild(document.createTextNode(value || '—')); card.appendChild(row);
  }
  parent.appendChild(card);
}
function renderSheet() {
  if (!sheet) return;
  const project = rooms.get(sheet.projectId)?.project;
  if (!project) { closeSheet(); return; }
  const { type, actorId } = sheet, parent = $('#sheet-content'); parent.replaceChildren();
  const actor = project.actors.find(item => item.id === actorId);
  $('#sheet-eyebrow').textContent = `${project.name} · ${clean(project.source)}`;
  $('#sheet-title').textContent = type === 'question' ? '等待你的回答' : type === 'scribe' ? '记录员' : actor?.name || (type === 'reports' ? '项目回报' : project.name);
  if (type === 'scribe') {
    parent.appendChild(element('p', demoMode
      ? (project.recording ? '演示：他正在记录这次对话里的新观点和需要追加的改动。' : '演示：记录已经结束，内容会留给项目后续迭代。')
      : (project.recording ? '记录员正在记录。' : '记录员当前空闲。'), 'sheet-note'));
    parent.appendChild(element('p', demoMode ? '当前记录为演示数据；尚未连接 JEV 或真实会话。' : '记录内容不会写入观察窗；这里只显示记录状态。', 'sheet-note'));
    return;
  }
  if (project.needsAttention && (type === 'question' || type === 'project' || actorId === 'pm')) appendQuestion(parent, project);
  if (actor) parent.appendChild(element('p', clean(actor.activity), 'sheet-note'));
  if (type === 'reports' || actor?.role === 'pm' && project.queuedReports) {
    if (!project.reports.length) parent.appendChild(element('p', '暂时没有回报。', 'empty-state'));
    [...project.reports].reverse().forEach(report => appendReport(parent, report));
  } else if (type !== 'question') {
    const tasks = actor ? project.tasks.filter(task => task.id === actor.taskId || actor.role === 'pm') : project.tasks;
    if (!tasks.length) parent.appendChild(element('p', '还没有待处理任务。', 'empty-state'));
    tasks.forEach(task => {
      const row = element('div', undefined, 'task-row'), content = element('div'); content.appendChild(element('strong', clean(task.title)));
      const assignee = project.actors.find(item => item.id === task.assignee);
      content.appendChild(element('small', `${assignee?.name || '待安排'} · ${task.id}`)); row.appendChild(content);
      row.appendChild(element('span', project.needsAttention ? '等待回答' : statusNames[task.status] || task.status, `task-state ${task.status}`)); parent.appendChild(row);
    });
    if (type === 'project' && project.reports.length) [...project.reports].reverse().forEach(report => appendReport(parent, report));
  }
}
function openSheet(projectId, type = 'project', actorId) { closeRoomMenu(); closeCollectionPanel(false); sheet = { projectId, type, actorId }; renderSheet(); $('#info-sheet').hidden = false; $('#floor-tooltip').hidden = true; }
function closeSheet() { sheet = null; $('#info-sheet').hidden = true; lastSheetSignature = ''; rooms.forEach(record => record.office.select(null)); }
listen($('#close-sheet'), 'click', closeSheet);
listen(window, 'keydown', event => {
  if (event.key === 'Escape') { closeRoomMenu(); closeCollectionPanel(true); closeSheet(); }
  if (event.key.toLowerCase() === 't' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    const next = previewCursor + 1;
    previewCursor = next >= PREVIEW_TIMES.length ? -1 : next;
    applyTimeOfDay(); lastTimeUpdate = performance.now();
    if (previewCursor < 0) toast('恢复本地时间');
    else { const preview = PREVIEW_TIMES[previewCursor]; toast(`预览 ${preview.label} ${String(Math.floor(preview.hour)).padStart(2, '0')}:${String(Math.round((preview.hour % 1) * 60)).padStart(2, '0')} · 再按 T 切换`); }
  }
});
listen($('#reset-camera'), 'click', () => { closeSheet(); controls.reset(); ensureLayoutDepth(rooms.size, cabinetTargetFor(collectionState.visibleIds([...rooms.keys()]).length)); resize(); });

const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
function pick(clientX, clientY) {
  // Pointer input may follow an in-flight layout/pan. Raycast against the exact
  // currently rendered transforms, not a stale matrixWorld from a prior frame.
  camera.updateMatrixWorld(true); scene.updateMatrixWorld(true);
  const rect = renderer.domElement.getBoundingClientRect(); pointer.set((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const roots = [...rooms.values()].filter(record => record.inView && !collectionState.has(record.project.id)).map(record => record.office.room);
  const hits = raycaster.intersectObjects([...roots, cabinet], true);
  for (const hit of hits) {
    const object = hit.object;
    const explicit = ['station', 'delivery', 'project-floor', 'question'].includes(object.userData.kind);
    // Ignore hidden thought/question meshes. Invisible station proxies remain pickable.
    let ancestor = object, visible = true, projectId = null, kind = null, index;
    while (ancestor && ancestor !== scene) {
      if (!ancestor.visible) visible = false;
      if (ancestor.userData.projectId) projectId = ancestor.userData.projectId;
      if (ancestor.userData.kind && !kind) { kind = ancestor.userData.kind; index = ancestor.userData.index; }
      ancestor = ancestor.parent;
    }
    if (!visible && !(explicit && ['station', 'delivery'].includes(object.userData.kind))) continue;
    if (object.material?.visible === false && !explicit) continue;
    if (kind === 'collection-cabinet') return { kind, point: hit.point };
    if (!projectId) continue;
    // A visible prop blocks floor hover; only unobstructed ground gets repository text.
    return { projectId, kind: kind || 'prop', index, point: hit.point };
  }
  return null;
}
function renderTooltip() {
  const tooltip = $('#floor-tooltip');
  if (!pointerPosition || pointerDown || sheet) { tooltip.hidden = true; return; }
  hovered = pick(pointerPosition.x, pointerPosition.y);
  if (!hovered || hovered.kind === 'prop') { tooltip.hidden = true; renderer.domElement.style.cursor = 'grab'; return; }
  const kind = hovered.kind;
  const project = kind === 'collection-cabinet' ? null : rooms.get(hovered.projectId)?.project;
  if (kind !== 'collection-cabinet' && !project) { tooltip.hidden = true; return; }
  const actor = kind === 'station' ? project.actors[hovered.index] : null;
  const title = kind === 'collection-cabinet' ? '项目收纳柜'
    : kind === 'question' ? `${project.name} · 等待回答`
    : kind === 'scribe' ? `${project.name} · 记录员`
      : actor ? `${project.name} · ${actor.name}`
        : kind === 'delivery' ? `${project.name} · 回报` : project.name;
  const subtitle = kind === 'collection-cabinet' ? (collectionState.ids().length ? `${collectionState.ids().length} 间房间已收纳 · 点击查看` : '点击查看或恢复房间')
    : kind === 'scribe' ? (project.recording ? '正在记录对话中的改动要点' : '记录完成，准备归档')
    : actor ? clean(actor.activity)
      : kind === 'question' ? '点击查看问题'
        : kind === 'delivery' ? (demoMode ? `${project.reports.length} 份演示回报` : `${project.reports.length} 份回报`)
          : kind === 'skills' ? (demoMode ? `其他 Skill × ${project.skillsUsed}（演示）` : `今天用过的其它技能 × ${project.skillsUsed}${project.skillsUsed > 256 ? "（仅显示256箱，渲染保护）" : ""}`)
            : projectSummary(project);
  const key = `${title}/${subtitle}`;
  if (key !== tooltipKey) { tooltip.querySelector('strong').textContent = title; tooltip.querySelector('span').textContent = subtitle; tooltipKey = key; }
  tooltip.dataset.kind = kind; tooltip.hidden = false; renderer.domElement.style.cursor = kind === 'project-floor' ? 'grab' : 'pointer';
  const rect = $('#observer').getBoundingClientRect();
  const x = pointerPosition.x - rect.left + 13, y = pointerPosition.y - rect.top + 15;
  tooltip.style.left = `${Math.max(5, Math.min(x, rect.width - tooltip.offsetWidth - 7))}px`;
  tooltip.style.top = `${Math.max(5, Math.min(y, rect.height - tooltip.offsetHeight - 7))}px`;
}
listen(renderer.domElement, 'pointerdown', event => { if (event.button !== 0) return; pointerDown = { x: event.clientX, y: event.clientY }; $('#floor-tooltip').hidden = true; });
listen(renderer.domElement, 'pointerup', event => {
  if (!pointerDown) return;
  const moved = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y); pointerDown = null;
  if (moved > 6) return;
  const hit = pick(event.clientX, event.clientY); if (!hit) { closeSheet(); return; }
  if (hit.kind === 'collection-cabinet') { openCollectionPanel(event.target); return; }
  if (hit.kind === 'station') { rooms.get(hit.projectId).office.select(hit.index); openSheet(hit.projectId, 'actor', slots[hit.index]); }
  else if (hit.kind === 'delivery') openSheet(hit.projectId, 'reports');
  else if (hit.kind === 'question') openSheet(hit.projectId, 'question', 'pm');
  else if (hit.kind === 'skills') openSheet(hit.projectId, 'project');
  else if (hit.kind === 'scribe') openSheet(hit.projectId, 'scribe');
  else if (hit.kind === 'project-floor') openSheet(hit.projectId, 'project');
});
listen(renderer.domElement, 'pointermove', event => { pointerPosition = { x: event.clientX, y: event.clientY }; if (!event.buttons) renderTooltip(); });
listen(renderer.domElement, 'pointerleave', () => { pointerPosition = null; hovered = null; $('#floor-tooltip').hidden = true; });
listen(window, 'pointerup', () => { pointerDown = null; });
listen(renderer.domElement, 'contextmenu', event => {
  event.preventDefault();
  const hit = pick(event.clientX, event.clientY);
  if (hit?.projectId) openRoomMenu(hit.projectId, event.clientX, event.clientY);
  else closeRoomMenu();
});
controls.addEventListener('change', () => { if (ready) updateRoomVisibility(); });

const frustum = new THREE.Frustum(), matrix = new THREE.Matrix4();
function updateRoomVisibility() {
  camera.updateMatrixWorld(); matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); frustum.setFromProjectionMatrix(matrix);
  rooms.forEach(record => {
    updateRecordBounds(record);
    record.inView = frustum.intersectsBox(record.bounds);
    record.office.room.visible = record.inView && !record.hiddenSettled;
  });
}
function applyTimeOfDay() {
  const preview = previewCursor >= 0 ? PREVIEW_TIMES[previewCursor] : null;
  const date = preview ? new Date(2026, 0, 1, Math.floor(preview.hour), Math.round((preview.hour % 1) * 60)) : new Date();
  const next = sampleTimeOfDay(date);
  next.source = preview ? 'preview' : 'local';
  scene.background.copy(next.sky);
  hemi.color.copy(next.hemiSky); hemi.groundColor.copy(next.hemiGround); hemi.intensity = next.hemiIntensity;
  sun.color.copy(next.sun); sun.intensity = next.sunIntensity;
  const position = sunPosition(next.hour); sun.position.set(position.x, position.y, position.z);
  fill.intensity = next.fillIntensity;
  renderer.toneMappingExposure = next.exposure;
  rooms.forEach(record => record.office.setEnvironment(next));
  timeState = next;
  updateObservationLabel();
}
function applyQuality(tier, initial = false) {
  if (!qualityProfile || qualityTier === tier && !initial) return;
  qualityTier = tier; qualityProfile = QUALITY_PROFILES[tier];
  renderer.setPixelRatio(Math.min(devicePixelRatio, qualityProfile.pixelRatio));
  if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  sun.shadow.mapSize.set(qualityProfile.shadows, qualityProfile.shadows);
  if (ao) ao.enabled = qualityProfile.ssao;
  if (bloom) bloom.enabled = qualityProfile.bloom;
  if (!initial) resize();
}
function resize() {
  const width = $('#viewport').clientWidth, height = $('#viewport').clientHeight; if (!width || !height) return;
  // One world unit always covers the same CSS pixels. Expansion reveals more map.
  camera.left = -width / (2 * PIXELS_PER_UNIT); camera.right = width / (2 * PIXELS_PER_UNIT);
  camera.top = height / (2 * PIXELS_PER_UNIT); camera.bottom = -height / (2 * PIXELS_PER_UNIT);
  camera.updateProjectionMatrix(); renderer.setSize(width, height); composer.setSize(width, height); updateRoomVisibility(); visualAt = performance.now();
}
const resizeObserver = new ResizeObserver(resize); resizeObserver.observe($('#viewport'));
void initializeCollectionPreferences();
const clock = setInterval(() => modelTick(), 200);
listen(document, 'visibilitychange', () => { modelTick(); if (isVisible()) visualAt = performance.now(); });
function frame(now) {
  if (disposed) return; requestAnimationFrame(frame); if (!isVisible()) return;
  const active = [...rooms.values()].some(record => record.inView && !collectionState.has(record.project.id) && record.project.actors.some(actor => actor.active));
  const fps = active ? qualityProfile.target : qualityProfile.idle;
  const sinceRender = lastRenderAt ? now - lastRenderAt : 1000 / qualityProfile.target;
  if (sinceRender < 1000 / fps - 1) return;
  const delta = Math.min(.12, Math.max(0, (now - visualAt) / 1000)); visualAt = now; lastRenderAt = now; visualTime += delta;
  if (now - lastTimeUpdate > 15000) { applyTimeOfDay(); lastTimeUpdate = now; }
  controls.update(); advanceCollectionLayout(now); rooms.forEach(record => record.office.update(visualTime)); updateRoomVisibility();
  if (ao) { ao.ssaoMaterial.uniforms.cameraProjectionMatrix.value.copy(camera.projectionMatrix); ao.ssaoMaterial.uniforms.cameraInverseProjectionMatrix.value.copy(camera.projectionMatrixInverse); }
  composer.render(); renderFrames++; renderTooltip(); updateActivityBubbles();
  // Judge performance only while the team is working. Idle frames are
  // intentionally slower, so they must not trigger a quality downgrade.
  if (active) {
    if (sinceRender > (1000 / qualityProfile.target) * 1.5) slowFrames++;
    else slowFrames = Math.max(0, slowFrames - 1);
    if (slowFrames > 90 && qualityTier !== 'low') { qualityInfo.downgrades += 1; applyQuality(qualityTier === 'high' ? 'balanced' : 'low'); slowFrames = 0; }
  } else slowFrames = 0;
  if (ready && !$('#widget-loading').hidden) $('#widget-loading').hidden = true;
}
requestAnimationFrame(frame);
listen(renderer.domElement, 'webglcontextlost', event => { event.preventDefault(); $('#scene-error').hidden = false; $('#scene-error').textContent = '图形上下文已暂停。请重新打开观察窗。'; });
listen(window, 'beforeunload', () => { disposed = true; clearInterval(clock); clearTimeout(toast.timer); resizeObserver.disconnect(); controller.abort(); controls.dispose(); composer.dispose(); renderer.dispose(); });
const projectWorldPoint = world => {
  const position = world.clone().project(camera); const rect = renderer.domElement.getBoundingClientRect();
  return { x: rect.left + (position.x * .5 + .5) * rect.width, y: rect.top + (-position.y * .5 + .5) * rect.height };
};
const projectPoint = (projectId, x, y, z) => {
  const record = rooms.get(projectId); const position = new THREE.Vector3(x, y, z); if (record) position.add(record.office.room.position);
  return projectWorldPoint(position);
};
function updateActivityBubbles() {
  activityOverlay.begin();
  const viewport = renderer.domElement.getBoundingClientRect();
  for (const record of rooms.values()) {
    const officeState = record.office.snapshot();
    const characters = [...officeState.characters, officeState.scribe];
    const activityActors = [...record.project.actors, record.project.recordingActor || {id:'recording',role:'recording',active:false,uncertain:record.project.recordingUncertain}];
    activityActors.forEach((actor, index) => {
      const anchor = record.office.getHeadAnchor(index);
      const world = anchor ? record.office.room.localToWorld(anchor) : new THREE.Vector3();
      const point = projectWorldPoint(world);
      const inside = point.x >= viewport.left + 12 && point.x <= viewport.right - 12 && point.y >= viewport.top + 42 && point.y <= viewport.bottom - 15;
      activityOverlay.update(`${record.project.id}/${actor.id}`, actor, {
        visible: isVisible() && record.inView && !record.collected && !record.hiddenSettled && inside && Boolean(characters[index]?.visible),
        waiting: index === 0 && (record.project.awaitingUser || record.project.needsAttention),
      }, point);
    });
  }
  activityOverlay.end(viewport);
}
// Diagnostics are read-only. In bridge mode every project comes from the state file.
window.__SHIPBOSS_WIDGET__ = {
  getState: () => ({
    projectId: sheet?.projectId || 'shipboss', project: model.getProject(sheet?.projectId || 'shipboss'), projects: model.getProjects(),
    observer: { mode: bridgeMode ? 'bridge' : 'demo', status: bridgeInfo.status, error: bridgeInfo.error?.type || null, demo: demoMode },
    rooms: [...rooms.entries()].map(([id, record]) => {
      const scene = record.office.snapshot();
      return { id, index: record.index, name: record.project.name, recordingActivity: record.project.recordingActor, actorActivities: record.project.actors.map(a => ({ id: a.id, motion: a.motion, toolActivity: a.toolActivity })), position: record.office.room.position.toArray(), scale: record.office.room.scale.x, inView: record.inView, collected: collectionState.has(id), visible: record.office.room.visible, dimmed: scene.dimmed, lightScale: scene.lightScale, scene };
    }),
    activityBubbles: activityOverlay.snapshot(),
    scene: rooms.get('shipboss')?.office.snapshot(), native: nativeState,
    camera: { position: camera.position.toArray(), target: controls.target.toArray(), quaternion: camera.quaternion.toArray(), zoom: camera.zoom, pixelsPerUnit: PIXELS_PER_UNIT * camera.zoom, rotationEnabled: controls.enableRotate, panEnabled: controls.enablePan, viewWidth: camera.right - camera.left, viewHeight: camera.top - camera.bottom,
      projectionMatrix: camera.projectionMatrix.toArray(),
      viewport: renderer.getSize(new THREE.Vector2()).toArray() },
    time: { hour: +timeState.hour.toFixed(2), label: timeState.label, source: timeState.source, exposure: +renderer.toneMappingExposure.toFixed(2) },
    quality: { tier: qualityTier, name: qualityProfile.name, gpu: qualityInfo.gpu, source: qualityInfo.source, downgrades: qualityInfo.downgrades, ssao: Boolean(ao?.enabled), bloom: Boolean(bloom?.enabled), pixelRatio: renderer.getPixelRatio(), shadows: sun.shadow.mapSize.x },
    rendering: { visible: isVisible(), frames: renderFrames, animationTime: visualTime, framesWhileHidden: 0, sceneCount: 1, roomCount: rooms.size, renderedRoomCount: [...rooms.values()].filter(record => record.inView && !record.hiddenSettled).length },
    collection: { scope: collectionScope, ready: collectionReady, ids: collectionState.ids(), panelOpen: !$('#collection-panel').hidden, roomMenuOpen: !$('#room-context-menu').hidden },
    cabinet: { position: cabinet.position.toArray(), point: projectWorldPoint(cabinet.position.clone().add(new THREE.Vector3(0, 2.25, 0))), visible: cabinet.visible },
    width: $('#observer').clientWidth, height: $('#observer').clientHeight, tooltip: { visible: !$('#floor-tooltip').hidden, projectId: hovered?.projectId, kind: hovered?.kind },
  }),
  project: (x, y, z) => projectPoint('shipboss', x, y, z), projectPoint,
  roomPoint: (projectId, x = -5, y = .05, z = 3) => projectPoint(projectId, x, y, z),
  hitTest: (x, y) => { const hit = pick(x, y); return hit ? { kind: hit.kind, projectId: hit.projectId || null } : null; },
  actorHeadPoint: (projectId, index) => {
    const anchor = rooms.get(projectId)?.office.getHeadAnchor(index);
    return anchor ? projectPoint(projectId, anchor.x, anchor.y + .7, anchor.z) : null;
  },
};
