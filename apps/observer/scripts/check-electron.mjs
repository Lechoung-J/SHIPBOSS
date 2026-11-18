import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let binary;
try { binary = require('electron'); }
catch { console.error('Electron package is missing. Run the frozen dependency install first.'); process.exit(1); }
const result = spawnSync(process.env.PYTHON || 'python3', [fileURLToPath(new URL('./electron-health.py', import.meta.url)), binary], { stdio: 'inherit', timeout: 15000 });
process.exit(result.status ?? 1);
