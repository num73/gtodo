import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import electron from 'electron';

if (process.platform !== 'win32') throw new Error('The taskbar integration test requires Windows x64.');
const root = path.resolve('.qa'); await mkdir(root, {recursive: true});
const directory = await mkdtemp(path.join(root, 'taskbar-native-'));
const main = path.join(directory, 'main.cjs');
await build({entryPoints: ['tests/native-taskbar.ts'], outfile: main, bundle: true, platform: 'node', format: 'cjs', external: ['electron']});
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [main], {env, windowsHide: true, stdio: 'inherit'});
const timeout = setTimeout(() => child.kill(), 60000);
try {
  const code = await new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', resolve);});
  if (code !== 0) throw new Error(`Native taskbar test exited with ${code}`);
  const result = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
  if (!result.passed) throw new Error(result.error);
  console.log(`Native test result: ${path.join(directory, 'result.json')}`);
} finally {clearTimeout(timeout);}
