'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, session, dialog } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  COLLAPSED_SIZE, isInside, rendererTarget, isAllowedNavigation, isAllowedResource,
  contentSecurityPolicy, validBounds, fitBounds, sanitizeCollectedRooms, sanitizePreferences, PREFERENCES_FILE_LIMIT,
} = require('./policy.cjs');
const { OBSERVER_STATE_LIMIT, normalizeObserverState } = require('./observer-state.cjs');

const activityPreview = process.env.SHIPBOSS_ACTIVITY_PREVIEW === '1' || fs.existsSync(path.join(__dirname, 'activity-preview.json'));
const APP_NAME = activityPreview ? 'SHIPBOSS Observer 体验版/未上线' : 'SHIPBOSS Observer';
const ROOT = path.resolve(__dirname, '..');
// A packaged bundle stays in demo/artifacts; its sibling runtime folder is writable.
// Moving the prototype into /Applications is intentionally unsupported.
const ARTIFACTS = app.isPackaged
  ? path.dirname(path.dirname(path.dirname(path.dirname(app.getPath('exe')))))
  : path.join(ROOT, 'artifacts');
const testRun = process.env.SHIPBOSS_TEST_MODE === '1' && /^[a-zA-Z0-9_-]{1,80}$/.test(process.env.SHIPBOSS_TEST_RUN_ID || '')
  ? process.env.SHIPBOSS_TEST_RUN_ID : null;
const previewRun = activityPreview && /^[a-zA-Z0-9_-]{1,80}$/.test(process.env.SHIPBOSS_ACTIVITY_RUN_ID || '') ? process.env.SHIPBOSS_ACTIVITY_RUN_ID : 'activity-preview';
const RUNTIME = path.join(ARTIFACTS, 'runtime', testRun || (activityPreview ? previewRun : 'shipboss-observer'));
// The bridge path comes only from the launcher. Renderers cannot supply a path.
const OBSERVER_POLL_MS = 500;
const observerConfig = (() => {
  if (process.argv.includes('--demo')) return { mode: 'demo', path: null, error: null };
  const raw = process.env.SHIPBOSS_OBSERVER_STATE;
  if (typeof raw !== 'string' || !raw.trim()) return { mode: 'demo', path: null, error: null };
  const candidate = raw.trim();
  if (!path.isAbsolute(candidate)) return { mode: 'bridge', path: null, error: 'path-not-absolute' };
  return { mode: 'bridge', path: path.resolve(candidate), error: null };
})();
const observerState = { payload: null, status: observerConfig.mode === 'demo' ? 'demo' : 'waiting', error: null, lastHash: null, lastErrorKey: '', lastValidAt: null, timer: null };
let mainWindow = null, tray = null, target = null, preferences = null;
let isQuitting = false, saveTimer = null, loadingError = null, showingError = false, fatalReported = false, preferencesWarning = false;
const PREFS_FILE = path.join(RUNTIME, 'preferences.json');
const LOG_FILE = path.join(RUNTIME, 'logs', 'desktop.log');
const PRESENTATION_SEEN = path.join(RUNTIME, 'presentation-seen.json');
let helperTimer = null;
let presentationSeen = [];
const helperDirectory = (() => {
  const raw = process.env.SHIPBOSS_OBSERVER_SERVICE_DIR;
  if (observerConfig.mode !== 'bridge' || !observerConfig.path || !raw || !path.isAbsolute(raw)) return null;
  const directory = path.resolve(raw), stateDirectory = path.dirname(observerConfig.path);
  if (directory !== stateDirectory && directory !== path.join(stateDirectory, 'observer-service')) return null;
  for (let current = directory; ; current = path.dirname(current)) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
    if (current === path.dirname(current)) break;
  }
  return fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory() ? directory : null;
})();
function atomicMetadata(destination, value) {
  const staging = `${destination}.${process.pid}.tmp`;
  for (const file of [destination, staging]) {
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Metadata symlink rejected');
  }
  fs.writeFileSync(staging, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(staging, destination);
}
function helperHeartbeat() {
  if (!helperDirectory || !mainWindow || mainWindow.isDestroyed()) return;
  const generated = Date.parse(observerState.payload?.generatedAt || '');
  const fresh = observerState.status === 'live' && Number.isFinite(generated) && Math.abs(Date.now() - generated) < 30000;
  try {
    atomicMetadata(path.join(helperDirectory, 'helper-status.json'), {
      version: 1, kind: 'shipboss-observer-helper', updatedAt: Date.now() / 1000,
      appPid: process.pid, statePath: observerConfig.path, status: fresh ? 'ready' : 'waiting',
      capabilities: ['activation-queue-v1'], seenRequestIds: presentationSeen.slice(-256),
    });
  } catch (error) { log(`Helper metadata unavailable: ${error.message}`); }
}
function consumePresentation(presentation) {
  const now = Date.now() / 1000;
  let changed = false;
  for (const request of presentation?.requests || []) {
    if (request.at > now + 5 || now - request.at > 120 || presentationSeen.includes(request.id)) continue;
    showWindow({ focus: false });
    presentationSeen.push(request.id); presentationSeen = presentationSeen.slice(-256); changed = true;
  }
  if (changed) {
    try { atomicMetadata(PRESENTATION_SEEN, presentationSeen); } catch (error) { log(`Presentation dedupe save failed: ${error.message}`); }
    helperHeartbeat();
  }
}

function ensureDirectory(directory) {
  // Reject symlink escapes before any application-owned write.
  if (!isInside(ARTIFACTS, directory)) throw new Error('Runtime path must remain under artifacts.');
  const parts = path.relative(ARTIFACTS, directory).split(path.sep).filter(Boolean);
  let current = ARTIFACTS;
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Runtime directory cannot be a symlink: ${current}`);
    fs.mkdirSync(current, { recursive: true });
  }
}
function log(message) {
  const line = `${new Date().toISOString()} ${String(message).slice(0, 8000)}\n`;
  console.error(line.trimEnd());
  try {
    if (fs.existsSync(LOG_FILE) && fs.lstatSync(LOG_FILE).isSymbolicLink()) return;
    // Bound the prototype's diagnostic file; it contains no renderer telemetry.
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) fs.writeFileSync(LOG_FILE, line);
    else fs.appendFileSync(LOG_FILE, line);
  } catch { /* Console remains available if the workspace becomes read-only. */ }
}
function observerEnvelope() {
  return {
    mode: observerConfig.mode,
    status: observerState.status,
    version: 1,
    source: observerState.payload?.source ?? null,
    generatedAt: observerState.payload?.generatedAt ?? null,
    projects: observerState.payload?.projects ?? [],
    error: observerState.error ? { type: observerState.error.type, at: observerState.error.at } : null,
    receivedAt: observerState.lastValidAt,
  };
}
function publishObserverState() {
  if (mainWindow && !mainWindow.isDestroyed() && target && isAllowedNavigation(mainWindow.webContents.getURL(), target)) {
    mainWindow.webContents.send('shipboss:observer-state', observerEnvelope());
  }
}
function observerFailure(type) {
  const hadSnapshot = Boolean(observerState.payload);
  observerState.status = hadSnapshot ? 'stale' : 'waiting';
  observerState.error = { type, at: new Date().toISOString() };
  const key = `${type}/${hadSnapshot}`;
  // Log state transitions, not every poll, and never log file contents.
  if (observerState.lastErrorKey !== key) {
    observerState.lastErrorKey = key;
    log(`Observer state ${hadSnapshot ? 'kept previous snapshot' : 'unavailable'}: ${type}${observerConfig.path ? ` (${observerConfig.path})` : ''}`);
    publishObserverState();
  }
}
function pollObserverState() {
  if (observerConfig.mode !== 'bridge' || observerState.timer === null) return;
  if (!observerConfig.path) { observerFailure(observerConfig.error || 'path-not-absolute'); return; }
  let raw;
  try {
    const stat = fs.lstatSync(observerConfig.path, { throwIfNoEntry: false });
    if (!stat) { observerFailure('missing'); return; }
    if (stat.isSymbolicLink() || !stat.isFile()) { observerFailure('not-regular-file'); return; }
    if (stat.size > OBSERVER_STATE_LIMIT) { observerFailure('too-large'); return; }
    raw = fs.readFileSync(observerConfig.path, 'utf8');
    if (Buffer.byteLength(raw) > OBSERVER_STATE_LIMIT) { observerFailure('too-large'); return; }
  } catch (error) { observerFailure(error.code || 'read-failed'); return; }
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  if (hash === observerState.lastHash) {
    // Content is unchanged. If the file disappeared and came back byte-identical,
    // flip back to live without re-parsing or re-sending the same snapshot.
    if (observerState.status !== 'live') {
      observerState.status = 'live'; observerState.error = null; observerState.lastErrorKey = '';
      observerState.lastValidAt = new Date().toISOString(); publishObserverState();
    }
    return;
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { observerFailure('invalid-json'); return; }
  const result = normalizeObserverState(parsed);
  if (!result.ok) { observerFailure(result.error || 'invalid-schema'); return; }
  // Deduplicate only validated snapshots, never a failed parse.
  observerState.lastHash = hash;
  observerState.payload = result.payload;
  observerState.status = 'live';
  observerState.error = null;
  observerState.lastErrorKey = '';
  observerState.lastValidAt = new Date().toISOString();
  log(`Observer state loaded: ${result.payload.projects.length} project(s) from ${observerConfig.path}`);
  consumePresentation(result.payload.presentation);
  helperHeartbeat();
  publishObserverState();
}
function startObserverPolling() {
  if (observerConfig.mode !== 'bridge' || observerState.timer !== null) return;
  observerState.timer = setInterval(pollObserverState, OBSERVER_POLL_MS);
  pollObserverState();
}
function stopObserverPolling() { clearInterval(observerState.timer); observerState.timer = null; }
function configureRuntime() {
  if (app.isPackaged && path.basename(ARTIFACTS) !== 'artifacts') {
    throw new Error('Keep this local prototype under the demo artifacts folder; it stores runtime data beside the app.');
  }
  for (const name of ['', 'session', 'logs', 'crashes', 'tmp', 'cache']) ensureDirectory(path.join(RUNTIME, name));
  app.setName(APP_NAME);
  app.setPath('userData', RUNTIME);
  app.setPath('sessionData', path.join(RUNTIME, 'session'));
  app.setPath('logs', path.join(RUNTIME, 'logs'));
  app.setPath('crashDumps', path.join(RUNTIME, 'crashes'));
  app.setPath('temp', path.join(RUNTIME, 'tmp'));
  app.commandLine.appendSwitch('disk-cache-dir', path.join(RUNTIME, 'cache'));
  process.env.TMPDIR = `${path.join(RUNTIME, 'tmp')}${path.sep}`;
}
function readPreferences() {
  try {
    if (fs.lstatSync(PREFS_FILE).isSymbolicLink() || fs.statSync(PREFS_FILE).size > PREFERENCES_FILE_LIMIT) throw new Error('Invalid preferences file.');
    const parsed = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
    const sanitized = sanitizePreferences(parsed);
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'collections') && JSON.stringify(parsed.collections) !== JSON.stringify(sanitized.collections)) preferencesWarning = true;
    return sanitized;
  } catch (error) {
    if (error.code !== 'ENOENT') { preferencesWarning = true; log(`Preferences ignored: ${error.message}`); }
    return sanitizePreferences(null);
  }
}
function rememberBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  preferences.bounds = mainWindow.getBounds();
  if (preferences.expanded) preferences.expandedBounds = preferences.bounds;
}
function savePreferences() {
  clearTimeout(saveTimer);
  if (!preferences) return false;
  rememberBounds();
  // Unique staging file and checked absolute rename keep a partial write from
  // corrupting preferences. Both targets are inside this exact runtime folder.
  const staging = path.join(RUNTIME, `preferences-${process.pid}.tmp`);
  try {
    for (const candidate of [PREFS_FILE, staging]) {
      if (path.dirname(path.resolve(candidate)) !== path.resolve(RUNTIME) ||
          fs.lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Unsafe preferences target.');
    }
    const serialized = JSON.stringify({ version: 1, ...preferences }, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > PREFERENCES_FILE_LIMIT) throw new Error('Preferences exceed the bounded file size.');
    fs.writeFileSync(staging, serialized, { mode: 0o600 });
    fs.renameSync(staging, PREFS_FILE);
    return true;
  } catch (error) { log(`Could not save preferences: ${error.message}`); return false; }
}
function queueSave() { clearTimeout(saveTimer); saveTimer = setTimeout(savePreferences, 180); }
function state() {
  return { pinned: preferences.pinned, expanded: preferences.expanded, visible: !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() };
}
function publishState() {
  if (mainWindow && !mainWindow.isDestroyed() && isAllowedNavigation(mainWindow.webContents.getURL(), target)) {
    mainWindow.webContents.send('shipboss:state', state());
  }
  updateTrayMenu();
}
function showWindow({ focus = true } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  // 默认不抢焦点：用 showInactive，避免打断老板打字。
  if (focus) { mainWindow.show(); mainWindow.focus(); }
  else { mainWindow.showInactive(); }
  publishState();
}
function hideWindow() { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide(); publishState(); return state(); }
function setPinned(value) {
  preferences.pinned = value;
  mainWindow.setAlwaysOnTop(value, 'floating');
  queueSave(); publishState(); return state();
}
function setExpanded(value) {
  if (preferences.expanded !== value) {
    const previous = mainWindow.getBounds();
    if (preferences.expanded) preferences.expandedBounds = previous;
    const area = screen.getDisplayMatching(previous).workArea;
    preferences.expanded = value;
    const next = fitBounds(value ? preferences.expandedBounds : null, value, area, previous);
    mainWindow.setMinimumSize(1, 1);
    mainWindow.setResizable(true);
    mainWindow.setBounds(next);
    mainWindow.setMinimumSize(Math.min(COLLAPSED_SIZE.width, area.width), Math.min(COLLAPSED_SIZE.height, area.height));
    mainWindow.setResizable(value);
    rememberBounds(); queueSave(); publishState();
  }
  return state();
}
function updateTrayMenu() {
  if (!tray || !preferences) return;
  tray.setContextMenu(null); // Left click toggles; only right click opens the menu.
}
function trayMenu() {
  return Menu.buildFromTemplate([
    { label: state().visible ? '隐藏窗口' : '显示窗口', click: () => state().visible ? hideWindow() : showWindow() },
    { label: '置顶', type: 'checkbox', checked: preferences.pinned, click: item => setPinned(item.checked) },
    { label: preferences.expanded ? '收起' : '展开', click: () => setExpanded(!preferences.expanded) },
    ...(loadingError ? [{ label: '重试加载', click: () => { void loadRenderer(); showWindow(); } }] : []),
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
}
function createTray() {
  const image = nativeImage.createFromPath(path.join(__dirname, 'trayTemplate.png'));
  if (image.isEmpty()) throw new Error('The SHIPBOSS tray PNG is missing or unreadable.');
  image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip(APP_NAME);
  tray.on('click', () => state().visible ? hideWindow() : showWindow());
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
  tray.on('double-click', () => showWindow());
}
function configureSession() {
  const desktopSession = session.fromPartition('persist:shipboss-observer');
  desktopSession.setPermissionCheckHandler(() => false);
  desktopSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  desktopSession.on('will-download', event => event.preventDefault());
  desktopSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedResource(details.url, target) });
  });
  desktopSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-security-policy') delete headers[key];
    headers['Content-Security-Policy'] = [contentSecurityPolicy(target)];
    callback({ responseHeaders: headers });
  });
  return desktopSession;
}
function escapeHTML(value) { return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
async function showLoadError(message) {
  loadingError = String(message).slice(0, 2000);
  log(`Renderer error: ${loadingError}`);
  if (!mainWindow || mainWindow.isDestroyed() || showingError) return;
  showingError = true;
  const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${APP_NAME}</title><style>body{margin:0;padding:28px;background:#171b1a;color:#e9eee7;font:14px/1.6 -apple-system,sans-serif}h1{font-size:20px}p{color:#b6c1b5}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;color:#e8bd8c}</style><h1>SHIPBOSS 无法加载</h1><p>请确认 widget 已构建。右键菜单栏图标，选择「重试加载」或「退出」。</p><pre>${escapeHTML(loadingError)}</pre></html>`;
  try { await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`); showWindow({ focus: false }); }
  catch (error) { log(`Error screen failed: ${error.message}`); }
  finally { showingError = false; updateTrayMenu(); }
}
async function loadRenderer() {
  loadingError = null;
  try {
    if (target.development) await mainWindow.loadURL(target.url);
    else {
      if (!fs.existsSync(target.file)) throw new Error(`Missing ${target.file}. Run the renderer build first.`);
      await mainWindow.loadFile(target.file, { query: { desktop: '1' } });
    }
    publishState();
  } catch (error) { if (!isQuitting) await showLoadError(error.message); }
}
let desktopSession;
function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const area = validBounds(preferences.bounds) ? screen.getDisplayMatching(preferences.bounds).workArea : screen.getPrimaryDisplay().workArea;
  const bounds = fitBounds(preferences.bounds, preferences.expanded, area);
  mainWindow = new BrowserWindow({
    ...bounds, useContentSize: true, title: APP_NAME, show: false, frame: false,
    backgroundColor: '#171b1a', resizable: preferences.expanded, alwaysOnTop: preferences.pinned,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
    minWidth: Math.min(COLLAPSED_SIZE.width, area.width), minHeight: Math.min(COLLAPSED_SIZE.height, area.height),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), session: desktopSession,
      contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false,
      webviewTag: false, webSecurity: true, allowRunningInsecureContent: false,
      navigateOnDragDrop: false, spellcheck: false, devTools: process.env.SHIPBOSS_TEST_MODE === '1' || !app.isPackaged,
      // Only the mode flag crosses into the renderer; the state path stays in main.
      additionalArguments: [`--shipboss-observer-mode=${observerConfig.mode}`, ...(activityPreview ? ['--shipboss-activity-preview'] : []), ...(testRun ? ['--shipboss-activity-testing'] : [])],
    },
  });
  mainWindow.setMenu(null);
  const contents = mainWindow.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => { if (!isAllowedNavigation(event.url, target)) event.preventDefault(); });
  contents.on('will-redirect', event => { if (!isAllowedNavigation(event.url, target)) event.preventDefault(); });
  contents.on('will-frame-navigate', event => {
    if (!event.isMainFrame || !isAllowedNavigation(event.url, target)) event.preventDefault();
  });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('render-process-gone', (_event, details) => {
    if (!isQuitting && details.reason !== 'clean-exit') void showLoadError(`Renderer process stopped (${details.reason}).`);
  });
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3 && !isQuitting && !showingError) void showLoadError(`${description} (${code})\n${target.file || target.url}`);
  });
  contents.on('did-finish-load', () => { publishState(); publishObserverState(); });
  mainWindow.on('close', event => { if (!isQuitting) { event.preventDefault(); hideWindow(); } });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('show', publishState); mainWindow.on('hide', publishState);
  mainWindow.on('move', queueSave); mainWindow.on('resize', queueSave);
  mainWindow.on('unresponsive', () => log('Renderer is not responding; use the tray menu to hide or quit.'));
  mainWindow.once('ready-to-show', () => showWindow({ focus: false }));
  void loadRenderer();
  return mainWindow;
}
function trustedSender(event) {
  try {
    return mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents &&
      event.senderFrame === mainWindow.webContents.mainFrame && isAllowedNavigation(event.senderFrame.url, target);
  } catch { return false; }
}
function registerIPC() {
  const register = (channel, arity, handler) => ipcMain.handle(channel, (event, ...args) => {
    if (!trustedSender(event)) throw new Error('Desktop IPC is limited to the trusted widget main frame.');
    if (args.length !== arity || (arity === 1 && typeof args[0] !== 'boolean')) throw new TypeError('Invalid desktop control arguments.');
    return handler(...args);
  });
  register('shipboss:get-state', 0, state);
  register('shipboss:get-observer-state', 0, observerEnvelope);
  register('shipboss:set-pinned', 1, setPinned);
  register('shipboss:set-expanded', 1, setExpanded);
  register('shipboss:hide', 0, hideWindow);
  register('shipboss:quit', 0, () => { setImmediate(() => app.quit()); return null; });
  const collectionScope = value => value === 'bridge' || value === 'demo';
  ipcMain.handle('shipboss:get-collected-rooms', (event, ...args) => {
    if (!trustedSender(event)) throw new Error('Desktop IPC is limited to the trusted widget main frame.');
    const [scope] = args;
    if (args.length !== 1 || !collectionScope(scope)) throw new TypeError('Invalid collection scope.');
    return { ok: !preferencesWarning, ids: [...preferences.collections[scope]] };
  });
  ipcMain.handle('shipboss:set-collected-rooms', (event, ...args) => {
    if (!trustedSender(event)) throw new Error('Desktop IPC is limited to the trusted widget main frame.');
    const [scope, ids] = args;
    if (args.length !== 2 || !collectionScope(scope) || !Array.isArray(ids) || ids.length > 256 ||
        ids.some(id => typeof id !== 'string' || id.length === 0 || id.length > 160 || id.trim() !== id || /[\u0000-\u001f\u007f]/.test(id))) {
      throw new TypeError('Invalid collected room preferences.');
    }
    const next = sanitizeCollectedRooms(ids);
    if (next.length !== ids.length) throw new TypeError('Collected room IDs must be unique and valid.');
    const previous = preferences.collections[scope];
    preferences.collections[scope] = next;
    if (savePreferences()) { preferencesWarning = false; return { ok: true, ids: [...next] }; }
    preferences.collections[scope] = previous;
    return { ok: false, ids: [...previous] };
  });
}
function fatal(error) {
  log(`Main process failure: ${error && error.stack || error}`);
  if (fatalReported) { app.exit(1); return; }
  fatalReported = true;
  try { dialog.showErrorBox(`${APP_NAME} 启动失败`, `${error.message || error}\n\n日志：${LOG_FILE}`); }
  finally { app.exit(1); }
}
try {
  configureRuntime();
  // The normal app never reads or changes OS login-item settings.
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    target = rendererTarget(ROOT, app.isPackaged ? null : process.env.SHIPBOSS_DEV_URL);
    preferences = readPreferences();
    try {
      const stat = fs.lstatSync(PRESENTATION_SEEN);
      if (!stat.isSymbolicLink() && stat.isFile() && stat.size <= 20000) {
        const seen = JSON.parse(fs.readFileSync(PRESENTATION_SEEN, 'utf8'));
        if (Array.isArray(seen)) presentationSeen = seen.filter(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)).slice(-256);
      }
    } catch { /* First launch has no presentation history. */ }
    process.on('uncaughtException', fatal);
    process.on('unhandledRejection', fatal);
    app.on('before-quit', () => { isQuitting = true; savePreferences(); });
    app.on('will-quit', () => { clearTimeout(saveTimer); clearInterval(helperTimer); stopObserverPolling(); if (tray) tray.destroy(); });
    app.on('second-instance', () => { void app.whenReady().then(() => showWindow({ focus: false })); });
    app.on('activate', () => { if (app.isReady()) showWindow({ focus: false }); });
    app.on('window-all-closed', () => { /* Closing the widget leaves the menu-bar app running. */ });
    app.on('child-process-gone', (_event, details) => { if (!isQuitting) log(`Child process stopped: ${details.type} (${details.reason}).`); });
    void app.whenReady().then(() => {
      if (process.platform === 'darwin') app.dock.hide();
      desktopSession = configureSession(); registerIPC(); createTray(); createWindow(); startObserverPolling();
      helperHeartbeat(); helperTimer = setInterval(helperHeartbeat, 5000);
      const fitVisibleWindow = () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const previous = mainWindow.getBounds(), area = screen.getDisplayMatching(previous).workArea;
        mainWindow.setMinimumSize(1, 1);
        mainWindow.setBounds(fitBounds(previous, preferences.expanded, area));
        mainWindow.setMinimumSize(Math.min(COLLAPSED_SIZE.width, area.width), Math.min(COLLAPSED_SIZE.height, area.height));
        queueSave();
      };
      screen.on('display-removed', fitVisibleWindow); screen.on('display-metrics-changed', fitVisibleWindow);
    }).catch(fatal);
  }
} catch (error) { fatal(error); }
