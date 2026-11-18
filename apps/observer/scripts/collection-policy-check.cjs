'use strict';
const assert = require('node:assert/strict');
const { sanitizeCollectedRooms, sanitizePreferences, MAX_COLLECTED_ROOMS } = require('../desktop/policy.cjs');
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`✓ ${name}`); };
check('demo and bridge collection preferences are local, separate and backward compatible', () => {
  assert.deepEqual(sanitizePreferences({ pinned: true }).collections, { demo: [], bridge: [] });
  assert.deepEqual(sanitizePreferences({ collections: { demo: ['demo-a'], bridge: ['bridge-a'] } }).collections,
    { demo: ['demo-a'], bridge: ['bridge-a'] });
});
check('preference sanitizer bounds, deduplicates and filters invalid project IDs', () => {
  assert.deepEqual(sanitizeCollectedRooms(['a', 'a', '', ' x ', 'b\n', 4, 'b']), ['a', 'b']);
  assert.equal(sanitizeCollectedRooms(Array.from({ length: 300 }, (_, i) => `room-${i}`)).length, MAX_COLLECTED_ROOMS);
  assert.deepEqual(sanitizePreferences({ collections: null }).collections, { demo: [], bridge: [] });
});
check('never uses a renderer supplied filesystem path as a stored collection key', () => {
  const id = '../../private/file';
  assert.deepEqual(sanitizeCollectedRooms([id]), [id]);
  assert.ok(!Object.keys(sanitizePreferences({ collections: { bridge: [id] } })).includes('path'));
});
console.log(`Collection preference policy OK: ${checks} checks`);
