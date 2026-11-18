// 用真实状态文件启动观察窗，检查 idle 房间是否变暗（不修改任何状态）。
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { _electron } from '@playwright/test';

const root = await fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const statePath = process.argv[2];
assert.ok(statePath, '用法: node scripts/live-dim-check.mjs <state.json>');
const raw = JSON.parse(await readFile(statePath, 'utf8'));

const env = { ...process.env, SHIPBOSS_OBSERVER_STATE: statePath };
delete env.ELECTRON_RUN_AS_NODE; delete env.SHIPBOSS_DEV_URL;
const app = await _electron.launch({ executablePath: require('electron'),
  args: [path.join(root, 'desktop', 'main.cjs')], cwd: root, env, timeout: 30000 });
const page = await app.firstWindow({ timeout: 20000 });
await page.waitForFunction(() => window.__SHIPBOSS_WIDGET__?.getState()?.rendering?.frames > 3, null, { timeout: 20000 });
const state = await page.evaluate(() => window.__SHIPBOSS_WIDGET__.getState());
const rooms = state.rooms;
console.log('房间:', rooms.map(r => `${r.id}:${r.status}:${r.lightScale ?? r.dimmed}`).join(' | '));
for (const p of raw.projects) {
  const room = rooms.find(r => r.id === p.id);
  if (!room) { console.log('缺房间', p.id); continue; }
  if (p.status === 'idle') assert.ok((room.lightScale ?? 1) < 0.6 || room.dimmed === true, `idle 应变暗: ${p.id}`);
  else assert.ok((room.lightScale ?? 1) > 0.8 || room.dimmed === false, `活跃不应变暗: ${p.id}`);
}
console.log('PASS 真实状态：idle 房间已变暗，活跃房间保持明亮');
await app.close();
