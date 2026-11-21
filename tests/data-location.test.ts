import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, readdir, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { temporaryDirectory } from './helpers';
import { PreferencesStore } from '../electron/preferences';
import { prepareDataLocation } from '../electron/data-location';
import { FolderStorage } from '../electron/folder-storage';
import { DataStore } from '../electron/storage';
import { DocumentFiles } from '../electron/document-files';
import { collectRecordGarbage, RECORD_GRACE_MS, withRecordWrite } from '../electron/record-gc';
import { contentHash, recordParts, SnapshotFiles } from '../electron/snapshot-files';
import { WorkspaceEngine } from '../src/shared/engine';
import { PomodoroTimer } from '../electron/pomodoro';

test('business content exists only in the selected directory, and opening empty directories does not bring it back', async t => {
  const root = await temporaryDirectory(t), profile = path.join(root, 'profile'), data = path.join(root, 'data');
  await mkdir(profile); const preferences = new PreferencesStore(profile); await preferences.initialize();
  const local = await prepareDataLocation(preferences, data), folder = new FolderStorage(local, preferences); await folder.initialize();
  await folder.update(engine => { engine.apply({ type: 'task.add', title: 'private-task-sentinel', listId: 'inbox' }); engine.apply({ type: 'notebook.add', title: 'private-note-sentinel' }); });
  const id = folder.local.engine.state.notes[0].id;
  await preferences.update(value => { value.noteWindows[id] = { open: true, pinned: false }; });
  assert.deepEqual((await readdir(profile)).sort(), ['preferences.json', 'preferences.json.bak']);
  for (const name of await readdir(profile)) { const text = await readFile(path.join(profile, name), 'utf8'); assert.ok(!text.includes('private-')); assert.ok(!text.includes(id)); }
  const original = folder.directory, empty = path.join(root, 'empty'); await mkdir(empty);
  await folder.changeDirectory(empty); assert.equal(folder.local.engine.state.tasks.length, 0); assert.equal(folder.local.engine.state.notes.length, 0);
  assert.deepEqual(preferences.value.noteWindows, {});
  const reopenedPreferences = new PreferencesStore(profile); await reopenedPreferences.initialize();
  const reopened = await prepareDataLocation(reopenedPreferences, data); assert.equal(reopened.engine.state.tasks.length, 0);
  await folder.changeDirectory(original); assert.equal(folder.local.engine.state.tasks[0].values.title, 'private-task-sentinel'); assert.equal(preferences.value.noteWindows[id].open, true);
  // Deleting the active directory must not be undone by a refresh or save.
  assert.ok(path.relative(root, original) && !path.relative(root, original).startsWith('..'));
  await rm(original, { recursive: true }); await folder.refresh(true);
  assert.match(folder.status.error!, /移除或替换/);
  await assert.rejects(folder.update(engine => engine.apply({ type: 'task.add', title: 'unsaved', listId: 'inbox' })), /移除或替换/);
  await assert.rejects(stat(original), { code: 'ENOENT' });
  await folder.changeDirectory(empty); assert.equal(folder.local.engine.state.tasks.length, 0);
  await assert.rejects(folder.changeDirectory(profile), /配置目录/);
});

test('upgrade verifies and relocates legacy data, images, backups and timer records then removes profile copies', async t => {
  const root = await temporaryDirectory(t), profile = path.join(root, 'profile'), data = path.join(root, 'selected'); await mkdir(profile);
  const old = new DataStore(profile); await old.initialize();
  await old.update(engine => { engine.apply({ type: 'task.add', title: 'legacy-private-title', listId: 'inbox' }); engine.apply({ type: 'note.add', title: 'legacy-note', content: 'legacy-private-body' }); });
  const id = old.engine.state.notes[0].id;
  const documents = new DocumentFiles(profile), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const image = await documents.cacheImage(png);
  const timer = new PomodoroTimer({ directory: profile, task: () => ({ id: 'timer-task', title: 'timer-private-title' }) }); await timer.initialize(); await timer.command({ type: 'select', taskId: 'timer-task' });
  const preferences = new PreferencesStore(profile); await preferences.initialize(); await preferences.update(value => { value.noteWindows[id] = { open: true, pinned: true }; });
  const oldFolder = new FolderStorage(old, preferences); await oldFolder.initialize();
  const migrated = await prepareDataLocation(preferences, data);
  assert.equal(migrated.engine.deviceId, old.engine.deviceId); assert.equal(migrated.engine.state.tasks[0].values.title, 'legacy-private-title');
  assert.equal(migrated.engine.state.notes[0].values.content, 'legacy-private-body');
  assert.deepEqual(await readFile(path.join(data, 'assets', image)), png);
  assert.match(await readFile(path.join(migrated.directory, 'pomodoro.json'), 'utf8'), /timer-private-title/);
  assert.equal(preferences.value.noteWindows[id].open, true);
  assert.deepEqual((await readdir(profile)).sort(), ['preferences.json', 'preferences.json.bak']);
  for (const name of await readdir(profile)) assert.ok(!(await readFile(path.join(profile, name), 'utf8')).includes(id));
  await assert.rejects(stat(path.join(profile, 'data')), { code: 'ENOENT' });
  const next = await prepareDataLocation(preferences, data); assert.equal(next.engine.state.tasks.length, 1);
});

test('missing selected directory starts empty and is not recreated from old migration backups', async t => {
  const root = await temporaryDirectory(t), profile = path.join(root, 'profile'), data = path.join(root, 'data'); await mkdir(profile);
  const preferences = new PreferencesStore(profile); await preferences.initialize();
  const store = await prepareDataLocation(preferences, data); await store.update(engine => engine.apply({ type: 'notebook.add', title: 'previous' }));
  assert.ok(path.relative(root, data) && !path.relative(root, data).startsWith('..')); await rm(data, { recursive: true });
  const next = await prepareDataLocation(preferences, data);
  assert.equal(next.engine.state.notes.length, 0); await assert.rejects(next.update(() => {}), /移除或替换/); await assert.rejects(stat(data), { code: 'ENOENT' });
});

test('invalid legacy data stops migration without deleting the source files', async t => {
  const root = await temporaryDirectory(t), profile = path.join(root, 'profile'); await mkdir(profile); await writeFile(path.join(profile, 'workspace.json'), '{broken');
  const preferences = new PreferencesStore(profile); await preferences.initialize();
  await assert.rejects(prepareDataLocation(preferences, path.join(root, 'data')), /迁移未完成/);
  assert.equal(await readFile(path.join(profile, 'workspace.json'), 'utf8'), '{broken'); assert.notEqual(preferences.value.storageVersion, 3);
});

test('ordinary superseded blocks are collected after an observed grace period while live and backup blocks survive', async t => {
  const root = await temporaryDirectory(t), id = crypto.randomUUID(), snapshots = new SnapshotFiles();
  const engine = new WorkspaceEngine(id); engine.apply({ type: 'task.add', title: 'old', listId: 'inbox' });
  const previous = await snapshots.encode(engine.state, root), oldHash = previous.records.tasks[0];
  engine.apply({ type: 'task.update', id: engine.state.tasks[0].id, patch: { title: 'new' } });
  const current = await snapshots.encode(engine.state, root); await writeFile(path.join(root, `device-${id}.json`), JSON.stringify(current));
  const orphan = await snapshots.encode({ ...engine.state, tasks: [{ ...engine.state.tasks[0], values: { ...engine.state.tasks[0].values, title: 'unknown-old-upload' } }] }, root);
  const uploadHash = orphan.records.tasks[0];
  const time = Date.now(); await utimes(path.join(root, ...recordParts(uploadHash)), new Date(0), new Date(0));
  const first = await collectRecordGarbage(root, id, { now: time }); assert.equal(first.freedBytes, 0); assert.equal(first.pendingFiles, 2);
  // A retained backup pins the old block beyond the grace period.
  const history = path.join(root, '.gtodo', 'devices', id, 'history'); await mkdir(history, { recursive: true });
  await writeFile(path.join(history, 'day-20260101.json'), JSON.stringify({ deviceId: id, workspace: previous }));
  const second = await collectRecordGarbage(root, id, { now: time + RECORD_GRACE_MS + 1000 });
  assert.ok(second.freedBytes > 0); await stat(path.join(root, ...recordParts(oldHash))); await stat(path.join(root, ...recordParts(current.records.tasks[0])));
  await assert.rejects(stat(path.join(root, ...recordParts(uploadHash))), { code: 'ENOENT' });
});

test('garbage collection skips writers and incomplete indexes', async t => {
  const root = await temporaryDirectory(t), id = crypto.randomUUID();
  const orphan = Buffer.from('{"old":"record"}'), hash = contentHash(orphan), file = path.join(root, ...recordParts(hash)); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, orphan);
  const now = Date.now(); await collectRecordGarbage(root, id, { now });
  await withRecordWrite(root, id, async () => { assert.equal((await collectRecordGarbage(root, id, { now: now + RECORD_GRACE_MS + 1000 })).freedBytes, 0); });
  // A future clock in the test must not make an active writer look expired.
  await writeFile(path.join(root, 'device-partial.json'), '{');
  await assert.rejects(collectRecordGarbage(root, id, { now: now + RECORD_GRACE_MS + 1000 })); await stat(file);
});

test('references that return cancel the old collection deadline, and other device backups pin blocks', async t => {
  const root = await temporaryDirectory(t), id = crypto.randomUUID(), peer = crypto.randomUUID(), engine = new WorkspaceEngine(id);
  engine.apply({ type: 'task.add', title: 'retained', listId: 'inbox' });
  const manifest = await new SnapshotFiles().encode(engine.state, root), file = path.join(root, ...recordParts(manifest.records.tasks[0]));
  const now = Date.now(); await collectRecordGarbage(root, id, { now });
  const index = path.join(root, `device-${peer}.json`); await writeFile(index, JSON.stringify(manifest));
  await collectRecordGarbage(root, id, { now: now + RECORD_GRACE_MS + 1000 }); await stat(file);
  await unlink(index);
  assert.equal((await collectRecordGarbage(root, id, { now: now + 2 * RECORD_GRACE_MS })).freedBytes, 0, 'fresh observation restarts the entire grace period');
  const backup = path.join(root, '.gtodo', 'devices', peer, 'workspace.json.bak'); await mkdir(path.dirname(backup), { recursive: true });
  await writeFile(backup, JSON.stringify({ deviceId: peer, workspace: manifest }));
  assert.equal((await collectRecordGarbage(root, id, { now: now + 4 * RECORD_GRACE_MS })).freedBytes, 0); await stat(file);
});

test('a redirected record directory aborts the complete sweep before any unlink', async t => {
  const root = await temporaryDirectory(t), outside = await temporaryDirectory(t), id = crypto.randomUUID();
  const content = Buffer.from('{"orphan":true}'), hash = contentHash(content), file = path.join(root, ...recordParts(hash)); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content);
  const now = Date.now(); await collectRecordGarbage(root, id, { now });
  const prefix = hash.startsWith('ff') ? 'ee' : 'ff'; await symlink(outside, path.join(root, 'records', prefix), 'junction');
  await assert.rejects(collectRecordGarbage(root, id, { now: now + RECORD_GRACE_MS + 1000 }), /链接|联接/); await stat(file);
});

test('invalid target window settings do not change the active directory or close its windows', async t => {
  const root = await temporaryDirectory(t), profile = path.join(root, 'profile'), data = path.join(root, 'data'), target = path.join(root, 'target'); await mkdir(profile); await mkdir(target);
  const preferences = new PreferencesStore(profile); await preferences.initialize(); const local = await prepareDataLocation(preferences, data);
  const folder = new FolderStorage(local, preferences); await folder.initialize(); await folder.update(engine => engine.apply({ type: 'notebook.add', title: 'kept' }));
  const other = await DataStore.open(target, local.engine.deviceId); await writeFile(path.join(other.directory, 'windows.json'), '{broken');
  let closed = false;
  await assert.rejects(folder.changeDirectory(target, async () => { closed = true; }), /窗口设置/);
  assert.equal(closed, false); assert.equal(folder.directory, data); assert.equal(folder.local.engine.state.notes[0].values.title, 'kept');
});

test('future legacy data never falls back to an older backup during directory migration', async t => {
  const root = await temporaryDirectory(t), profile = path.join(root, 'profile'); await mkdir(profile);
  const old = new DataStore(profile); await old.initialize(); await old.update(engine => engine.apply({ type: 'notebook.add', title: 'older' }));
  const saved = JSON.parse(await readFile(old.file, 'utf8')); saved.workspace.version = 99; const future = JSON.stringify(saved); await writeFile(old.file, future);
  const preferences = new PreferencesStore(profile); await preferences.initialize();
  await assert.rejects(prepareDataLocation(preferences, path.join(root, 'data')), /较新版本/);
  assert.equal(await readFile(old.file, 'utf8'), future); assert.notEqual(preferences.value.storageVersion, 3);
});

test('migration resumes after publishing converted data but failing to commit configuration', async t => {
  const root = await temporaryDirectory(t), profile = path.join(root, 'profile'), data = path.join(root, 'data'); await mkdir(profile);
  const old = new DataStore(profile); await old.initialize(); await old.update(engine => engine.apply({ type: 'task.add', title: 'resume-kept', listId: 'inbox' }));
  const preferences = new PreferencesStore(profile); await preferences.initialize();
  await mkdir(preferences.value.dataPath); await writeFile(path.join(preferences.value.dataPath, `device-${old.engine.deviceId}.json`), JSON.stringify(old.engine.state));
  const update = preferences.update.bind(preferences); let fail = true;
  preferences.update = async change => { const probe = structuredClone(preferences.value); change(probe); if (fail && probe.storageVersion === 3) { fail = false; throw new Error('simulated configuration interruption'); } return update(change); };
  await assert.rejects(prepareDataLocation(preferences, data), /simulated/); await stat(old.file);
  const restarted = new PreferencesStore(profile); await restarted.initialize();
  const migrated = await prepareDataLocation(restarted, data);
  assert.equal(migrated.engine.state.tasks[0].values.title, 'resume-kept'); assert.equal(restarted.value.dataPath, data);
  await assert.rejects(stat(old.file), { code: 'ENOENT' });
});
