import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { prepareDataLocation } from '../electron/data-location';
import { PreferencesStore } from '../electron/preferences';
import { FolderStorage } from '../electron/folder-storage';
import { DataStore } from '../electron/storage';
import { CurrentRecords, currentRecordParts, type CurrentManifest } from '../electron/current-records';
import { SnapshotFiles } from '../electron/snapshot-files';
import { WorkspaceEngine } from '../src/shared/engine';
import { temporaryDirectory, transferSnapshot } from './helpers';

async function device(t: TestContext) {
  const root = await temporaryDirectory(t), profile = path.join(root, 'profile'), directory = path.join(root, 'data'); await mkdir(profile);
  const preferences = new PreferencesStore(profile); await preferences.initialize();
  const local = await prepareDataLocation(preferences, directory), folder = new FolderStorage(local, preferences); await folder.initialize();
  return { root, local, folder };
}
const manifest = async (folder: FolderStorage): Promise<CurrentManifest> => JSON.parse(await readFile(folder.ownFile, 'utf8'));
const recordFiles = async (folder: FolderStorage) => (await readdir(path.join(folder.directory, 'records', `device-${folder.local.engine.deviceId}`))).sort();

test('repeated My Day and status changes overwrite the same task file without creating files or document versions', async t => {
  const f = await device(t);
  await f.folder.update(engine => { engine.apply({ type: 'task.add', title: '日常任务', listId: 'inbox' }); engine.apply({ type: 'task.update', id: engine.state.tasks[0].id, patch: { notes: '需要保留的正文' } }); });
  const id = f.local.engine.state.tasks[0].id, original = await manifest(f.folder), files = await recordFiles(f.folder);
  const taskFile = path.join(f.folder.directory, ...currentRecordParts(original.deviceId, 'tasks', original.records.tasks[0].key)), before = await readFile(taskFile);
  const revisions = structuredClone(f.local.engine.state.documentRevisions);
  for (let i = 0; i < 10; i++) {
    await f.folder.update(engine => engine.apply({ type: 'task.update', id, patch: { myDay: '2026-11-22', important: true } }));
    await f.folder.update(engine => engine.apply({ type: 'task.update', id, patch: { myDay: null, important: false } }));
  }
  const next = await manifest(f.folder);
  assert.equal(next.records.tasks[0].key, original.records.tasks[0].key);
  assert.deepEqual(next, original, 'Status edits do not rewrite the membership index');
  assert.notDeepEqual(await readFile(taskFile), before, 'Current state clocks are still saved in the original file');
  assert.deepEqual(await recordFiles(f.folder), files);
  assert.deepEqual(f.local.engine.state.documentRevisions, revisions);
  assert.deepEqual(await readdir(path.join(f.folder.directory, 'records')), [`device-${f.local.engine.deviceId}`]);
  const restarted = await DataStore.open(f.folder.directory, f.local.engine.deviceId);
  assert.equal(restarted.engine.state.tasks[0].values.myDay, null); assert.equal(restarted.engine.state.tasks[0].values.notes, '需要保留的正文');
});

test('body history stays in one bounded document file, and frozen backups do not change with current records', async t => {
  const f = await device(t); await f.folder.update(engine => engine.apply({ type: 'note.add', content: '正文 0' }));
  const id = f.local.engine.state.notes[0].id, files = await recordFiles(f.folder);
  const automatic = (await readdir(path.join(f.local.directory, 'history'))).find(name => name.startsWith('hour-'))!;
  const frozenFile = path.join(f.local.directory, 'history', automatic), frozen = await readFile(frozenFile);
  for (let i = 1; i <= 55; i++) await f.folder.update(engine => engine.apply({ type: 'note.update', id, patch: { content: `正文 ${i}` } }));
  assert.deepEqual(await recordFiles(f.folder), files);
  assert.equal(f.local.engine.state.documentRevisions.length, 50);
  const current = await manifest(f.folder), ref = current.records.documentRevisions[0];
  assert.equal(current.records.documentRevisions.length, 1);
  const history = JSON.parse(await readFile(path.join(f.folder.directory, ...currentRecordParts(current.deviceId, 'documentRevisions', ref.key)), 'utf8'));
  assert.equal(history.items.length, 50); assert.deepEqual(await readFile(frozenFile), frozen);
  const restored = await f.local.readSnapshot(frozenFile); assert.equal(restored.workspace.notes[0].values.content, '正文 0');
  assert.equal((await f.local.backupWorkspace()).notes[0].values.content, '正文 54');
});

test('late cloud record arrival is read again even when the device index has not changed', async t => {
  const a = await device(t), b = await device(t);
  await a.folder.update(engine => engine.apply({ type: 'task.add', title: '原名称', listId: 'inbox' }));
  await transferSnapshot(a.folder.ownFile, b.folder.directory); await b.folder.refresh();
  const id = a.local.engine.state.tasks[0].id;
  await a.folder.update(engine => engine.apply({ type: 'task.update', id, patch: { title: '已更新' } }));
  await copyFile(a.folder.ownFile, path.join(b.folder.directory, path.basename(a.folder.ownFile)));
  await b.folder.refresh(); assert.equal(b.local.engine.state.tasks[0].values.title, '原名称');
  const current = await manifest(a.folder), parts = currentRecordParts(current.deviceId, 'tasks', current.records.tasks[0].key);
  await copyFile(path.join(a.folder.directory, ...parts), path.join(b.folder.directory, ...parts));
  await b.folder.refresh(); assert.equal(b.folder.status.error, null); assert.equal(b.local.engine.state.tasks[0].values.title, '已更新');
});

test('an interrupted publication is repaired from the committed working snapshot, including after restart', async t => {
  const f = await device(t); await f.folder.update(engine => engine.apply({ type: 'task.add', title: '原名称', listId: 'inbox' }));
  await f.local.update(engine => engine.apply({ type: 'task.update', id: engine.state.tasks[0].id, patch: { title: '已保存的新名称' } }));
  await new CurrentRecords().encode(f.local.engine.state, f.folder.directory, f.local.engine.deviceId);
  // The current file is replaced in place; recovery uses the complete local snapshot.
  const restarted = await DataStore.open(f.folder.directory, f.local.engine.deviceId);
  const folder = new FolderStorage(restarted, f.folder.preferences); await folder.initialize();
  assert.equal(folder.status.error, null);
  const decoded = await new SnapshotFiles().decode(await manifest(folder), folder.directory);
  assert.equal(decoded.tasks[0].values.title, '已保存的新名称');
});

test('legacy immutable snapshots and their backups migrate without creating new hash shards', async t => {
  const f = await device(t), old = new WorkspaceEngine(f.local.engine.deviceId);
  old.apply({ type: 'note.add', content: '旧版正文' });
  const legacy = await new SnapshotFiles().encode(old.state, f.folder.directory);
  const saved = JSON.stringify({ deviceId: old.deviceId, workspace: legacy });
  await writeFile(f.local.file, saved); await writeFile(`${f.local.file}.bak`, saved);
  const historyFile = path.join(f.local.directory, 'history', 'hour-20200101T00.json'); await mkdir(path.dirname(historyFile), { recursive: true }); await writeFile(historyFile, saved);
  await writeFile(f.folder.ownFile, JSON.stringify(legacy));
  const reopened = await DataStore.open(f.folder.directory, old.deviceId), folder = new FolderStorage(reopened, f.folder.preferences); await folder.initialize();
  assert.equal(folder.status.error, null); assert.equal(reopened.engine.state.notes[0].values.content, '旧版正文');
  assert.equal((await manifest(folder)).format, 'gtodo-current');
  assert.ok(!JSON.parse(await readFile(historyFile, 'utf8')).workspace.format);
  const prefixes = await readdir(path.join(folder.directory, 'records'));
  await folder.update(engine => engine.apply({ type: 'note.update', id: engine.state.notes[0].id, patch: { title: '改名' } }));
  assert.deepEqual(await readdir(path.join(folder.directory, 'records')), prefixes);
  assert.equal((await reopened.readSnapshot(historyFile)).workspace.notes[0].values.content, '旧版正文');
});
