import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import electron from 'electron';

const root = path.resolve('.qa'); await mkdir(root, { recursive: true });
for (const scale of [null, 1, 1.5, 2]) {
  const directory = await mkdtemp(path.join(root, 'native-capture-'));
  const main = path.join(directory, 'main.cjs');
  await build({ entryPoints: ['tests/native-screen-capture.ts'], outfile: main, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.GTODO_CAPTURE_TEST_SCALE;
  if (scale !== null) env.GTODO_CAPTURE_TEST_SCALE = String(scale);
  const label = scale === null ? 'System display settings' : `${scale * 100}% process scale`;
  const child = spawn(electron, [main], { env, windowsHide: true, stdio: 'inherit' });
  const timeout = setTimeout(() => child.kill(), 30000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (code !== 0) throw new Error(`Capture test (${label}) exited with ${code}`);
    const result = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
    if (!result.passed) throw new Error(result.error);
    console.log(`${label} passed: ${path.join(directory, 'result.json')}`);
  } finally { clearTimeout(timeout); }
}
