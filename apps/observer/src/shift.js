import * as THREE from 'three';

const OUTSIDE = new THREE.Vector3(-8.55, .04, 1.25);
const INSIDE = new THREE.Vector3(-5.9, .04, 1.25);
const SPEED = 5.6;
const clamp = THREE.MathUtils.clamp;
const ease = t => t * t * (3 - 2 * t);

/** A single doorway, a collision-free corridor and interruptible role shifts. */
export function createShifts(desks, door, reducedMotion) {
  let desired = -1;
  const actors = desks.map((desk, index) => {
    const seat = new THREE.Vector3(desk.x - .1, .04, desk.z + 1.12);
    const side = new THREE.Vector3(seat.x + .8, .04, seat.z);
    const entry = [OUTSIDE.clone(), INSIDE.clone(), new THREE.Vector3(side.x, .04, 1.25), side, seat];
    desk.character.root.visible = false;
    return { index, character: desk.character, entry, mode: 'absent', seated: 0, phase: 0, distance: 0, route: [], lengths: [], length: 0, angle: 0 };
  });
  function setRoute(actor, route, mode) {
    actor.route = route.map(p => p.clone()); actor.distance = 0; actor.lengths = [0];
    for (let i = 1; i < route.length; i++) actor.lengths.push(actor.lengths[i - 1] + route[i - 1].distanceTo(route[i]));
    actor.length = actor.lengths.at(-1); actor.mode = mode; actor.phase = 0;
  }
  function reverseEntry(actor) {
    const route = [actor.character.root.position.clone()];
    for (let i = actor.route.length - 1; i >= 0; i--) if (actor.lengths[i] < actor.distance - .001) route.push(actor.route[i]);
    if (route.length === 1) route.push(OUTSIDE.clone());
    setRoute(actor, route, 'exiting');
  }
  function beginExit(actor) {
    if (actor.mode === 'entering') reverseEntry(actor);
    else if (actor.mode === 'working' || actor.mode === 'sitting') { actor.mode = 'standing'; actor.phase = 0; }
  }
  function setRole(index) {
    desired = index;
    if (reducedMotion) {
      actors.forEach(a => {
        const active = a.index === desired; a.mode = active ? 'working' : 'absent'; a.seated = active ? 1 : 0;
        a.character.root.visible = active; a.character.root.position.copy(a.entry.at(-1)); a.character.root.rotation.y = 0;
        a.character.pose(a.seated, 0, false, active, true);
      });
      door.hinge.rotation.y = 0;
      return;
    }
    actors.forEach(a => { if (a.index !== desired && a.mode !== 'absent' && a.mode !== 'exiting' && a.mode !== 'standing') beginExit(a); });
  }
  function update(time, delta) {
    if (reducedMotion) return;
    // Always let an outgoing role pass the door before admitting another one.
    if (actors.every(a => a.mode === 'absent') && desired >= 0) {
      const a = actors[desired]; setRoute(a, a.entry, 'entering'); a.character.root.position.copy(OUTSIDE);
      a.angle = -Math.PI / 2; a.character.root.rotation.y = a.angle; a.character.root.visible = true;
    }
    actors.forEach(a => {
      if (a.mode === 'absent') return;
      const root = a.character.root;
      if (a.mode === 'entering' || a.mode === 'exiting') {
        a.seated = 0; a.distance = Math.min(a.length, a.distance + SPEED * delta);
        let segment = 1;
        while (segment < a.lengths.length - 1 && a.distance > a.lengths[segment]) segment++;
        const from = a.route[segment - 1], to = a.route[segment];
        const length = a.lengths[segment] - a.lengths[segment - 1];
        const t = length > 0 ? (a.distance - a.lengths[segment - 1]) / length : 1;
        root.position.lerpVectors(from, to, clamp(t, 0, 1));
        const direction = to.clone().sub(from);
        const wanted = Math.atan2(-direction.x, -direction.z);
        a.angle += Math.atan2(Math.sin(wanted - a.angle), Math.cos(wanted - a.angle)) * Math.min(1, delta * 20);
        root.rotation.y = a.angle;
        if (a.distance >= a.length) {
          if (a.mode === 'exiting') { a.mode = 'absent'; root.visible = false; }
          else { a.mode = 'sitting'; a.phase = 0; }
        }
      } else if (a.mode === 'sitting') {
        a.phase = Math.min(1, a.phase + delta / .32); a.seated = ease(a.phase);
        a.angle += Math.atan2(Math.sin(-a.angle), Math.cos(-a.angle)) * Math.min(1, delta * 11); root.rotation.y = a.angle;
        if (a.phase === 1) { a.mode = 'working'; root.rotation.y = 0; a.angle = 0; }
      } else if (a.mode === 'standing') {
        a.seated = Math.max(0, a.seated - delta / .3);
        if (a.seated === 0) setRoute(a, [...a.entry].reverse(), 'exiting');
      }
      const walking = a.mode === 'entering' || a.mode === 'exiting';
      a.character.pose(a.seated, time, walking, a.mode === 'working', false);
    });
    const nearDoor = actors.some(a => a.mode !== 'absent' && a.character.root.position.x < -5.65 && Math.abs(a.character.root.position.z - 1.25) < .8);
    const target = nearDoor ? Math.PI * .48 : 0;
    door.hinge.rotation.y = THREE.MathUtils.damp(door.hinge.rotation.y, target, 16, delta);
  }
  const settled = () => actors.every(a => a.index === desired ? a.mode === 'working' : a.mode === 'absent');
  const snapshot = () => actors.map(a => ({ role: a.index, mode: a.mode, visible: a.character.root.visible, seated: +a.seated.toFixed(3), x: +a.character.root.position.x.toFixed(3), z: +a.character.root.position.z.toFixed(3) }));
  return { setRole, update, settled, snapshot };
}
