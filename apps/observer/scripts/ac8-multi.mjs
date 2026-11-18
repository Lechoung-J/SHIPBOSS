// AC-8 独立检查：bridge 模式下，状态文件里 ≥2 个项目必须出现 ≥2 间房。
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { _electron } from '@playwright/test';

const root = await fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const executablePath = require('electron');
const mainFile = path.join(root, 'desktop', 'main.cjs');
const runtime = path.join(root, 'artifacts', 'runtime', `ac8-${Date.now()}`);
const stateFile = path.join(runtime, 'observer-state.json');
await mkdir(runtime, { recursive: true });

const actor = (id, active = false, motion = 'idle', taskId = null) => ({
  id, role: { pm: 'pm', 'eng-a': 'engineer', 'eng-b': 'engineer', verifier: 'verifier' }[id],
  name: id, active, taskId, motion: active ? motion : 'idle', activity: '', papers: 0,
});
const project = (id, name) => ({
  id, name, source: 'ac8', skillsUsed: 0, status: 'implementing', activity: '1 项实现中',
  needsAttention: false, awaitingUser: false, pendingQuestion: null, recording: false, scribeActivity: '',
  tasks: [{ id: `${id}-1`, title: '任务', status: 'implementing', assignee: 'eng-a', attempt: 1,
            motion: 'working', activity: '实现中', verdict: null, verification: null, evidence: [], simulated: false }],
  actors: [actor('pm'), actor('eng-a', true, 'working', `${id}-1`), actor('eng-b'), actor('verifier')],
  reports: [], epoch: 1, time: 30, simulated: false,
});

await writeFile(stateFile, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(),
  source: 'ac8', projects: [project('shipboss', 'Shipboss'), project('example-tool', 'ExampleTool')] }, null, 2));

const env = { ...process.env, SHIPBOSS_TEST_MODE: '1', SHIPBOSS_OBSERVER_STATE: stateFile };
delete env.ELECTRON_RUN_AS_NODE; delete env.SHIPBOSS_DEV_URL;
const app = await _electron.launch({ executablePath, args: [mainFile], cwd: root, env, timeout: 30000 });
const page = await app.firstWindow({ timeout: 20000 });
await page.waitForFunction(() => !!window.__SHIPBOSS_WIDGET__, null, { timeout: 20000 });
await page.waitForFunction(() => window.__SHIPBOSS_WIDGET__.getState()?.rendering?.frames > 3, null, { timeout: 20000 });
const state = await page.evaluate(() => window.__SHIPBOSS_WIDGET__.getState());
assert.equal(state.projects.length, 2, '两个项目');
assert.equal(state.rooms.length, 2, '两间房');
assert.deepEqual(state.rooms.map(r => r.id).sort(), ['shipboss', 'example-tool']);
assert.equal(state.observer.mode, 'bridge');
console.log('PASS AC-8 多项目 → 多房间:', JSON.stringify(state.rooms.map(r => r.id)));
await app.close();
await rm(runtime, { recursive: true, force: true });
