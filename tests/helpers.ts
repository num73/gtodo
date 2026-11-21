import { mkdir, mkdtemp, rm, readFile, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { SnapshotFiles, isRecordManifest, recordParts } from '../electron/snapshot-files';

export async function temporaryDirectory(t: TestContext) {
  const root = path.resolve('.qa', 'tests'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'case-'));
  t.after(async () => {
    const relative = path.relative(root, path.resolve(directory));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path');
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

export async function readFolderSnapshot(file: string) {
  return new SnapshotFiles().decode(JSON.parse(await readFile(file, 'utf8')), path.dirname(file));
}
export async function transferSnapshot(source: string, destination: string) {
  const manifest = JSON.parse(await readFile(source, 'utf8'));
  if (isRecordManifest(manifest)) for (const hashes of Object.values(manifest.records)) for (const hash of hashes) {
    const target = path.join(destination, ...recordParts(hash)); await mkdir(path.dirname(target), { recursive: true });
    try { await stat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await copyFile(path.join(path.dirname(source), ...recordParts(hash)), target); }
  }
  await copyFile(source, path.join(destination, path.basename(source)));
}
