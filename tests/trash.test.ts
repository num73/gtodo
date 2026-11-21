import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { WorkspaceEngine, mergeWorkspaces } from '../src/shared/engine';
import { emptyWorkspace, parseWorkspace } from '../src/shared/model';
import { trashRecords, trashTargetsSchema } from '../src/shared/trash';
import { documentParts } from '../src/shared/documents';
import { linkedNoteForTask } from '../src/shared/note-links';
import { DataStore } from '../electron/storage';
import { PreferencesStore } from '../electron/preferences';
import { FolderStorage } from '../electron/folder-storage';
import { DocumentFiles } from '../electron/document-files';
import { outlookEvents } from '../electron/outlook-events';
import { temporaryDirectory } from './helpers';

async function device(t: TestContext) {
  const root = await temporaryDirectory(t); const store = new DataStore(root); await store.initialize();
  const preferences = new PreferencesStore(root); await preferences.initialize();
  const documents = new DocumentFiles(root, { settleMs: 0 });
  const folder = new FolderStorage(store, preferences, () => {}, documents); await folder.initialize();
  return { root, store, preferences, folder, documents };
}
const task = (engine: WorkspaceEngine, title = '待清理任务') => { engine.apply({ type: 'task.add', title, listId: 'inbox' }); return engine.state.tasks.at(-1)!; };
const png = () => readFile(path.resolve('assets/icon.png'));

test('legacy data has an empty purge ledger and recycle operations reject invalid identifiers', () => {
  const legacy = { schemaVersion: 1, tasks: [], notes: [], lists: [], steps: [] };
  assert.deepEqual(parseWorkspace(legacy), emptyWorkspace());
  assert.equal(trashTargetsSchema.safeParse([{ kind: 'task', id: '../../outside', clock: { tick: 1, device: 'test' } }]).success, false);
});

test('recycle records include deleted tasks, notes, lists and independent steps; restore keeps documents independent', () => {
  const engine = new WorkspaceEngine('local'); const a = task(engine); const b = task(engine, '保留任务');
  engine.apply({ type: 'step.add', taskId: a.id, title: '随任务一起恢复的步骤' });
  engine.apply({ type: 'step.add', taskId: b.id, title: '单独删除的步骤' });
  engine.apply({ type: 'step.update', id: engine.state.steps[1].id, patch: { deleted: true } });
  engine.apply({ type: 'list.add', name: '空清单', color: 'blue' });
  engine.apply({ type: 'list.update', id: engine.state.lists[0].id, patch: { deleted: true } });
  engine.apply({ type: 'task.update', id: a.id, patch: { notes: '共享正文' } });
  engine.apply({ type: 'task.link-note', id: a.id }); const note = engine.state.notes[0];
  engine.apply({ type: 'task.update', id: a.id, patch: { deleted: true } });
  engine.apply({ type: 'note.update', id: note.id, patch: { deleted: true } });
  assert.deepEqual(trashRecords(engine.state).map(item => item.kind).sort(), ['list', 'note', 'step', 'task']);
  for (const item of trashRecords(engine.state)) engine.restore(item);
  assert.equal(trashRecords(engine.state).length, 0);
  assert.equal(engine.state.tasks[0].values.notes, '共享正文');
  assert.equal(engine.state.notes[0].values.content, '共享正文');
  assert.equal(linkedNoteForTask(engine.state, engine.state.tasks[0]), undefined);
  assert.equal(engine.state.steps.filter(item => !item.values.deleted).length, 2);
});

test('purging a task removes child steps, survives stale merge/import, and remains an explicit Outlook removal', () => {
  const engine = new WorkspaceEngine('local'); const a = task(engine);
  engine.apply({ type: 'step.add', taskId: a.id, title: '步骤正文' });
  const stale = structuredClone(engine.state);
  engine.apply({ type: 'task.update', id: a.id, patch: { deleted: true } });
  engine.purge(trashRecords(engine.state));
  assert.equal(engine.state.tasks.length, 0); assert.equal(engine.state.steps.length, 0);
  assert.deepEqual(outlookEvents(engine.state), [{ id: a.id, event: null }]);
  const remote = new WorkspaceEngine('offline', stale);
  remote.apply({ type: 'task.update', id: a.id, patch: { notes: '离线的更新', deleted: false } });
  remote.apply({ type: 'step.add', taskId: a.id, title: '迟到的步骤' });
  const left = mergeWorkspaces(engine.state, remote.state); const right = mergeWorkspaces(remote.state, engine.state);
  assert.deepEqual(left, right); assert.equal(left.tasks.length, 0); assert.equal(left.steps.length, 0);
  assert.deepEqual(mergeWorkspaces(left, stale), left);
});

test('stale confirmation and active records cannot be permanently deleted; a batch validates before mutating', () => {
  const engine = new WorkspaceEngine('local'); const a = task(engine); const b = task(engine, '另一项');
  for (const id of [a.id, b.id]) engine.apply({ type: 'task.update', id, patch: { deleted: true } });
  const selected = trashRecords(engine.state);
  engine.restore(selected.find(item => item.id === a.id)!);
  const before = structuredClone(engine.state);
  assert.throws(() => engine.purge(selected), /内容已变化/); assert.deepEqual(engine.state, before);
  engine.apply({ type: 'task.update', id: a.id, patch: { deleted: true } });
  assert.throws(() => engine.restore(selected.find(item => item.id === a.id)!), /内容已变化/);
});

test('purge frees actual document, history and private image files and scrubs both local snapshots', async t => {
  const f = await device(t); let id = '';
  await f.folder.update(engine => { id = task(engine).id; engine.apply({ type: 'task.update', id, patch: { notes: 'PRIVATE BODY', notesFormat: 'markdown' } }); });
  const target = { kind: 'task' as const, id }; const relative = await f.folder.addImage(target, await png());
  await f.folder.update(engine => engine.apply({ type: 'task.update', id, patch: { notes: `PRIVATE BODY ![image](${relative})` } }));
  const dir = path.join(f.folder.directory, ...documentParts(target));
  await mkdir(path.join(dir, 'conflicts')); await writeFile(path.join(dir, 'conflicts', 'old.md'), 'PRIVATE HISTORY');
  await f.folder.update(engine => engine.apply({ type: 'task.update', id, patch: { deleted: true } }));
  const report = await f.folder.getTrash(); assert.equal(report.error, null); assert.ok(report.items[0].bytes > 1000);
  const result = await f.folder.purgeTrash(report.items); assert.equal(result.error, null); assert.ok(result.freedBytes > report.items[0].bytes);
  await assert.rejects(stat(dir), { code: 'ENOENT' }); assert.deepEqual(await readdir(path.join(f.root, 'media')), []);
  for (const file of [f.store.file, `${f.store.file}.bak`, f.folder.ownFile]) {
    const text = await readFile(file, 'utf8'); assert.equal(text.includes('PRIVATE BODY'), false, file); assert.equal(text.includes('待清理任务'), false, file);
  }
  assert.equal((await readFile(path.join(f.root, 'document-state.json'), 'utf8')).includes(id), false);
  const reopened = new DataStore(f.root); await reopened.initialize(); assert.equal(reopened.engine.state.tasks.length, 0);
  assert.ok(reopened.engine.state.purged.some(item => item.id === id));
  await writeFile(f.store.file, '{broken');
  const recovered = new DataStore(f.root); await recovered.initialize();
  assert.match(recovered.notice!, /备份恢复/); assert.equal(recovered.engine.state.tasks.length, 0);
  assert.ok(recovered.engine.state.purged.some(item => item.id === id));
});

test('purging either side of a former link preserves surviving text and shared images, including after restart', async t => {
  const f = await device(t); let id = '';
  await f.folder.update(engine => { id = task(engine).id; engine.apply({ type: 'task.update', id, patch: { notesFormat: 'markdown' } }); });
  const relative = await f.folder.addImage({ kind: 'task', id }, await png());
  await f.folder.update(engine => { engine.apply({ type: 'task.update', id, patch: { notes: `共享正文 ![图](${relative})` } }); engine.apply({ type: 'task.link-note', id }); });
  const noteId = f.store.engine.state.notes[0].id;
  await f.folder.update(engine => engine.apply({ type: 'task.update', id, patch: { deleted: true } }));
  assert.equal((await f.folder.purgeTrash((await f.folder.getTrash()).items)).error, null);
  const note = f.store.engine.state.notes[0]; assert.equal(note.id, noteId); assert.match(note.values.content, /共享正文/);
  assert.deepEqual((await f.documents.readImage(f.folder.directory, f.store.engine.state, { kind: 'note', id: noteId }, relative)).bytes, await png());
  assert.match(await readFile(path.join(f.folder.directory, ...documentParts({ kind: 'note', id: noteId }), 'note.md'), 'utf8'), /共享正文/);
  await f.folder.update(engine => engine.apply({ type: 'note.update', id: noteId, patch: { deleted: true } }));
  await f.folder.purgeTrash((await f.folder.getTrash()).items);
  assert.deepEqual(await readdir(path.join(f.root, 'media')), []);
  const reopened = new DataStore(f.root); await reopened.initialize(); assert.equal(reopened.engine.state.notes.length, 0);
});

test('clearing an unrelated note keeps images needed by another trash record', async t => {
  const f = await device(t); let id = '';
  await f.folder.update(engine => { id = task(engine).id; engine.apply({ type: 'task.update', id, patch: { notesFormat: 'markdown' } }); engine.apply({ type: 'note.add', content: '清理这张便签' }); });
  const relative = await f.folder.addImage({ kind: 'task', id }, await png());
  await f.folder.update(engine => { engine.apply({ type: 'task.update', id, patch: { deleted: true } }); engine.apply({ type: 'note.update', id: engine.state.notes[0].id, patch: { deleted: true } }); });
  await f.folder.purgeTrash((await f.folder.getTrash()).items.filter(item => item.kind === 'note'));
  assert.ok((await readdir(path.join(f.root, 'media'))).includes(relative.slice(7)));
  await f.folder.restoreTrash((await f.folder.getTrash()).items[0]); assert.equal(f.store.engine.state.tasks[0].values.deleted, false);
  assert.deepEqual((await f.documents.readImage(f.folder.directory, f.store.engine.state, { kind: 'task', id }, relative)).bytes, await png());
});

test('permanently deleting a linked note keeps the live task document and its image cache', async t => {
  const f = await device(t); let id = '';
  await f.folder.update(engine => { id = task(engine).id; engine.apply({ type: 'task.update', id, patch: { notesFormat: 'markdown' } }); });
  const relative = await f.folder.addImage({ kind: 'task', id }, await png());
  await f.folder.update(engine => { engine.apply({ type: 'task.update', id, patch: { notes: `任务保留的正文 ![图](${relative})` } }); engine.apply({ type: 'task.link-note', id }); });
  await f.folder.update(engine => engine.apply({ type: 'note.update', id: engine.state.notes[0].id, patch: { deleted: true } }));
  await f.folder.purgeTrash((await f.folder.getTrash()).items);
  assert.equal(f.store.engine.state.notes.length, 0);
  assert.match(f.store.engine.state.tasks[0].values.notes, /任务保留的正文/);
  assert.equal(f.store.engine.state.tasks[0].values.noteLink, null);
  assert.deepEqual((await f.documents.readImage(f.folder.directory, f.store.engine.state, { kind: 'task', id }, relative)).bytes, await png());
});

test('unused image cleanup preserves attachments referenced only by the automatic backup', async t => {
  const f = await device(t); let id = '';
  await f.folder.update(engine => { id = task(engine).id; engine.apply({ type: 'task.update', id, patch: { notesFormat: 'markdown' } }); });
  const relative = await f.folder.addImage({ kind: 'task', id }, await png());
  await f.folder.update(engine => engine.apply({ type: 'task.update', id, patch: { notesAssets: {} } }));
  await f.folder.purgeTrash([]);
  assert.ok((await readdir(path.join(f.root, 'media'))).includes(relative.slice(7)));
});

test('unavailable folder prevents permanent deletion and cleanup resumes after a partial file failure', async t => {
  const f = await device(t); let id = '';
  await f.folder.update(engine => { id = task(engine).id; });
  await f.folder.update(engine => engine.apply({ type: 'task.update', id, patch: { deleted: true } }));
  const selection = (await f.folder.getTrash()).items; const original = f.folder.directory;
  await f.preferences.update(value => { value.dataPath = path.join(f.root, 'missing'); });
  await assert.rejects(f.folder.purgeTrash(selection), /不可用/); assert.equal(f.store.engine.state.purged.length, 0);
  await f.preferences.update(value => { value.dataPath = original; });
  const write = f.documents.writeDocuments.bind(f.documents);
  f.documents.writeDocuments = async (...args) => { if (args[1].purged.length) throw new Error('模拟文件被占用'); return write(...args); };
  const failed = await f.folder.purgeTrash(selection); assert.match(failed.error!, /文件尚未清理/);
  assert.equal(f.store.engine.state.tasks.length, 0);
  f.documents.writeDocuments = write;
  assert.ok((await f.folder.getTrash()).residualFiles > 0);
  assert.equal((await f.folder.purgeTrash([])).error, null);
  assert.equal((await f.folder.getTrash()).residualFiles, 0);
});

test('cleanup rejects junctions before unlinking anything and preserves files outside the data folder', async t => {
  const f = await device(t); let id = '';
  await f.folder.update(engine => { id = task(engine).id; });
  const outside = await temporaryDirectory(t); await writeFile(path.join(outside, 'keep.txt'), 'KEEP');
  const dir = path.join(f.folder.directory, ...documentParts({ kind: 'task', id }));
  await symlink(outside, path.join(dir, 'external'), 'junction');
  await f.folder.update(engine => engine.apply({ type: 'task.update', id, patch: { deleted: true } }));
  const selection = trashRecords(f.store.engine.state);
  const result = await f.folder.purgeTrash(selection); assert.match(result.error!, /符号链接|目录联接/);
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'KEEP');
  assert.equal(await readFile(path.join(dir, 'note.md'), 'utf8'), '');
});

test('other device snapshots remain unchanged while stale imports cannot revive purged data', async t => {
  const f = await device(t); let id = '';
  await f.folder.update(engine => { id = task(engine).id; });
  const stale = structuredClone(f.store.engine.state); const text = JSON.stringify(stale);
  const remote = path.join(f.folder.directory, 'device-offline.json'); await writeFile(remote, text);
  await f.folder.update(engine => engine.apply({ type: 'task.update', id, patch: { deleted: true } }));
  await f.folder.purgeTrash((await f.folder.getTrash()).items);
  await f.folder.importBackup(stale, {}); await f.folder.refresh();
  assert.equal(f.store.engine.state.tasks.length, 0); assert.equal(await readFile(remote, 'utf8'), text);
  assert.equal((await f.folder.getTrash()).items.length, 0);
});
