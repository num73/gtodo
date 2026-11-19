import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import electron from 'electron';

// Exercise the real main/preload/renderer bundles with synthetic data only.
// Accept a built project directory or resources/app.asar as the first argument.
const root = process.cwd();
const application = path.resolve(process.argv[2] || root);
const records = Number(process.argv[3] || 5);
const runs = Number(process.argv[4] || 3);
if (!Number.isInteger(records) || records < 0 || records > 2000 || !Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('Usage: node scripts/benchmark-startup.mjs [app-directory-or-asar] [records:0-2000] [runs:1-10]');
await mkdir('.qa', { recursive: true });
const directory = await mkdtemp(path.resolve('.qa', 'startup-'));
const fixtureFile = path.join(directory, 'fixture.cjs');
await build({ stdin: { contents: "export { DataStore } from './electron/storage'; export { PreferencesStore } from './electron/preferences'; export { FolderStorage } from './electron/folder-storage';", resolveDir: root }, outfile: fixtureFile, bundle: true, platform: 'node', format: 'cjs' });
const { DataStore, PreferencesStore, FolderStorage } = createRequire(import.meta.url)(fixtureFile);
const harness = path.join(directory, 'probe.cjs');
await writeFile(harness, `
const { app, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const application = process.env.GTODO_BENCH_APP;
const directory = process.env.GTODO_DATA_DIR;
if (!application || !directory) throw new Error('Missing isolated benchmark paths');
app.setPath('userData', directory);
app.getAppPath = () => application;
app.getVersion = () => JSON.parse(fs.readFileSync(path.join(application, 'package.json'), 'utf8')).version;
const timings = {};
const mark = name => { timings[name] ??= Date.now() - Number(process.env.GTODO_BENCH_STARTED); };
mark('mainEntryMs');
app.once('ready', () => mark('electronReadyMs'));
app.once('browser-window-created', (_event, window) => {
  mark('windowCreatedMs');
  window.once('ready-to-show', () => mark('readyToShowMs'));
  window.webContents.once('did-finish-load', () => mark('pageLoadedMs'));
});
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => handle(channel, async (...args) => {
  const result = await callback(...args);
  if (channel === 'gtodo:state' && !timings.firstStateMs) {
    mark('firstStateMs');
    setTimeout(() => app.quit(), 500);
  }
  return result;
});
app.once('will-quit', () => fs.writeFileSync(path.join(directory, 'startup-result.json'), JSON.stringify(timings)));
require(path.join(application, 'dist-electron', 'main.cjs'));
`);
const results = [];
for (let run = 0; run < runs; run++) {
  const profile = path.join(directory, `profile-${run + 1}`);
  const store = new DataStore(profile); await store.initialize();
  await store.update(engine => {
    for (let i = 0; i < records; i++) engine.apply({ type: 'note.add', title: `Startup sample ${i + 1}`, content: 'Synthetic startup benchmark.' });
  });
  const preferences = new PreferencesStore(profile); await preferences.initialize();
  await preferences.update(value => { value.window = { x: 80, y: 80, width: 900, height: 640, maximized: false }; });
  const folders = new FolderStorage(store, preferences); await folders.initialize();
  if (folders.status.error) throw new Error(folders.status.error);
  const env = { ...process.env, GTODO_DATA_DIR: profile, GTODO_QA: '1', GTODO_BENCH_APP: application, GTODO_BENCH_STARTED: String(Date.now()) };
  delete env.ELECTRON_RUN_AS_NODE; delete env.GTODO_DEV_URL;
  const child = spawn(electron, [harness], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill(), 60000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (code !== 0) throw new Error(`Startup probe exited with ${code}: ${output.slice(-4000)}`);
    const result = JSON.parse(await readFile(path.join(profile, 'startup-result.json'), 'utf8'));
    if (!result.firstStateMs || !result.pageLoadedMs) throw new Error(`Startup did not finish: ${JSON.stringify(result)}`);
    results.push(result); console.log(JSON.stringify({ run: run + 1, ...result }));
  } finally { clearTimeout(timeout); }
}
const medianFirstStateMs = results.map(result => result.firstStateMs).sort((a, b) => a - b)[Math.floor(results.length / 2)];
const report = { application, records, results, medianFirstStateMs };
await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ records, medianFirstStateMs, report: path.join(directory, 'report.json') }));
