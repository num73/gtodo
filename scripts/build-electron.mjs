import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

await build({
  entryPoints: ['electron/main.ts', 'electron/preload.ts'],
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
});
// Windows PowerShell 5.1 needs a BOM to read the bridge's Chinese strings correctly.
await writeFile('dist-electron/outlook-bridge.ps1', '\ufeff' + (await readFile('electron/outlook-bridge.ps1', 'utf8')).replace(/^\ufeff/, ''));
