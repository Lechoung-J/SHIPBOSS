import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CollectionState, normalizeCollectedIds } from '../src/collection-state.js';
import { compactTargets, gridSlotPosition, cabinetTargetFor, cameraDepthAdjustment, COLLECTION_SCALE, COLLECTION_SINK, makePoseTween, samplePoseTween, samePoseTarget } from '../src/collection-layout.js';
import { createServerCabinet } from '../src/server-cabinet.js';

let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`✓ ${name}`); };
const place = slot => [slot % 2 ? 17.3 : 0, 0, Math.floor(slot / 2) * 13.3];

check('bounded local preference IDs reject malformed entries and preserve insertion order', () => {
  assert.deepEqual(normalizeCollectedIds(['a', 'a', '', ' bad ', 'x\n', 4, 'β']), ['a', 'β']);
  assert.equal(normalizeCollectedIds(Array.from({ length: 300 }, (_, i) => `p${i}`)).length, 256);
  const state = new CollectionState(['b', 'a', 'b']);
  assert.deepEqual(state.ids(), ['b', 'a']);
  assert.deepEqual(state.visibleIds(['a', 'b', 'c']), ['c']);
  const full = new CollectionState(Array.from({ length: 256 }, (_, i) => `full-${i}`));
  assert.equal(full.set('overflow', true), false); assert.equal(full.has('full-0'), true);
});

check('filtered discovery order compacts two-column targets and restoration inserts in place', () => {
  const order = Array.from({ length: 12 }, (_, i) => `p${i}`), collected = new Set(['p0', 'p1', 'p5', 'p8', 'p9', 'p10']);
  const targets = compactTargets(order, collected, place);
  assert.equal(targets.get('p0').collected, true);
  assert.equal(targets.get('p0').scale, COLLECTION_SCALE);
  const visible = order.filter(id => !collected.has(id));
  visible.forEach((id, slot) => assert.deepEqual(targets.get(id).position, place(slot)));
  collected.delete('p0');
  const restored = compactTargets(order, collected, place);
  assert.deepEqual(restored.get('p0').position, place(0));
  assert.deepEqual(restored.get('p2').position, place(1));
  assert.deepEqual(restored.get('p3').position, place(2));
});

check('sink, reflow and fast reverse retarget from the last rendered pose without a jump', () => {
  const from = { position: [17.3, 0, 13.3], scale: 1 };
  const stowTarget = { position: [17.3, COLLECTION_SINK, 13.3], scale: COLLECTION_SCALE };
  const stow = makePoseTween(from, stowTarget, 1000, 480);
  const mid = samplePoseTween(stow, 1240);
  assert.equal(mid.done, false); assert.ok(mid.pose.position[1] < 0); assert.ok(mid.pose.scale < 1);
  const reverseTarget = { position: place(0), scale: 1 };
  const reverse = makePoseTween(mid.pose, reverseTarget, 1240, 480);
  assert.deepEqual(samplePoseTween(reverse, 1240).pose, mid.pose, 'retarget begins at the currently displayed pose');
  assert.ok(samplePoseTween(reverse, 1320).pose.position[0] !== mid.pose.position[0] || samplePoseTween(reverse, 1320).pose.position[2] !== mid.pose.position[2]);
  assert.deepEqual(samplePoseTween(reverse, 1720).pose, reverseTarget);
  assert.equal(samplePoseTween(reverse, 1720).done, true);
  assert.ok(samePoseTarget(reverseTarget, { ...reverseTarget, position: [...reverseTarget.position] }));
});

check('room can settle hidden after its sink and scale transition', () => {
  const tween = makePoseTween({ position: [0, 0, 0], scale: 1 }, { position: [0, COLLECTION_SINK, 0], scale: COLLECTION_SCALE }, 0, 480);
  const final = samplePoseTween(tween, 480);
  assert.equal(final.done, true); assert.deepEqual(final.pose.position, [0, COLLECTION_SINK, 0]); assert.equal(final.pose.scale, COLLECTION_SCALE);
});

check('cabinet occupies exactly the next grid cell for odd, even and empty maps', () => {
  const examples = new Map([[0,[0,0,0]],[1,[17.3,0,0]],[5,[17.3,0,26.6]],[7,[17.3,0,39.900000000000006]],[8,[0,0,53.2]],[10,[0,0,66.5]],[12,[0,0,79.80000000000001]]]);
  for(const [count,expected] of examples) {
    assert.deepEqual(cabinetTargetFor(count),expected);
    assert.deepEqual(cabinetTargetFor(count),gridSlotPosition(count));
    const cabinet=createServerCabinet(THREE);cabinet.position.fromArray(cabinetTargetFor(count));cabinet.updateMatrixWorld(true);
    const rackBounds=new THREE.Box3().setFromObject(cabinet);
    for(let i=0;i<count;i++) {
      const position=gridSlotPosition(i),offset=new THREE.Vector3(...position);
      const roomBounds=new THREE.Box3(new THREE.Vector3(-9.4,-.5,-5.3),new THREE.Vector3(7.3,4.7,5.3)).translate(offset);
      assert.equal(rackBounds.intersectsBox(roomBounds),false,`${count} rooms: final cabinet cell must not overlap room ${i}`);
    }
    // Use a scene with every room's conservative envelope to prove the intended
    // cabinet point remains a real mesh hit rather than a hidden proxy.
    const camera=new THREE.OrthographicCamera(-12,12,8,-8,.1,220);
    camera.position.set(32,32.8,32);camera.lookAt(0,.8,0);camera.updateProjectionMatrix();camera.updateMatrixWorld(true);
    const worldBounds=Array.from({length:count},(_,i)=>new THREE.Box3(new THREE.Vector3(-9.4,-.5,-5.3),new THREE.Vector3(7.3,4.7,5.3)).translate(new THREE.Vector3(...gridSlotPosition(i))));
    worldBounds.push(rackBounds);
    const projected=worldBounds.map(b=>b.clone().applyMatrix4(camera.matrixWorldInverse));
    const correction=cameraDepthAdjustment(Math.max(...projected.map(b=>b.max.z)),Math.min(...projected.map(b=>b.min.z)),camera.near,camera.far);
    camera.position.addScaledVector(camera.getWorldDirection(new THREE.Vector3()).negate(),correction.pullBack);
    camera.far=correction.far;camera.lookAt(0,.8,0);camera.updateProjectionMatrix();camera.updateMatrixWorld(true);
    const point=cabinet.position.clone().add(new THREE.Vector3(0,2.25,0)).project(camera);
    assert.ok(point.z>=-1&&point.z<=1);
    const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2(point.x,point.y),camera);
    assert.ok(ray.intersectObject(cabinet,true).some(h=>h.object.userData.kind==='collection-cabinet'));
  }
});

check('10 known rooms reserve one additional cell after each compact visible roster',()=>{
  const ids=Array.from({length:10},(_,i)=>`room-${i}`);
  for(const count of [10,8,7,5,1,0,7,10]) {
    const hidden=new Set(ids.slice(count)),targets=compactTargets(ids,hidden,gridSlotPosition);
    const visible=ids.filter(id=>!hidden.has(id));
    visible.forEach((id,index)=>assert.deepEqual(targets.get(id).position,gridSlotPosition(index)));
    assert.deepEqual(cabinetTargetFor(visible.length),gridSlotPosition(visible.length));
    assert.equal(visible.length+1,count+1,'cabinet uses one cell without inventing a project');
  }
  const from={position:cabinetTargetFor(7),scale:1},to={position:cabinetTargetFor(5),scale:1};
  const tween=makePoseTween(from,to,0,480),middle=samplePoseTween(tween,240);
  assert.equal(middle.done,false);assert.notDeepEqual(middle.pose.position,from.position);assert.notDeepEqual(middle.pose.position,to.position);
  assert.deepEqual(samplePoseTween(tween,480).pose.position,to.position,'rack reuses the existing smooth layout motion');
});

console.log(`Collection state/layout OK: ${checks} checks`);
