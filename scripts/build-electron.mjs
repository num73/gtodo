import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

await build({
  entryPoints: ['electron/main.ts', 'electron/preload.ts', 'electron/capture-preload.ts'],
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
});
await build({ entryPoints: ['electron/capture-renderer.ts'], outfile: 'dist-electron/capture-renderer.js', bundle: true, platform: 'browser', target: 'chrome140', minify: true });
await writeFile('dist-electron/capture.html', await readFile('electron/capture.html', 'utf8'));
// Windows PowerShell 5.1 needs a BOM to read the bridge's Chinese strings correctly.
await writeFile('dist-electron/outlook-bridge.ps1', '\ufeff' + (await readFile('electron/outlook-bridge.ps1', 'utf8')).replace(/^\ufeff/, ''));
