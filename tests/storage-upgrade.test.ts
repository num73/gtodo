import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir, writeFile, mkdir, stat, unlink, symlink } from 'node:fs/promises';
import { DataStore } from '../electron/storage';
import { FolderStorage } from '../electron/folder-storage';
import { DocumentFiles } from '../electron/document-files';
import { PreferencesStore } from '../electron/preferences';
import { SnapshotFiles, recordParts, contentHash } from '../electron/snapshot-files';
import { withBackupArchive } from '../electron/backup-archive';
import { WorkspaceEngine, mergeWorkspaces } from '../src/shared/engine';
import { emptyWorkspace, parseWorkspace } from '../src/shared/model';
import { documentHistory } from '../src/shared/document-history';
import { patchUserPreferences } from '../src/shared/preferences';
import { documentParts, sharedAssetPath } from '../src/shared/documents';
import { temporaryDirectory, transferSnapshot } from './helpers';
import { ZipFile } from 'yazl';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

async function device(t: TestContext) {
  const root = await temporaryDirectory(t), local = new DataStore(root), preferences = new PreferencesStore(root);
  await local.initialize(); await preferences.initialize(); let events = 0;
  const folder = new FolderStorage(local, preferences, () => events++, new DocumentFiles(root, { settleMs: 0 })); await folder.initialize();
  return { root, local, folder, preferences, events: () => events };
}
function seed() { const engine = new WorkspaceEngine('seed'); engine.apply({ type: 'note.add', content: '初稿' }); return engine; }

test('concurrent document versions converge, remain selectable and resolve explicitly without losing either body', () => {
  const base = seed(), target = { kind: 'note' as const, id: base.state.notes[0].id };
  const a = new WorkspaceEngine('A', base.state), b = new WorkspaceEngine('B', base.state);
  a.apply({ type: 'note.update', id: target.id, patch: { content: '甲的修改' } }); b.apply({ type: 'note.update', id: target.id, patch: { content: '乙的修改' } });
  assert.deepEqual(mergeWorkspaces(a.state, b.state), mergeWorkspaces(b.state, a.state));
  a.merge(b.state); const history = documentHistory(a.state, target); assert.equal(history.heads.length, 2);
  a.restoreDocumentVersion(target, history.versions.find(item => item.content === '甲的修改')!.id);
  assert.equal(a.state.notes[0].values.content, '甲的修改'); assert.equal(documentHistory(a.state, target).heads.length, 1);
  a.merge(b.state); assert.equal(documentHistory(a.state, target).heads.length, 1);
  assert.ok(documentHistory(a.state, target).versions.some(item => item.content === '乙的修改'));
});

test('independent body and attachment edits produce a distinct merged version and preserve both sources', () => {
  const base = seed(), id = base.state.notes[0].id, a = new WorkspaceEngine('A', base.state), b = new WorkspaceEngine('B', base.state);
  a.apply({ type: 'note.update', id, patch: { content: '正文修改' } });
  b.apply({ type: 'note.update', id, patch: { assets: { 'assets/example.png': `${'a'.repeat(64)}.png` } } });
  const ab = mergeWorkspaces(a.state, b.state); parseWorkspace(ab);
  assert.deepEqual(ab, mergeWorkspaces(b.state, a.state)); assert.deepEqual(ab, mergeWorkspaces(ab, b.state));
  assert.equal(ab.notes[0].values.content, '正文修改'); assert.equal(Object.keys(ab.notes[0].values.assets).length, 1);
  assert.equal(documentHistory(ab, { kind: 'note', id }).heads.length, 1);
});

test('removing the final attachment from an empty body leaves a restorable empty version', () => {
  const engine = new WorkspaceEngine('local'); engine.apply({ type: 'note.add' }); const id = engine.state.notes[0].id;
  engine.apply({ type: 'note.update', id, patch: { assets: { 'assets/example.png': `${'a'.repeat(64)}.png` } } });
  engine.apply({ type: 'note.update', id, patch: { assets: {} } });
  const history = documentHistory(engine.state, { kind: 'note', id });
  assert.equal(history.versions.length, 2); assert.equal(history.heads.length, 1); assert.deepEqual(history.versions[0].assets, {});
});

test('history retains the last fifty revisions and unresolved old forks; purge removes all retained text', () => {
  const a = seed(), id = a.state.notes[0].id, b = new WorkspaceEngine('offline', a.state);
  b.apply({ type: 'note.update', id, patch: { content: '旧设备的独立修改' } }); a.merge(b.state);
  a.restoreDocumentVersion({ kind: 'note', id }, a.state.documentRevisions.find(value => value.content === '初稿')!.id);
  const fork = new WorkspaceEngine('fork', a.state); fork.apply({ type: 'note.update', id, patch: { content: '需要保留的分支' } });
  for (let i = 0; i < 70; i++) a.apply({ type: 'note.update', id, patch: { content: `修改 ${i}` } });
  assert.equal(a.state.documentRevisions.length, 50); a.merge(fork.state);
  assert.ok(a.state.documentRevisions.some(item => item.content === '需要保留的分支'));
  const old = structuredClone(a.state); a.apply({ type: 'note.update', id, patch: { deleted: true } });
  a.purge([{ kind: 'note', id, clock: a.state.notes[0].clocks.deleted }]); a.merge(old);
  assert.deepEqual(a.state.documentRevisions, []);
});

test('schema one migrates with its exact original backup, stable identity and recoverable linked views', async t => {
  const root = await temporaryDirectory(t), engine = seed(); engine.apply({ type: 'note.notebook', id: engine.state.notes[0].id, mode: 'link' });
  const { documentRevisions: _, ...old } = engine.state;
  const deviceId = crypto.randomUUID(), original = JSON.stringify({ deviceId, workspace: { ...old, schemaVersion: 1 } }, null, 2);
  await writeFile(path.join(root, 'workspace.json'), original);
  const store = new DataStore(root); await store.initialize();
  assert.equal(store.engine.deviceId, deviceId); assert.equal(store.engine.state.schemaVersion, 2);
  assert.equal(store.engine.state.notes[0].values.notebook, 'visible'); assert.equal(store.engine.state.notes[0].values.desktop, 'visible');
  const migrations = (await readdir(path.join(root, 'history'))).filter(name => name.startsWith('migration-'));
  assert.equal(migrations.length, 1); assert.equal(await readFile(path.join(root, 'history', migrations[0]), 'utf8'), original);
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).workspace.format, 'gtodo-records');
  const reopened = new DataStore(root); await reopened.initialize(); assert.deepEqual(reopened.engine.state, store.engine.state);
});

test('failed migration and unknown future formats never replace the original with an older backup', async t => {
  const root = await temporaryDirectory(t), file = path.join(root, 'workspace.json');
  const original = JSON.stringify({ deviceId: crypto.randomUUID(), workspace: { ...emptyWorkspace(), schemaVersion: 1 } });
  await writeFile(file, original); await writeFile(path.join(root, 'history'), 'occupied');
  await assert.rejects(new DataStore(root).initialize()); assert.equal(await readFile(file, 'utf8'), original);
  await writeFile(`${file}.bak`, original);
  const future = JSON.stringify({ deviceId: crypto.randomUUID(), workspace: { schemaVersion: 99 } }); await writeFile(file, future);
  await assert.rejects(new DataStore(root).initialize(), /较新版本/); assert.equal(await readFile(file, 'utf8'), future);
});

test('record sharding reuses unchanged blocks and idle refreshes do no file reads, writes or notifications', async t => {
  const f = await device(t);
  await f.folder.update(engine => { for (let i = 0; i < 30; i++) engine.apply({ type: 'task.add', title: `任务 ${i}`, listId: 'inbox' }); });
  const original = JSON.parse(await readFile(f.folder.ownFile, 'utf8'));
  const first = original.records.tasks[0], file = path.join(f.folder.directory, ...recordParts(first)), time = (await stat(file)).mtimeMs;
  await f.folder.update(engine => engine.apply({ type: 'task.update', id: engine.state.tasks[5].id, patch: { title: '只改一项' } }));
  const next = JSON.parse(await readFile(f.folder.ownFile, 'utf8'));
  assert.equal(next.records.tasks.filter((hash: string) => !original.records.tasks.includes(hash)).length, 1);
  assert.equal((await stat(file)).mtimeMs, time);
  await f.folder.refresh(); await f.folder.refresh();
  const reads = [f.folder.fileCache.reads, f.folder.snapshots.cache.reads, f.folder.documents.files.reads], events = f.events(), saved = (await stat(f.folder.ownFile)).mtimeMs;
  await f.folder.refresh(); await f.folder.refresh();
  assert.deepEqual([f.folder.fileCache.reads, f.folder.snapshots.cache.reads, f.folder.documents.files.reads], reads);
  assert.equal(f.events(), events); assert.equal((await stat(f.folder.ownFile)).mtimeMs, saved);
});

test('incomplete remote blocks pause merging; all offline edits survive when missing blocks arrive', async t => {
  const a = await device(t), b = await device(t);
  await a.folder.update(engine => engine.apply({ type: 'note.add', content: '远端正文' }));
  const manifest = await readFile(a.folder.ownFile); await writeFile(path.join(b.folder.directory, path.basename(a.folder.ownFile)), manifest);
  await b.folder.refresh(); assert.match(b.folder.status.error!, /尚未完整同步/);
  await b.folder.update(engine => engine.apply({ type: 'task.add', title: '离线新增', listId: 'inbox' }));
  await transferSnapshot(a.folder.ownFile, b.folder.directory); await b.folder.refresh(true);
  assert.equal(b.folder.status.error, null); assert.equal(b.local.engine.state.tasks[0].values.title, '离线新增'); assert.equal(b.local.engine.state.notes[0].values.content, '远端正文');
  const parsed = JSON.parse(manifest.toString()), block = path.join(b.folder.directory, ...recordParts(parsed.records.notes[0])); await writeFile(block, '{invalid');
  await b.folder.refresh(true); assert.match(b.folder.status.error!, /尚未完整同步/); assert.equal(await readFile(block, 'utf8'), '{invalid');
});

test('settings recover their backup and a missing main plus corrupt backup fails closed', async t => {
  const f = await device(t); await f.preferences.update(value => { value.zoom = 125; }); await f.preferences.update(value => { value.zoom = 150; });
  await writeFile(f.preferences.file, 'broken'); const restored = new PreferencesStore(f.root); await restored.initialize(); assert.equal(restored.value.zoom, 125);
  await unlink(restored.file); await writeFile(`${restored.file}.bak`, 'broken'); await assert.rejects(new PreferencesStore(f.root).initialize(), /备份无法读取/);
});

test('rolling backup retention is bounded and a damaged primary plus bak recovers from retained history', async t => {
  const f = await device(t);
  await f.folder.update(engine => engine.apply({ type: 'note.add', content: '历史备份中的完整正文' }));
  const snapshot = await readFile(f.local.file), history = path.join(f.root, 'history');
  for (let i = 1; i <= 28; i++) {
    const day = `202001${String(i).padStart(2, '0')}`;
    await writeFile(path.join(history, `hour-${day}T00.json`), snapshot);
    await writeFile(path.join(history, `day-${day}.json`), snapshot);
  }
  await f.local.update(engine => engine.apply({ type: 'note.update', id: engine.state.notes[0].id, patch: { title: '新的名称' } }));
  const retained = await readdir(history);
  assert.equal(retained.filter(name => name.startsWith('hour-')).length, 24); assert.equal(retained.filter(name => name.startsWith('day-')).length, 7);
  await writeFile(f.local.file, '{broken'); await writeFile(`${f.local.file}.bak`, '{broken');
  const reopened = new DataStore(f.root); await reopened.initialize();
  assert.match(reopened.notice!, /备份恢复/); assert.equal(reopened.engine.state.notes[0].values.content, '历史备份中的完整正文');
  assert.equal(reopened.engine.deviceId, f.local.engine.deviceId);
});

test('purge scrubs rolling and migration backups and frees shared record blocks, without reviving from stale history', async t => {
  const f = await device(t); await f.folder.update(engine => engine.apply({ type: 'note.add', content: 'PURGE_PRIVATE_TEXT' }));
  const snapshot = structuredClone(f.local.engine.state), note = snapshot.notes[0];
  const migration = path.join(f.root, 'history', 'migration-test.json');
  await writeFile(migration, JSON.stringify({ deviceId: f.local.engine.deviceId, workspace: snapshot }));
  await writeFile(`${f.folder.ownFile}.v1.bak`, JSON.stringify(snapshot));
  await f.folder.update(engine => engine.apply({ type: 'note.update', id: note.id, patch: { deleted: true } }));
  const result = await f.folder.purgeTrash((await f.folder.getTrash()).items); assert.equal(result.error, null);
  for (const backup of await f.local.backupWorkspaces()) { assert.equal(backup.notes.length, 0); assert.equal(backup.documentRevisions.length, 0); }
  assert.equal((await readFile(`${f.folder.ownFile}.v1.bak`, 'utf8')).includes('PURGE_PRIVATE_TEXT'), false);
  for (const root of [f.root, f.folder.directory]) for (const prefix of await readdir(path.join(root, 'records'))) for (const name of await readdir(path.join(root, 'records', prefix))) {
    assert.equal((await readFile(path.join(root, 'records', prefix, name), 'utf8')).includes('PURGE_PRIVATE_TEXT'), false);
  }
  await f.folder.importBackup(snapshot, {}); assert.equal(f.local.engine.state.notes.length, 0);
});

test('default list purge survives restart and cannot be restored through a preference patch', async t => {
  const f = await device(t);
  await f.preferences.update(value => { value.user = patchUserPreferences(value.user, { inboxVisible: false }); });
  await f.preferences.update(value => { value.user = patchUserPreferences(value.user, { inboxPurged: true }); });
  const reopened = new PreferencesStore(f.root); await reopened.initialize();
  assert.equal(reopened.value.user.inboxPurged, true); assert.equal(reopened.value.user.inboxVisible, false);
  assert.throws(() => patchUserPreferences(reopened.value.user, { inboxVisible: true }), /永久删除/);
  assert.throws(() => patchUserPreferences(reopened.value.user, { inboxPurged: false }), /永久删除/);
  await writeFile(reopened.file, '{broken'); const recovered = new PreferencesStore(f.root); await recovered.initialize(); assert.equal(recovered.value.user.inboxPurged, true);
});

test('ZIP backup restores records, history and deduplicated binary images with readable Markdown', async t => {
  const f = await device(t), image = await readFile(path.resolve('assets/icon.png'));
  await f.folder.update(engine => engine.apply({ type: 'note.add', content: '最初正文' }));
  const target = { kind: 'note' as const, id: f.local.engine.state.notes[0].id }, relative = await f.folder.addImage(target, image);
  await f.folder.update(engine => engine.apply({ type: 'note.update', id: target.id, patch: { content: `![图片](${relative})` } }));
  await f.folder.addBoardImage({ destination: 'background' }, image, '相同图片');
  assert.equal((await readdir(path.join(f.folder.directory, 'assets'))).length, 1);
  const file = path.join(f.root, 'backup.zip'); await f.folder.exportBackupTo(file);
  assert.equal((await readFile(file)).subarray(0, 2).toString(), 'PK');
  await withBackupArchive(file, f.root, async (workspace, images) => {
    assert.equal(images.length, 1); assert.deepEqual(await readFile(images[0].file), image);
    assert.ok(workspace.documentRevisions.some(item => item.content === '最初正文'));
    const root = path.dirname(path.dirname(images[0].file));
    const md = path.join(root, ...documentParts(target), 'note.md');
    assert.match(await readFile(md, 'utf8'), /图片/); assert.deepEqual(await readFile(path.resolve(path.dirname(md), relative)), image);
  });
  const other = await device(t); await other.folder.importArchive(file);
  assert.equal(other.folder.status.error, null); assert.equal(other.local.engine.state.notes[0].values.content, `![图片](${relative})`);
  assert.deepEqual(await readdir(path.join(f.root, 'imports')), []);
});

async function badArchive(file: string, name: string, content: string) { const zip = new ZipFile(), complete = pipeline(zip.outputStream, createWriteStream(file)); zip.addBuffer(Buffer.from(content), name); zip.end(); await complete; }
test('invalid and tampered ZIP imports leave current state intact and remove private staging directories', async t => {
  const f = await device(t), file = path.join(f.root, 'bad.zip');
  await f.folder.update(engine => engine.apply({ type: 'note.add', content: '保留内容' })); const before = structuredClone(f.local.engine.state);
  for (const [name, text] of [['unrelated.txt', 'bad'], ['backup.json', '{}'], [`records/aa/${'a'.repeat(64)}.json`, '{}']]) {
    await badArchive(file, name, text); await assert.rejects(f.folder.importArchive(file));
    assert.deepEqual(f.local.engine.state, before); assert.deepEqual(await readdir(path.join(f.root, 'imports')), []);
  }
  const name = 'documents/notes/note-example/note.md', data = Buffer.from('unexpected bytes'), zip = new ZipFile();
  const complete = pipeline(zip.outputStream, createWriteStream(file));
  zip.addBuffer(data, name);
  zip.addBuffer(Buffer.from(JSON.stringify({ format: 'gtodo-backup', version: 2, createdAt: new Date().toISOString(), snapshot: await new SnapshotFiles().encode(emptyWorkspace(), f.root), files: { [name]: { bytes: data.length, sha256: contentHash('expected bytes') } } })), 'backup.json');
  zip.end(); await complete;
  await assert.rejects(f.folder.importArchive(file), /校验失败/); assert.deepEqual(f.local.engine.state, before);
  assert.deepEqual(await readdir(path.join(f.root, 'imports')), []);
});

test('history image requests use their original bytes even after a mutable external image changes', async t => {
  const f = await device(t), image = await readFile(path.resolve('assets/icon.png'));
  await f.folder.update(engine => engine.apply({ type: 'note.add', content: '图片' })); const target = { kind: 'note' as const, id: f.local.engine.state.notes[0].id };
  const id = await f.folder.documents.cacheImage(image);
  await f.folder.update(engine => engine.apply({ type: 'note.update', id: target.id, patch: { content: '![图](assets/image.png)', assets: { 'assets/image.png': id } } }));
  const next = await f.folder.documents.cacheImage(Buffer.concat([image, Buffer.from('new')]));
  await f.folder.update(engine => engine.apply({ type: 'note.update', id: target.id, patch: { assets: { 'assets/image.png': next } } }));
  assert.deepEqual((await f.folder.documents.readImage(f.folder.directory, f.local.engine.state, target, 'assets/image.png', id)).bytes, image);
});
