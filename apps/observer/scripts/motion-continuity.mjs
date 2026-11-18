// Test oracle only: normal route speed from parallel-shifts.js, not a route copy.
import assert from 'node:assert/strict';
const MAX_SPEED = 5.6;
// Existing small position allowance; do not enlarge it for late observations.
const POSITION_SLACK = .2;
export function assertMotionContinuity(previous, current, before, after, label = 'actor') {
 assert.ok(Number.isFinite(previous.animationTime) && Number.isFinite(current.animationTime) && current.animationTime >= previous.animationTime, label+' monotonic animation time');
 assert.ok(Number.isInteger(previous.frame) && Number.isInteger(current.frame) && current.frame >= previous.frame, label+' monotonic renderer frames');
 const dt = current.animationTime-previous.animationTime;
 const distance = Math.hypot(after.x-before.x, after.z-before.z);
 const limit = MAX_SPEED*dt+POSITION_SLACK;
 // Invisible actors can reset outside. Reappearance must start from outside,
 // not from the old hidden position; allow only travel since the last sample.
 if (!before.visible && !after.visible) return;
 const movement = !before.visible ? Math.hypot(after.x+8.55, after.z-1.25) : distance;
 if (previous.frame === current.frame || dt === 0) assert.ok(distance <= .003, label+' no movement without a rendered frame/time advance');
 assert.ok(movement <= limit, `${label} no teleport: ${movement.toFixed(3)} > ${limit.toFixed(3)} in ${(dt*1000).toFixed(1)}ms (frames ${previous.frame}->${current.frame}, observed ${previous.observedAt}->${current.observedAt}ms)`);
}
