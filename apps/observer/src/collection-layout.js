export const COLLECTION_MOTION_MS = 480;
export const COLLECTION_SINK = -0.82;
export const COLLECTION_SCALE = 0.76;

// Offices and the cabinet share the same two-column cell geometry. Offices
// occupy slots 0..visibleCount-1; the independent cabinet occupies the next cell.
export function gridSlotPosition(index) {
  const slot = Math.max(0, Math.trunc(Number(index) || 0));
  return [(slot % 2) * 17.3, 0, Math.floor(slot / 2) * 13.3];
}

export function cabinetTargetFor(visibleCount) {
  return gridSlotPosition(visibleCount);
}

export function cameraDepthAdjustment(nearestViewZ, farthestViewZ, near, currentFar, safety = 1.25, farMargin = 8) {
  const pullBack = Math.max(0, nearestViewZ + near + safety);
  return { pullBack, far: Math.max(currentFar, -(farthestViewZ - pullBack) + farMargin) };
}

export function compactTargets(discoveryOrder, collectedIds, positionForSlot) {
  const hidden = collectedIds instanceof Set ? collectedIds : new Set(collectedIds || []);
  const targets = new Map();
  let slot = 0;
  for (const id of discoveryOrder) {
    if (hidden.has(id)) targets.set(id, { collected: true, position: null, scale: COLLECTION_SCALE });
    else targets.set(id, { collected: false, position: positionForSlot(slot++), scale: 1 });
  }
  return targets;
}

export function makePoseTween(from, to, start, duration = COLLECTION_MOTION_MS) {
  return {
    from: { position: [...from.position], scale: from.scale },
    to: { position: [...to.position], scale: to.scale },
    start, duration: Math.max(1, duration),
  };
}

export function samplePoseTween(tween, now) {
  const raw = Math.max(0, Math.min(1, (now - tween.start) / tween.duration));
  const t = raw * raw * (3 - 2 * raw);
  return {
    done: raw >= 1,
    pose: {
      position: tween.from.position.map((value, index) => value + (tween.to.position[index] - value) * t),
      scale: tween.from.scale + (tween.to.scale - tween.from.scale) * t,
    },
  };
}

export function samePoseTarget(left, right, epsilon = 1e-4) {
  return Boolean(left && right && Math.abs(left.scale - right.scale) < epsilon
    && left.position.every((value, index) => Math.abs(value - right.position[index]) < epsilon));
}
