'use strict';

// Sandboxed preloads can only require Electron's restricted bridge APIs.
const { contextBridge, ipcRenderer } = require('electron');
const subscribers = new Set();
const IPC_TIMEOUT_MS = 5000;
const MAX_PENDING_CALLS = 32;
let pendingCalls = 0;

function freezeState(value) {
  if (!value || typeof value.pinned !== 'boolean' || typeof value.expanded !== 'boolean' || typeof value.visible !== 'boolean') {
    throw new Error('Invalid desktop state response.');
  }
  return Object.freeze({ pinned: value.pinned, expanded: value.expanded, visible: value.visible });
}
function invoke(channel, args = []) {
  if (pendingCalls >= MAX_PENDING_CALLS) return Promise.reject(new Error('Too many pending desktop control requests.'));
  pendingCalls += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); pendingCalls -= 1; callback(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('Desktop control timed out.')), IPC_TIMEOUT_MS);
    ipcRenderer.invoke(channel, ...args).then(value => finish(resolve, value), error => finish(reject, error));
  });
}
async function booleanControl(channel, value) {
  if (typeof value !== 'boolean') throw new TypeError('Desktop controls require a boolean.');
  return freezeState(await invoke(channel, [value]));
}
function collectionScope(value) {
  if (value !== 'demo' && value !== 'bridge') throw new TypeError('Collection scope must be demo or bridge.');
  return value;
}
function collectionIds(value) {
  if (!Array.isArray(value) || value.length > 256) throw new TypeError('Invalid collected room list.');
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== 'string' || id.length < 1 || id.length > 160 || id.trim() !== id || /[\u0000-\u001f\u007f]/.test(id) || seen.has(id)) {
      throw new TypeError('Invalid collected room ID.');
    }
    seen.add(id);
  }
  return [...value];
}
function freezeCollectionResult(value) {
  if (!value || typeof value.ok !== 'boolean') throw new Error('Invalid collection preference response.');
  return Object.freeze({ ok: value.ok, ids: Object.freeze(collectionIds(value.ids)) });
}
ipcRenderer.on('shipboss:state', (_event, value) => {
  let snapshot;
  try { snapshot = freezeState(value); } catch { return; }
  for (const callback of [...subscribers]) {
    try { callback(snapshot); } catch { console.error('A desktop state subscriber failed.'); }
  }
});
const desktop = Object.freeze({
  getState: async () => freezeState(await invoke('shipboss:get-state')),
  getCollectedRooms: async scope => freezeCollectionResult(await invoke('shipboss:get-collected-rooms', [collectionScope(scope)])),
  setCollectedRooms: async (scope, ids) => freezeCollectionResult(await invoke('shipboss:set-collected-rooms', [collectionScope(scope), collectionIds(ids)])),
  setPinned: value => booleanControl('shipboss:set-pinned', value),
  setExpanded: value => booleanControl('shipboss:set-expanded', value),
  hide: async () => freezeState(await invoke('shipboss:hide')),
  quit: async () => { await invoke('shipboss:quit'); },
  onState: callback => {
    if (typeof callback !== 'function') throw new TypeError('onState requires a callback.');
    if (subscribers.size >= 32) throw new Error('Too many desktop state subscribers.');
    // Each subscription has its own identity, including repeated callbacks.
    const subscriber = value => callback(value);
    subscribers.add(subscriber);
    return () => { subscribers.delete(subscriber); };
  },
});
contextBridge.exposeInMainWorld('shipbossDesktop', desktop);

// Read-only observer state bridge. There is deliberately no send/write method.
const observerSubscribers = new Set();
const modeArgument = process.argv.find(value => value.startsWith('--shipboss-observer-mode='));
const observerMode = modeArgument === '--shipboss-observer-mode=bridge' ? 'bridge' : 'demo';
function freezeObserverState(value) {
  if (!value || (value.mode !== 'bridge' && value.mode !== 'demo') || !Array.isArray(value.projects)) {
    throw new Error('Invalid observer state response.');
  }
  return Object.freeze({ ...value, projects: Object.freeze(value.projects.map(project => Object.freeze(project))) });
}
ipcRenderer.on('shipboss:observer-state', (_event, value) => {
  let snapshot;
  try { snapshot = freezeObserverState(value); } catch { return; }
  for (const callback of [...observerSubscribers]) {
    try { callback(snapshot); } catch { console.error('An observer state subscriber failed.'); }
  }
});
const observer = Object.freeze({
  mode: observerMode,
  preview: process.argv.includes('--shipboss-activity-preview'),
  activityTesting: process.argv.includes('--shipboss-activity-testing'),
  getState: async () => freezeObserverState(await invoke('shipboss:get-observer-state')),
  onState: callback => {
    if (typeof callback !== 'function') throw new TypeError('onState requires a callback.');
    if (observerSubscribers.size >= 32) throw new Error('Too many observer state subscribers.');
    const subscriber = value => callback(value);
    observerSubscribers.add(subscriber);
    return () => { observerSubscribers.delete(subscriber); };
  },
});
contextBridge.exposeInMainWorld('shipbossObserver', observer);
