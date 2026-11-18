'use strict';
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const COLLAPSED_SIZE = Object.freeze({ width: 440, height: 360 });
const EXPANDED_SIZE = Object.freeze({ width: 720, height: 600 });
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function isInside(directory, candidate) {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function rendererTarget(root, developmentURL) {
  if (developmentURL) {
    let url;
    try { url = new URL(developmentURL); }
    catch { throw new Error('SHIPBOSS_DEV_URL must be a localhost URL ending in /widget.html.'); }
    if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username || url.password || url.pathname !== '/widget.html') {
      throw new Error('SHIPBOSS_DEV_URL only permits http://localhost, 127.0.0.1, or [::1] with /widget.html.');
    }
    if ([...url.searchParams.keys()].some(key => key !== 'desktop') || url.hash) {
      throw new Error('SHIPBOSS_DEV_URL only permits the optional desktop query parameter and no fragment.');
    }
    url.searchParams.set('desktop', '1');
    return { url: url.href, origin: url.origin, development: true, file: null, dist: path.join(root, 'dist') };
  }
  const file = path.join(root, 'dist', 'widget.html');
  const url = pathToFileURL(file);
  url.searchParams.set('desktop', '1');
  return { url: url.href, origin: null, development: false, file, dist: path.join(root, 'dist') };
}
function isAllowedNavigation(value, target) {
  try {
    const actual = new URL(value), expected = new URL(target.url);
    actual.hash = ''; expected.hash = '';
    return actual.href === expected.href;
  } catch { return false; }
}
function isAllowedResource(value, target) {
  try {
    const url = new URL(value);
    if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
    if (target.development) {
      return ((url.protocol === 'http:' && url.origin === target.origin) ||
        (url.protocol === 'ws:' && url.host === new URL(target.origin).host)) && !url.username && !url.password;
    }
    return url.protocol === 'file:' && !url.host && isInside(target.dist, fileURLToPath(url));
  } catch { return false; }
}
function contentSecurityPolicy(target) {
  const connections = target.development ? `'self' ${target.origin.replace(/^http:/, 'ws:')}` : "'none'";
  return ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    "font-src 'self' data:", `connect-src ${connections}`, "media-src 'self' blob:", "worker-src 'self' blob:",
    "object-src 'none'", "base-uri 'none'", "frame-src 'none'", "form-action 'none'"].join('; ');
}
function validBounds(value) {
  return value && typeof value === 'object' && ['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(value[key])) &&
    Math.abs(value.x) <= 100000 && Math.abs(value.y) <= 100000 && value.width > 0 && value.height > 0 && value.width <= 20000 && value.height <= 20000;
}
function fitBounds(saved, expanded, workArea, anchor) {
  const size = expanded ? EXPANDED_SIZE : COLLAPSED_SIZE;
  const width = Math.min(workArea.width, expanded && validBounds(saved) ? Math.max(COLLAPSED_SIZE.width, saved.width) : size.width);
  const height = Math.min(workArea.height, expanded && validBounds(saved) ? Math.max(COLLAPSED_SIZE.height, saved.height) : size.height);
  const x = anchor ? anchor.x + anchor.width - width : validBounds(saved) ? saved.x : workArea.x + workArea.width - width - 16;
  const y = anchor ? anchor.y + anchor.height - height : validBounds(saved) ? saved.y : workArea.y + workArea.height - height - 16;
  return {
    x: Math.round(Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width))),
    y: Math.round(Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height))),
    width: Math.round(width), height: Math.round(height),
  };
}
// Two scopes of 256 IDs at 160 UTF-16 units each fit below this even at
// the worst accepted UTF-8 width; writes and reads use the same byte bound.
const PREFERENCES_FILE_LIMIT = 256 * 1024;
const MAX_COLLECTED_ROOMS = 256;
function validCollectedId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 160
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function sanitizeCollectedRooms(value) {
  if (!Array.isArray(value)) return [];
  const ids = [], seen = new Set();
  for (const id of value) {
    if (!validCollectedId(id) || seen.has(id)) continue;
    seen.add(id); ids.push(id);
    if (ids.length >= MAX_COLLECTED_ROOMS) break;
  }
  return ids;
}
function sanitizeCollections(value) {
  const source = value && typeof value === 'object' ? value : {};
  return { demo: sanitizeCollectedRooms(source.demo), bridge: sanitizeCollectedRooms(source.bridge) };
}
function sanitizePreferences(value) {
  const source = value && typeof value === 'object' ? value : {};
  const copy = bounds => validBounds(bounds) ? Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, bounds[key]])) : null;
  return { pinned: source.pinned === true, expanded: source.expanded === true, bounds: copy(source.bounds), expandedBounds: copy(source.expandedBounds), collections: sanitizeCollections(source.collections) };
}
module.exports = { COLLAPSED_SIZE, EXPANDED_SIZE, isInside, rendererTarget, isAllowedNavigation, isAllowedResource, contentSecurityPolicy, validBounds, fitBounds, sanitizeCollectedRooms, sanitizeCollections, sanitizePreferences, MAX_COLLECTED_ROOMS, PREFERENCES_FILE_LIMIT };
