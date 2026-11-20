import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import electron from 'electron';

const root = path.resolve('.qa'); await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, 'board-display-'));
const main = path.join(directory, 'main.cjs');
await build({ entryPoints: ['tests/native-board-display.ts'], outfile: main, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
const env = { ...process.env, GTODO_DATA_DIR: path.join(directory, 'profile'), GTODO_QA: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.GTODO_DEV_URL;
const child = spawn(electron, [main], { env, windowsHide: true, stdio: 'inherit' });
const timeout = setTimeout(() => child.kill(), 60000);
try {
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  const result = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
  if (code !== 0 || !result.passed) throw new Error(result.error || `Board display test exited with ${code}`);
  console.log(`Native board result: ${path.join(directory, 'result.json')}`);
} finally { clearTimeout(timeout); }
