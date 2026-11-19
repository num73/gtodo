import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, copyFile, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { DataStore } from '../electron/storage';
import { PreferencesStore } from '../electron/preferences';
import { FolderStorage } from '../electron/folder-storage';
import { DocumentFiles } from '../electron/document-files';
import { WorkspaceEngine } from '../src/shared/engine';
import { parseWorkspace } from '../src/shared/model';
import { temporaryDirectory } from './helpers';

async function device(t: TestContext) {
  const root = await temporaryDirectory(t);
  const local = new DataStore(root); await local.initialize();
  const preferences = new PreferencesStore(root); await preferences.initialize();
  const folder = new FolderStorage(local, preferences); await folder.initialize();
  return { root, local, preferences, folder };
}
async function transfer(source: FolderStorage, destination: FolderStorage) {
  await copyFile(source.ownFile, path.join(destination.directory, path.basename(source.ownFile)));
}
test('editing and quitting during the first folder scan preserves both incoming and local changes', async t => {
  const a = await device(t);
  await a.folder.update(engine => engine.apply({ type: 'task.add', title: 'Cached title', listId: 'inbox' }));
  const taskId = a.local.engine.state.tasks[0].id;
  const peer = new WorkspaceEngine('startup-peer', a.local.engine.state);
  peer.apply({ type: 'task.update', id: taskId, patch: { title: 'Incoming title' } });
  await writeFile(path.join(a.folder.directory, 'device-startup-peer.json'), JSON.stringify(peer.state));

  const reopened = new DataStore(a.root); await reopened.initialize();
  const documents = new DocumentFiles(a.root);
  const readChanges = documents.readChanges.bind(documents);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const scanning = new Promise<void>(resolve => { entered = resolve; });
  let first = true;
  documents.readChanges = async (...args) => {
    if (first) { first = false; entered(); await gate; }
    return readChanges(...args);
  };
  const folder = new FolderStorage(reopened, a.preferences, () => {}, documents);
  const initializing = folder.initialize();
  await scanning;
  assert.equal(reopened.engine.state.tasks[0].values.title, 'Cached title');
  const editing = folder.update(engine => engine.apply({ type: 'task.update', id: taskId, patch: { notes: 'Early local edit' } }));
  const quitting = folder.flush();
  release();
  await Promise.all([initializing, editing, quitting]);
  assert.equal(folder.status.error, null);
  const saved = new DataStore(a.root); await saved.initialize();
  assert.equal(saved.engine.state.tasks[0].values.title, 'Incoming title');
  assert.equal(saved.engine.state.tasks[0].values.notes, 'Early local edit');
  const snapshot = parseWorkspace(JSON.parse(await readFile(folder.ownFile, 'utf8')));
  assert.equal(snapshot.tasks[0].values.notes, 'Early local edit');
});
test('upgrading keeps old tasks and device identity while exporting a folder snapshot', async t => {
  const root = await temporaryDirectory(t); const old = new DataStore(root); await old.initialize();
  await old.update(engine => engine.apply({ type: 'task.add', title: '旧版本任务', listId: 'inbox' }));
  const reopened = new DataStore(root); await reopened.initialize();
  const preferences = new PreferencesStore(root); await preferences.initialize();
  const folder = new FolderStorage(reopened, preferences); await folder.initialize();
  assert.equal(reopened.engine.deviceId, old.engine.deviceId);
  assert.equal(parseWorkspace(JSON.parse(await readFile(folder.ownFile, 'utf8'))).tasks[0].values.title, '旧版本任务');
});
test('two folder replicas merge offline edits and deletion without sharing a device identity', async t => {
  const a = await device(t); const b = await device(t);
  assert.notEqual(a.local.engine.deviceId, b.local.engine.deviceId);
  await a.folder.update(engine => engine.apply({ type: 'task.add', title: '共同任务', listId: 'inbox' }));
  await transfer(a.folder, b.folder); await b.folder.refresh();
  const id = a.local.engine.state.tasks[0].id;
  await a.folder.update(engine => engine.apply({ type: 'task.update', id, patch: { title: 'A 修改标题' } }));
  await b.folder.update(engine => engine.apply({ type: 'task.update', id, patch: { notes: 'B 的离线备注' } }));
  await Promise.all([transfer(a.folder, b.folder), transfer(b.folder, a.folder)]);
  await Promise.all([a.folder.refresh(), b.folder.refresh()]);
  assert.deepEqual(a.local.engine.state, b.local.engine.state);
  assert.equal(a.local.engine.state.tasks[0].values.notes, 'B 的离线备注');
  assert.equal(a.local.engine.state.tasks[0].values.title, 'A 修改标题');
  await a.folder.update(engine => engine.apply({ type: 'task.update', id, patch: { deleted: true } }));
  await b.folder.update(engine => engine.apply({ type: 'task.update', id, patch: { important: true } }));
  await Promise.all([transfer(a.folder, b.folder), transfer(b.folder, a.folder)]);
  await Promise.all([a.folder.refresh(), b.folder.refresh()]);
  assert.deepEqual(a.local.engine.state, b.local.engine.state);
  assert.equal(b.local.engine.state.tasks[0].values.deleted, true);
});
test('changing path preserves source files, merges destination tasks and survives restart', async t => {
  const a = await device(t); const b = await device(t);
  await a.folder.update(engine => engine.apply({ type: 'task.add', title: '来自原目录', listId: 'inbox' }));
  await b.folder.update(engine => engine.apply({ type: 'task.add', title: '来自新目录', listId: 'inbox' }));
  const sourceFile = a.folder.ownFile; const original = await readFile(sourceFile, 'utf8');
  await a.folder.changeDirectory(b.folder.directory);
  assert.equal(a.local.engine.state.tasks.length, 2);
  assert.equal(await readFile(sourceFile, 'utf8'), original);
  assert.equal((await readdir(b.folder.directory)).filter(file => file.endsWith('.json')).length, 2);
  const preferences = new PreferencesStore(a.root); await preferences.initialize();
  const local = new DataStore(a.root); await local.initialize();
  const restarted = new FolderStorage(local, preferences); await restarted.initialize();
  assert.equal(restarted.directory, b.folder.directory); assert.equal(local.engine.state.tasks.length, 2);
});
test('unavailable directory preserves edits in the local cache and resumes after recovery', async t => {
  const a = await device(t); const missing = path.join(a.root, 'not-yet-available');
  await a.preferences.update(value => { value.dataPath = missing; });
  await a.folder.update(engine => engine.apply({ type: 'task.add', title: '断开路径时记录', listId: 'inbox' }));
  assert.match(a.folder.status.error!, /暂时不可用/);
  await assert.rejects(stat(missing));
  const cache = new DataStore(a.root); await cache.initialize(); assert.equal(cache.engine.state.tasks.length, 1);
  await mkdir(missing); await a.folder.refresh();
  assert.equal(a.folder.status.error, null);
  assert.equal(parseWorkspace(JSON.parse(await readFile(a.folder.ownFile, 'utf8'))).tasks[0].values.title, '断开路径时记录');
});
test('a partial incoming file is never overwritten and cannot discard a local edit', async t => {
  const a = await device(t); const incoming = path.join(a.folder.directory, 'device-other.json');
  await writeFile(incoming, '{partial');
  await a.folder.update(engine => engine.apply({ type: 'task.add', title: '需要保留的本地任务', listId: 'inbox' }));
  assert.match(a.folder.status.error!, /尚未完整同步/);
  assert.equal(await readFile(incoming, 'utf8'), '{partial');
  assert.equal(a.local.engine.state.tasks.length, 1);
  await writeFile(incoming, JSON.stringify(new WorkspaceEngine('peer').state));
  await a.folder.refresh(); assert.equal(a.folder.status.error, null);
  assert.equal(parseWorkspace(JSON.parse(await readFile(a.folder.ownFile, 'utf8'))).tasks.length, 1);
});
test('rejecting an invalid destination leaves the original path and files unchanged', async t => {
  const a = await device(t); const destination = await temporaryDirectory(t);
  await writeFile(path.join(destination, 'device-bad.json'), '{"schemaVersion":99}');
  const originalPath = a.folder.directory; const original = await readFile(a.folder.ownFile, 'utf8');
  await assert.rejects(a.folder.changeDirectory(destination), /格式损坏/);
  assert.equal(a.folder.directory, originalPath); assert.equal(await readFile(a.folder.ownFile, 'utf8'), original);
  assert.deepEqual(await readdir(destination), ['device-bad.json']);
});
test('unchanged refreshes do not rewrite files or generate a cloud sync feedback loop', async t => {
  const a = await device(t); await a.folder.update(engine => engine.apply({ type: 'task.add', title: '保持不变', listId: 'inbox' }));
  await a.folder.refresh(); const before = await stat(a.folder.ownFile);
  await a.folder.refresh(); await a.folder.refresh();
  assert.equal((await stat(a.folder.ownFile)).mtimeMs, before.mtimeMs);
});
test('path changes and task writes are serialized without losing either task', async t => {
  const a = await device(t); const destination = await temporaryDirectory(t);
  await Promise.all([
    a.folder.update(engine => engine.apply({ type: 'task.add', title: '切换前', listId: 'inbox' })),
    a.folder.changeDirectory(destination),
    a.folder.update(engine => engine.apply({ type: 'task.add', title: '切换后', listId: 'inbox' })),
  ]);
  assert.equal(a.folder.directory, destination);
  assert.equal(parseWorkspace(JSON.parse(await readFile(a.folder.ownFile, 'utf8'))).tasks.length, 2);
});
test('client conflict-copy files are merged while temp files are ignored', async t => {
  const a = await device(t); const peer = new WorkspaceEngine('peer');
  peer.apply({ type: 'task.add', title: '冲突副本里的任务', listId: 'inbox' });
  await writeFile(path.join(a.folder.directory, 'device-peer (PC conflict).json'), JSON.stringify(peer.state));
  await writeFile(path.join(a.folder.directory, 'device-peer.json.tmp'), '{partial');
  await a.folder.refresh(); assert.equal(a.folder.status.error, null);
  assert.equal(a.local.engine.state.tasks[0].values.title, '冲突副本里的任务');
});
