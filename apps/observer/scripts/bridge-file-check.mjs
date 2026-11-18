import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';

// Read one real state file through the native widget. The observer never writes it.
const root = await fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const stateFile = path.resolve(process.argv[2] || process.env.SHIPBOSS_OBSERVER_STATE || '');
if (!process.argv[2] && !process.env.SHIPBOSS_OBSERVER_STATE) {
  console.error('Usage: node scripts/bridge-file-check.mjs /absolute/path/to/observer-state.json');
  process.exit(2);
}
const env = { ...process.env, SHIPBOSS_TEST_MODE: '1', SHIPBOSS_TEST_RUN_ID: `bridge-file-${Date.now()}`, SHIPBOSS_OBSERVER_STATE: stateFile };
delete env.ELECTRON_RUN_AS_NODE; delete env.SHIPBOSS_DEV_URL;
const app = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'desktop/main.cjs')], cwd: root, env, timeout: 30000 });
try {
  const page = await app.firstWindow({ timeout: 20000 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.__SHIPBOSS_WIDGET__ && document.querySelector('#widget-loading')?.hidden &&
    window.__SHIPBOSS_WIDGET__.getState().observer.status === 'live', null, { timeout: 20000, polling: 100 });
  const widget = await page.evaluate(() => window.__SHIPBOSS_WIDGET__.getState());
  const state = await page.evaluate(() => window.shipbossObserver.getState());
  assert.equal(widget.observer.demo, false);
  assert.deepEqual(widget.rooms.map(room => room.id), state.projects.map(project => project.id));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    stateFile, observer: widget.observer, rooms: widget.rooms.map(room => ({ id: room.id, name: room.name, waiting: room.scene.waiting })),
    projects: state.projects.map(project => ({ id: project.id, name: project.name, source: project.source, status: project.status,
      needsAttention: project.needsAttention, awaitingUser: project.awaitingUser, pendingQuestion: project.pendingQuestion,
      actors: project.actors.map(actor => ({ id: actor.id, active: actor.active, motion: actor.motion })),
      tasks: project.tasks.map(task => ({ id: task.id, status: task.status })) })),
  }, null, 2));
} finally { await app.close().catch(() => {}); }
