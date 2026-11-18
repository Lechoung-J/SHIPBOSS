import * as THREE from 'three';

const OUTSIDE = new THREE.Vector3(-8.55, .04, 1.25);
const SPEED = 5.6, PACE_SPEED = 1.05, EPSILON = 1e-7;
const SLOTS = ['pm', 'eng-a', 'eng-b', 'verifier'];
const DEFAULT_REST = { 'eng-a': new THREE.Vector3(-5.43, .04, 3.23), 'eng-b': new THREE.Vector3(-3.97, .04, 3.23) };
const ease = value => value * value * (3 - 2 * value);
const point = (x, z) => new THREE.Vector3(x, .04, z);

// A small walkable graph keeps every interruption on the current real edge.
// Lounge access approaches the seat from its front, around the sofa's left side.
function navigation(desk, rest, pacing, standing = false) {
  const nodes = new Map(), edges = new Map();
  const add = (id, position) => { nodes.set(id, position.clone()); edges.set(id, []); };
  const join = (a, b, door = false) => {
    const edge = { a, b, door, length: nodes.get(a).distanceTo(nodes.get(b)) };
    edges.get(a).push(edge); edges.get(b).push(edge);
  };
  const seat = standing ? point(3.35, 3.25) : point(desk.x - .1, desk.z + 1.12), side = seat.clone().add(new THREE.Vector3(standing ? 0 : .8, 0, 0));
  add('outside', OUTSIDE); add('gate', point(-5.7, 1.7));
  add('seat', seat); add('side', side); add('desk-lane', point(side.x, 1.7));
  join('outside', 'gate', true); join('seat', 'side'); join('side', 'desk-lane');
  const corridor = ['gate', 'desk-lane'];
  if (rest) {
    add('rest-lane', point(-6.3, 1.7)); add('rest-side', point(-6.3, rest.z + .47));
    add('rest-front', point(rest.x, rest.z + .47)); add('rest', rest);
    join('rest-lane', 'rest-side'); join('rest-side', 'rest-front'); join('rest-front', 'rest');
    corridor.push('rest-lane');
  }
  if (pacing) {
    for (const [suffix, x] of [['min', pacing.minX], ['max', pacing.maxX]]) {
      add(`pace-${suffix}`, point(x, pacing.z)); add(`pace-lane-${suffix}`, point(x, 1.7));
      join(`pace-${suffix}`, `pace-lane-${suffix}`); corridor.push(`pace-lane-${suffix}`);
    }
    join('pace-min', 'pace-max');
  }
  corridor.sort((a, b) => nodes.get(a).x - nodes.get(b).x);
  for (let index = 1; index < corridor.length; index++) join(corridor[index - 1], corridor[index]);
  return { nodes, edges };
}

function shortestPaths(graph, target) {
  const distances = new Map([...graph.nodes.keys()].map(id => [id, Infinity])), next = new Map();
  const remaining = new Set(graph.nodes.keys()); distances.set(target, 0);
  while (remaining.size) {
    const current = [...remaining].reduce((best, id) => best === null || distances.get(id) < distances.get(best) ? id : best, null);
    remaining.delete(current);
    for (const edge of graph.edges.get(current)) {
      const neighbor = edge.a === current ? edge.b : edge.a, distance = distances.get(current) + edge.length;
      if (remaining.has(neighbor) && distance < distances.get(neighbor)) {
        distances.set(neighbor, distance); next.set(neighbor, { node: current, edge });
      }
    }
  }
  return { distances, next };
}

// Each actor owns its route; the common aisle/door is single-file for all five.
export function createParallelShifts(desks, door, reducedMotion, options = {}) {
  const pacing = options.pacingCorridor === false ? null : { minX: -2, maxX: 1.2, z: 2.2, ...options.pacingCorridor };
  let doorOwner = null, passageOwner = null;
  const actors = desks.map((desk, index) => {
    const id = desk.id || SLOTS[index], rest = options.restPositions?.[id] || DEFAULT_REST[id];
    const graph = navigation(desk, rest, id === 'eng-b' ? pacing : null, id === 'recording');
    desk.character.root.visible = false; desk.character.root.position.copy(OUTSIDE);
    return {
      id, index, graph, character: desk.character, mode: 'absent', desired: false, motion: 'idle', activity: '',
      destination: 'outside', node: 'outside', edge: null, route: [], segment: 0, distance: 0,
      paused: false, seated: 0, phase: 0, angle: 0, walking: false, taskId: null,
    };
  });
  const destination = actor => !actor.desired ? 'outside'
    : actor.motion === 'testing' && actor.id === 'eng-b' && pacing ? 'pace'
      : actor.motion === 'testing' && actor.graph.nodes.has('rest') ? 'rest' : 'seat';
  const goalNode = actor => actor.destination === 'pace' ? 'pace-max' : actor.destination;
  const travelMode = actor => actor.destination === 'outside' ? 'exiting'
    : actor.destination !== 'seat' ? 'to-rest' : actor.node === 'outside' || actor.edge?.door ? 'entering' : 'returning';

  function arrive(actor) {
    actor.walking = false; actor.edge = null; actor.route = [];
    if (passageOwner === actor.id) passageOwner = null;
    // Opening reserves the door before actor.edge exists. A cancelled route
    // can arrive outside without move() ever releasing that reservation.
    if (doorOwner === actor.id) doorOwner = null;
    if (actor.node === 'outside') { actor.mode = 'absent'; actor.character.root.visible = false; actor.seated = 0; }
    else if (actor.destination === 'pace') actor.mode = 'pacing';
    else if (actor.id === 'recording') { actor.mode = 'reading'; actor.angle = -Math.PI / 2; actor.character.root.rotation.y = actor.angle; }
    else { actor.mode = 'sitting'; actor.phase = 0; }
  }
  function plan(actor, target, mode = travelMode(actor)) {
    const position = actor.character.root.position, { distances, next } = shortestPaths(actor.graph, target);
    const endpoints = actor.edge ? [actor.edge.a, actor.edge.b] : [actor.node];
    let nearest = endpoints[0];
    for (const node of endpoints) {
      if (position.distanceTo(actor.graph.nodes.get(node)) + distances.get(node)
        < position.distanceTo(actor.graph.nodes.get(nearest)) + distances.get(nearest)) nearest = node;
    }
    const route = [];
    if (position.distanceTo(actor.graph.nodes.get(nearest)) > EPSILON) {
      route.push({ from: position.clone(), to: actor.graph.nodes.get(nearest), node: nearest, edge: actor.edge });
    }
    let current = nearest;
    while (current !== target) {
      const step = next.get(current);
      route.push({ from: actor.graph.nodes.get(current), to: actor.graph.nodes.get(step.node), node: step.node, edge: step.edge });
      current = step.node;
    }
    actor.route = route; actor.segment = 0; actor.distance = 0; actor.mode = mode; actor.walking = false;
    if (!route.length) { actor.node = target; arrive(actor); }
  }
  function pose(actor, time, forceStill = false) {
    const working = actor.desired && actor.mode === 'working' && actor.motion === 'working';
    const still = actor.paused || forceStill || (!actor.walking && !working);
    actor.character.pose(actor.seated, time + actor.index * .25, actor.walking && !actor.paused, working && !actor.paused, still);
    if (actor.id === 'recording') actor.character.head.rotation.x = actor.mode === 'reading' ? .34 + (actor.paused || forceStill || reducedMotion ? 0 : Math.sin(time * 1.4) * .025) : 0;
  }
  function restore(actor) {
    actor.node = goalNode(actor); actor.edge = null; actor.route = []; actor.walking = false;
    actor.mode = !actor.desired ? 'absent' : actor.destination === 'rest' ? 'resting' : actor.destination === 'pace' ? 'pacing' : actor.id === 'recording' ? 'reading' : 'working';
    actor.seated = Number(actor.desired && actor.destination !== 'pace' && actor.id !== 'recording'); actor.phase = 0;
    actor.angle = actor.destination === 'rest' ? Math.PI : 0;
    actor.character.root.position.copy(actor.graph.nodes.get(actor.node));
    actor.character.root.rotation.y = actor.angle; actor.character.root.visible = actor.desired;
    pose(actor, 0, true);
  }
  function sync(states, immediate = false) {
    const keyed = new Map(states.filter(state => state?.id).map(state => [state.id, state]));
    actors.forEach((actor, index) => {
      const state = keyed.size ? keyed.get(actor.id) : states[index];
      actor.paused = state?.uncertain === true;
      if (actor.paused) { pose(actor, 0, true); return; }
      actor.desired = Boolean(state?.active); actor.taskId = state?.taskId ?? null;
      actor.motion = state?.motion || (actor.desired ? 'working' : 'idle'); actor.activity = state?.activity || '';
      const prior = actor.destination; actor.destination = destination(actor);
      if (reducedMotion) restore(actor);
      else if (prior !== actor.destination && actor.mode !== 'absent') {
        if (actor.seated > 0) { actor.mode = 'standing'; actor.walking = false; }
        else plan(actor, goalNode(actor));
      }
      // Repeated snapshots only update intent; do not reset gait/typing time.
      if (reducedMotion) pose(actor, 0, true);
    });
    if (reducedMotion) { doorOwner = null; door.hinge.rotation.y = 0; }
  }
  function move(actor, delta) {
    let budget = (actor.mode === 'pacing' ? PACE_SPEED : SPEED) * delta;
    const origin = actor.character.root.position.clone();
    while (actor.segment < actor.route.length) {
      const segment = actor.route[actor.segment];
      if (segment.edge.door) {
        if (doorOwner !== null && doorOwner !== actor.id) break;
        doorOwner = actor.id;
        // Open before crossing the physical door, not after walking through it.
        if (door.hinge.rotation.y < 1.2) break;
      } else if (doorOwner === actor.id) doorOwner = null;
      actor.edge = segment.edge; actor.node = null;
      const length = segment.from.distanceTo(segment.to), amount = Math.min(budget, length - actor.distance);
      actor.distance += amount; budget -= amount;
      actor.character.root.position.lerpVectors(segment.from, segment.to, length ? actor.distance / length : 1);
      if (length > EPSILON) {
        const target = Math.atan2(segment.from.x - segment.to.x, segment.from.z - segment.to.z);
        actor.angle += Math.atan2(Math.sin(target - actor.angle), Math.cos(target - actor.angle)) * Math.min(1, delta * 20);
        actor.character.root.rotation.y = actor.angle;
      }
      if (actor.distance < length - EPSILON) break;
      actor.node = segment.node; actor.edge = null; actor.segment++; actor.distance = 0;
      if (segment.edge.door && doorOwner === actor.id) doorOwner = null;
      if (actor.segment === actor.route.length) { arrive(actor); break; }
      if (budget <= EPSILON) break;
    }
    actor.walking = actor.character.root.position.distanceToSquared(origin) > EPSILON && actor.mode !== 'absent';
  }
  function update(time, delta) {
    if (reducedMotion || !Number.isFinite(delta) || delta <= 0) return;
    actors.forEach(actor => {
      if (actor.paused) { pose(actor, time, true); return; }
      if (actor.mode === 'absent') {
        if (!actor.desired || doorOwner !== null || passageOwner !== null) return;
        actor.character.root.visible = true; plan(actor, goalNode(actor));
      }
      actor.walking = false;
      if (actor.mode === 'pacing' && !actor.route.length) plan(actor, actor.node === 'pace-max' ? 'pace-min' : 'pace-max', 'pacing');
      if (actor.route.length && actor.mode !== 'standing') {
        // The narrow common aisle is single-file, including the scribe.
        // Pacing remains in its separate clear strip and never monopolizes it.
        if (actor.mode === 'pacing' || passageOwner === null || passageOwner === actor.id) {
          if (actor.mode !== 'pacing') passageOwner = actor.id;
          move(actor, delta);
        }
      }
      else if (actor.mode === 'standing') {
        actor.seated = Math.max(0, actor.seated - delta / .3);
        if (actor.seated === 0) plan(actor, goalNode(actor));
      } else if (actor.mode === 'sitting') {
        actor.phase = Math.min(1, actor.phase + delta / .32); actor.seated = ease(actor.phase);
        const target = actor.destination === 'rest' ? Math.PI : 0;
        actor.angle += Math.atan2(Math.sin(target - actor.angle), Math.cos(target - actor.angle)) * Math.min(1, delta * 16);
        actor.character.root.rotation.y = actor.angle;
        if (actor.phase === 1) { actor.mode = actor.destination === 'rest' ? 'resting' : 'working'; actor.angle = target; actor.character.root.rotation.y = target; }
      }
      pose(actor, time);
    });
    const nearDoor = actors.some(actor => actor.mode !== 'absent' && (actor.edge?.door || actor.route[actor.segment]?.edge.door && actor.character.root.position.x < -5.65));
    door.hinge.rotation.y = THREE.MathUtils.damp(door.hinge.rotation.y, nearDoor ? Math.PI * .48 : 0, 16, delta);
  }
  const snapshot = () => actors.map(actor => {
    const position = actor.character.root.position;
    return {
      id: actor.id, index: actor.index, taskId: actor.taskId, mode: actor.paused ? 'uncertain' : actor.mode, motion: actor.paused ? 'idle' : actor.motion,
      activity: actor.paused ? '状态未知：保持上次位置，暂停动作' : actor.activity,
      desired: actor.desired, uncertain: actor.paused, joints: actor.character.snapshot?.(), visible: actor.character.root.visible, seated: +actor.seated.toFixed(3),
      seatState: actor.mode === 'resting' ? 'sofa' : actor.seated === 1 ? 'desk' : actor.seated > 0 ? 'transition' : 'standing',
      x: +position.x.toFixed(3), y: +position.y.toFixed(3), z: +position.z.toFixed(3),
      position: { x: +position.x.toFixed(3), y: +position.y.toFixed(3), z: +position.z.toFixed(3) },
      crossingDoor: actor.edge?.door === true && doorOwner === actor.id,
    };
  });
  return { sync, update, snapshot };
}
