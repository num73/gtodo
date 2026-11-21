import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import electron from 'electron';
const root = path.resolve('.qa'); await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, 'notebook-'));
const main = path.join(directory, 'main.cjs');
await build({ entryPoints: ['tests/native-notebook.ts'], outfile: main, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
const env = { ...process.env, GTODO_DATA_DIR: path.join(directory, 'profile'), GTODO_QA: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.GTODO_DEV_URL;
for (const phase of ['seed', 'restore']) {
  const child = spawn(electron, [main], { env: { ...env, GTODO_NOTEBOOK_PHASE: phase }, windowsHide: true, stdio: 'inherit' });
  const timeout = setTimeout(() => child.kill(), 90000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    const result = JSON.parse(await readFile(path.join(directory, phase + '.json'), 'utf8'));
    if (code !== 0 || !result.passed) throw new Error(result.error || `${phase} exited with ${code}`);
  } finally { clearTimeout(timeout); }
}
console.log(`Native notebook and Git results: ${directory}`);
