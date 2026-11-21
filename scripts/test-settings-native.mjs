import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import electron from 'electron';
import { readTestWorkspace } from './read-test-workspace.mjs';

const root = path.resolve('.qa'); await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, 'settings-'));
const main = path.join(directory, 'main.cjs');
await build({ entryPoints: ['tests/native-settings.ts'], outfile: main, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
const env = { ...process.env, GTODO_DATA_DIR: path.join(directory, 'profile'), GTODO_QA: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.GTODO_DEV_URL;
for (const phase of ['seed', 'quiet', 'restore']) {
  const child = spawn(electron, [main], { env: { ...env, GTODO_SETTINGS_PHASE: phase }, windowsHide: true, stdio: 'inherit' });
  const timeout = setTimeout(() => child.kill(), 60000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    const result = JSON.parse(await readFile(path.join(directory, `${phase}.json`), 'utf8'));
    if (code !== 0 || !result.passed) throw new Error(result.error || `${phase} exited with ${code}`);
  } finally { clearTimeout(timeout); }
}
const preferences = JSON.parse(await readFile(path.join(env.GTODO_DATA_DIR, 'preferences.json'), 'utf8'));
const timer = JSON.parse(await readFile(path.join(preferences.dataPath, '.gtodo', 'devices', preferences.deviceId, 'pomodoro.json'), 'utf8'));
if (timer.session.status !== 'paused') throw new Error('Closing in quit mode must pause the active timer');
const saved = await readTestWorkspace(env.GTODO_DATA_DIR);
if (saved.notes[0].values.content !== '退出时的最后输入') throw new Error('Closing in quit mode must save the final note draft');
console.log(`Native settings results: ${directory}`);
