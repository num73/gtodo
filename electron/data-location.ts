import { lstat, mkdir, readFile, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { atomicWrite, safePath } from './file-io';
import { DataStore } from './storage';
import { PreferencesStore } from './preferences';
import { FolderStorage } from './folder-storage';
import { contentHash } from './snapshot-files';

const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const legacyNames = ['workspace.json', 'workspace.json.bak', 'records', 'history', 'media', 'document-state.json', 'document-state.json.bak', 'pomodoro.json', 'pomodoro.json.bak', 'imports', 'data'];
const archiveSchema = z.object({ files: z.array(z.object({ parts: z.array(z.string()), hash: z.string() })), directories: z.array(z.array(z.string())) });
type Archive = z.infer<typeof archiveSchema>;
export function inside(parent: string, child: string) { const relative = path.relative(path.resolve(parent), path.resolve(child)); return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
async function exists(file: string) { try { await lstat(file); return true; } catch (error) { if (absent(error)) return false; throw error; } }
async function copyChecked(source: string, destination: string, parts: string[], plan: Archive) {
  const file = await safePath(source, parts, false, true);
  const info = await lstat(file);
  if (info.isSymbolicLink()) throw new Error('迁移路径含符号链接或目录联接，已保留原文件。');
  if (info.isDirectory()) {
    for (const name of await readdir(file)) await copyChecked(source, destination, [...parts, name], plan);
    plan.directories.push(parts); return;
  }
  if (!info.isFile()) throw new Error('迁移路径含特殊文件，已保留原文件。');
  const bytes = await readFile(file), target = await safePath(destination, parts, true);
  if (await exists(target)) { if (contentHash(await readFile(target)) !== contentHash(bytes)) throw new Error('迁移目标中已有不同的文件，已保留原文件，请检查迁移目录。'); }
  else await atomicWrite(target, bytes);
  if (contentHash(await readFile(target)) !== contentHash(bytes)) throw new Error('迁移校验失败，已保留原文件。');
  plan.files.push({ parts, hash: contentHash(bytes) });
}
async function removeArchived(profile: string, archive: string) {
  const plan = archiveSchema.parse(JSON.parse(await readFile(path.join(archive, 'migration-files.json'), 'utf8')));
  // Validate the entire copy before deleting any source file.
  for (const item of plan.files) {
    if (contentHash(await readFile(await safePath(archive, item.parts))) !== item.hash) throw new Error('迁移副本校验失败，旧文件没有清理。');
    const original = await safePath(profile, item.parts).catch(error => { if (absent(error)) return null; throw error; });
    if (original && await exists(original) && contentHash(await readFile(original)) !== item.hash) throw new Error('迁移期间原文件发生变化，已停止清理。');
  }
  for (const item of plan.files) {
    try {
      const original = await safePath(profile, item.parts);
      if (contentHash(await readFile(original)) !== item.hash) throw new Error('迁移期间原文件发生变化，已停止清理。');
      await unlink(await safePath(profile, item.parts));
    } catch (error) { if (!absent(error)) throw error; }
  }
  for (const parts of plan.directories) {
    try { await rmdir(path.dirname(await safePath(profile, [...parts, 'placeholder']))); }
    catch (error) { if (!absent(error) && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error; }
  }
}
export async function prepareDataLocation(preferences: PreferencesStore, defaultDirectory: string) {
  const profile = preferences.directory;
  if (inside(profile, defaultDirectory)) throw new Error('默认数据目录不能位于应用配置目录内。');
  if (preferences.value.storageVersion === 3) {
    if (!preferences.value.deviceId) throw new Error('设备配置缺少身份标识，请检查 preferences.json 及备份。');
    if (inside(profile, preferences.value.dataPath)) throw new Error('数据目录不能位于应用配置目录内。');
    if (preferences.value.migrationPath) {
      await removeArchived(profile, path.join(preferences.value.migrationPath, '.gtodo', 'migration-v2'));
      await preferences.update(value => { delete value.migrationPath; });
    }
    const store = await DataStore.open(preferences.value.dataPath, preferences.value.deviceId!, true);
    await preferences.attachWorkspace(store.directory); return store;
  }
  let deviceId = preferences.value.deviceId;
  if (!deviceId) {
    for (const name of ['workspace.json', 'workspace.json.bak']) try {
      deviceId = z.string().uuid().parse(JSON.parse(await readFile(path.join(profile, name), 'utf8')).deviceId); break;
    } catch { /* A fresh identity is safe if the old identity cannot be read. */ }
    deviceId ??= crypto.randomUUID();
  }
  const oldDirectory = preferences.value.dataPath, windows = structuredClone(preferences.value.noteWindows);
  let target = preferences.value.migrationPath ?? (inside(profile, oldDirectory) ? defaultDirectory : oldDirectory);
  if (!preferences.value.migrationPath && inside(profile, oldDirectory) && await exists(target) && (await readdir(target)).length) target = `${defaultDirectory}-${crypto.randomUUID().slice(0, 8)}`;
  await mkdir(target, { recursive: true });
  if (inside(await realpath(profile), await realpath(target))) throw new Error('数据目录不能位于应用配置目录内。');
  await preferences.update(value => { value.deviceId = deviceId; value.migrationPath = target; });
  // The former default data directory is relocated as a whole, preserving external Markdown and Git.
  if (inside(profile, oldDirectory) && await exists(oldDirectory)) {
    const checkpoint = await safePath(target, ['.gtodo', 'migration-v2', `directory-copy-${deviceId}.json`], true);
    if (await exists(checkpoint)) {
      const saved = z.object({ source: z.string() }).parse(JSON.parse(await readFile(checkpoint, 'utf8')));
      if (saved.source !== oldDirectory) throw new Error('待完成迁移的原目录已改变，请保留两边文件并检查配置。');
    } else {
      for (const name of await readdir(oldDirectory)) await copyChecked(oldDirectory, target, [name], { files: [], directories: [] });
      await atomicWrite(checkpoint, JSON.stringify({ source: oldDirectory }));
    }
  }
  const archive = path.join(target, '.gtodo', 'migration-v2'); await mkdir(archive, { recursive: true });
  const plan: Archive = { files: [], directories: [] };
  const roots = legacyNames.map(name => [name]);
  if (inside(profile, oldDirectory)) {
    const relative = path.relative(profile, oldDirectory);
    if (!relative) throw new Error('旧数据目录不能是整个应用配置目录。');
    const parts = relative.split(path.sep); if (!roots.some(root => root.every((part, index) => parts[index] === part))) roots.push(parts);
  }
  for (const parts of roots) if (await exists(path.join(profile, ...parts))) await copyChecked(profile, archive, parts, plan);
  await atomicWrite(path.join(archive, 'migration-files.json'), JSON.stringify(plan));
  const store = await DataStore.open(target, deviceId);
  const legacy = new DataStore(archive);
  const snapshots = ['workspace.json', 'workspace.json.bak', ...plan.files.filter(item => item.parts[0] === 'history' && item.parts.at(-1)?.endsWith('.json')).map(item => item.parts.join(path.sep)).sort().reverse()];
  let imported = false;
  if (plan.files.some(item => snapshots.includes(item.parts.join(path.sep)))) {
    for (const name of snapshots) try { const saved = await legacy.readSnapshot(path.join(archive, name)); await store.update(engine => engine.merge(saved.workspace)); imported = true; break; } catch (error) { if (String(error).includes('较新版本')) throw error; /* Try retained backups without modifying the original. */ }
    if (!imported) throw new Error('旧版数据及备份无法读取，原文件已保留，迁移未完成。');
  }
  const documents = FolderStorage.documentsFor(store);
  if (await exists(path.join(archive, 'media'))) for (const name of await readdir(path.join(archive, 'media'))) await documents.cacheImage(await readFile(await safePath(archive, ['media', name])));
  for (const name of ['pomodoro.json', 'pomodoro.json.bak']) if (await exists(path.join(archive, name)) && !await exists(path.join(store.directory, name))) await atomicWrite(await safePath(target, ['.gtodo', 'devices', deviceId, name]), await readFile(path.join(archive, name)));
  await atomicWrite(path.join(store.directory, 'windows.json'), JSON.stringify(windows));
  // Merge only during this one-time upgrade. Normal directory selection never imports another workspace.
  const prior = preferences.value.dataPath; preferences.value.dataPath = target;
  try {
    const folder = new FolderStorage(store, preferences, () => {}, documents); await folder.initialize();
    if (folder.status.error) throw new Error(folder.status.error);
  } finally { preferences.value.dataPath = prior; }
  await preferences.update(value => { value.storageVersion = 3; value.dataPath = target; value.deviceId = deviceId; });
  await removeArchived(profile, archive);
  await preferences.update(value => { delete value.migrationPath; });
  await preferences.attachWorkspace(store.directory);
  if (plan.files.length) store.notice = '旧版本机数据已迁移到当前数据文件夹，原配置目录中的业务数据已清除。';
  return store;
}
