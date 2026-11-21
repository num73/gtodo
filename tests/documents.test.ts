import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, readdir, writeFile, stat, copyFile, symlink, rename } from 'node:fs/promises';
import { DataStore } from '../electron/storage';
import { PreferencesStore } from '../electron/preferences';
import { FolderStorage } from '../electron/folder-storage';
import { DocumentFiles, referencedImages } from '../electron/document-files';
import { commandSchema, parseWorkspace } from '../src/shared/model';
import { assetURL, assetMapSchema, documentParts, documentFileName, normalizeAssetPath, type DocumentTarget } from '../src/shared/documents';
import { FieldDraft, flushMainDrafts, registerMainDraft } from '../src/notes/draft';
import { temporaryDirectory, transferSnapshot } from './helpers';
import { linkedNoteForTask, linkedTaskForNote } from '../src/shared/note-links';

async function device(t: TestContext) {
  const root = await temporaryDirectory(t); const store = new DataStore(root); await store.initialize();
  const preferences = new PreferencesStore(root); await preferences.initialize();
  const documents = new DocumentFiles(root, { settleMs: 0 });
  const folder = new FolderStorage(store, preferences, () => {}, documents); await folder.initialize();
  await folder.update(engine => {
    engine.apply({ type: 'task.add', title: '文档测试', listId: 'inbox' });
    engine.apply({ type: 'note.add', title: '独立便签', content: '纯文本' });
  });
  const task: DocumentTarget = { kind: 'task', id: store.engine.state.tasks[0].id };
  const note: DocumentTarget = { kind: 'note', id: store.engine.state.notes[0].id };
  const file = (target: DocumentTarget, format: 'markdown' = 'markdown') => path.join(folder.directory, ...documentParts(target), documentFileName(format));
  return { root, store, preferences, documents, folder, task, note, file };
}
const png = () => readFile(path.resolve('assets/icon.png'));

test('all workspaces use Markdown without rewriting old text, and unrelated updates preserve image mappings', async t => {
  const f = await device(t); const old = JSON.parse(JSON.stringify(f.store.engine.state));
  for (const item of old.tasks) { delete item.values.notesFormat; delete item.values.notesAssets; delete item.clocks.notesFormat; delete item.clocks.notesAssets; }
  for (const item of old.notes) { delete item.values.format; delete item.values.assets; delete item.clocks.format; delete item.clocks.assets; }
  const migrated = parseWorkspace(old);
  assert.equal(migrated.tasks[0].values.notesFormat, 'markdown'); assert.deepEqual(migrated.notes[0].values.assets, {});
  old.notes[0].values.format = 'text'; old.notes[0].values.content = '# 原有文字\n保留 **符号**';
  assert.equal(parseWorkspace(old).notes[0].values.content, '# 原有文字\n保留 **符号**');
  assert.equal(parseWorkspace(old).notes[0].values.format, 'markdown');
  assert.deepEqual(commandSchema.parse({ type: 'task.update', id: f.task.id, patch: { important: true } }), { type: 'task.update', id: f.task.id, patch: { important: true } });
  assert.deepEqual(commandSchema.parse({ type: 'note.update', id: f.note.id, patch: { color: 'blue' } }), { type: 'note.update', id: f.note.id, patch: { color: 'blue' } });
});

test('an old txt file is read as Markdown, including external edits, and the original file is retained', async t => {
  const f = await device(t);
  assert.equal(await readFile(f.file(f.note), 'utf8'), '纯文本');
  const oldFile = path.join(path.dirname(f.file(f.note)), 'note.txt');
  await rename(f.file(f.note), oldFile);
  const content = '# 标题\n\n```js\nconst a = 1;\n```'; await writeFile(oldFile, content);
  await f.folder.refresh(); await f.folder.refresh();
  assert.equal(f.store.engine.state.notes[0].values.content, content);
  assert.equal(await readFile(`${oldFile}.previous`, 'utf8'), content);
  assert.match(await readFile(f.file(f.note), 'utf8'), /```js/);
  assert.equal((await readdir(path.dirname(f.file(f.note)))).includes('assets'), false);
});

test('external UTF-8 edits are read back after a stable observation, including after restarting GTodo', async t => {
  const f = await device(t);
  await writeFile(f.file(f.note), '外部编辑\n保留换行', 'utf8');
  await f.folder.refresh(); assert.equal(f.store.engine.state.notes[0].values.content, '纯文本');
  assert.equal(await readFile(f.file(f.note), 'utf8'), '外部编辑\n保留换行');
  await f.folder.refresh(); assert.equal(f.store.engine.state.notes[0].values.content, '外部编辑\n保留换行');
  await writeFile(f.file(f.task), '退出期间的修改', 'utf8');
  const reopened = new DataStore(f.root); await reopened.initialize();
  const folder = new FolderStorage(reopened, f.preferences, () => {}, new DocumentFiles(f.root, { settleMs: 0 }));
  await folder.initialize(); await folder.refresh();
  assert.equal(reopened.engine.state.tasks[0].values.notes, '退出期间的修改');
});

test('simultaneous external and app edits retain both versions instead of overwriting an unseen file', async t => {
  const f = await device(t); await writeFile(f.file(f.note), '外部版本');
  await f.folder.update(engine => engine.apply({ type: 'note.update', id: f.note.id, patch: { content: '应用版本' } }));
  assert.equal(f.store.engine.state.notes[0].values.content, '外部版本');
  const conflicts = path.join(path.dirname(f.file(f.note)), 'conflicts');
  const names = await readdir(conflicts);
  assert.equal(await readFile(path.join(conflicts, names[0]), 'utf8'), '应用版本');
  assert.match(f.folder.status.notice!, /同时编辑/);
});

test('local image imports survive folder relocation, Markdown copies and JSON backup restore', async t => {
  const f = await device(t); const image = await png();
  await f.folder.update(engine => engine.apply({ type: 'task.update', id: f.task.id, patch: { notesFormat: 'markdown' } }));
  const relative = await f.folder.addImage(f.task, image);
  await f.folder.update(engine => engine.apply({ type: 'task.update', id: f.task.id, patch: { notes: `![示例](${relative})` } }));
  assert.deepEqual(await readFile(path.join(path.dirname(f.file(f.task, 'markdown')), relative)), image);
  const exported = JSON.parse(await f.folder.exportBackup());
  const newFolder = await temporaryDirectory(t); await f.folder.changeDirectory(newFolder);
  assert.equal(f.folder.local.engine.state.tasks.length, 0);
  await f.folder.importBackup(parseWorkspace(exported), exported.attachments);
  assert.deepEqual(await readFile(path.join(path.dirname(f.file(f.task, 'markdown')), relative)), image);
  await f.folder.update(engine => engine.apply({ type: 'note.update', id: f.note.id, patch: { format: 'markdown', content: engine.state.tasks[0].values.notes, assets: engine.state.tasks[0].values.notesAssets } }));
  assert.deepEqual(await readFile(path.join(path.dirname(f.file(f.note, 'markdown')), relative)), image);
  const backup = JSON.parse(await f.folder.exportBackup());
  const second = await device(t); await second.documents.importAttachments(backup.attachments);
  await second.folder.update(engine => engine.merge(parseWorkspace(backup)));
  assert.deepEqual(await readFile(path.join(second.folder.directory, ...documentParts(f.note), relative)), image);
  assert.equal(second.folder.status.error, null);
});

test('images inserted while a data folder is offline are cached and materialized when the folder returns', async t => {
  const f = await device(t); await f.folder.update(engine => engine.apply({ type: 'note.update', id: f.note.id, patch: { format: 'markdown' } }));
  const offline = path.join(f.root, 'offline-folder'); await f.preferences.update(value => { value.dataPath = offline; });
  const image = await png(); const relative = await f.folder.addImage(f.note, image);
  await f.folder.update(engine => engine.apply({ type: 'note.update', id: f.note.id, patch: { content: `![离线图片](${relative})` } }));
  assert.ok(f.folder.status.error);
  assert.deepEqual((await f.documents.readImage(f.folder.directory, f.store.engine.state, f.note, relative)).bytes, image);
  await mkdir(offline); await f.folder.refresh();
  assert.equal(f.folder.status.error, null);
  assert.deepEqual(await readFile(path.join(offline, ...documentParts(f.note), relative)), image);
  assert.match(await readFile(f.file(f.note, 'markdown'), 'utf8'), /离线图片/);
});

test('invalid UTF-8 documents fail closed and are never replaced by the cached text', async t => {
  const f = await device(t); const invalid = Buffer.from([0xff, 0xfe, 0xfd]);
  await writeFile(f.file(f.note), invalid); await f.folder.refresh();
  assert.ok(f.folder.status.error);
  assert.equal(f.store.engine.state.notes[0].values.content, '纯文本');
  assert.deepEqual(await readFile(f.file(f.note)), invalid);
});

test('external images use relative assets paths and changes are detected without modifying the Markdown body', async t => {
  const f = await device(t); await f.folder.update(engine => engine.apply({ type: 'note.update', id: f.note.id, patch: { format: 'markdown' } }));
  const assets = path.join(path.dirname(f.file(f.note, 'markdown')), 'assets'); await mkdir(assets);
  await writeFile(path.join(assets, '图片.png'), await png());
  const body = '# 图片\n![外部](assets/图片.png)'; await writeFile(f.file(f.note, 'markdown'), body);
  await f.folder.refresh(); await f.folder.refresh();
  const id = f.store.engine.state.notes[0].values.assets['assets/图片.png']; assert.match(id, /^[a-f0-9]{64}\.png$/);
  const modified = Buffer.concat([await png(), Buffer.from('changed')]); await writeFile(path.join(assets, '图片.png'), modified);
  await f.folder.refresh(); await f.folder.refresh();
  assert.notEqual(f.store.engine.state.notes[0].values.assets['assets/图片.png'], id);
  assert.equal(f.store.engine.state.notes[0].values.content, body);
  assert.deepEqual((await f.documents.readImage(f.folder.directory, f.store.engine.state, f.note, 'assets/图片.png')).bytes, modified);
});

test('a remote snapshot can update a document without turning stale materialized files into a newer edit', async t => {
  const first = await device(t); const second = await device(t);
  await transferSnapshot(first.folder.ownFile, second.folder.directory); await second.folder.refresh();
  await first.folder.update(engine => engine.apply({ type: 'note.update', id: first.note.id, patch: { content: '远端新内容' } }));
  await transferSnapshot(first.folder.ownFile, second.folder.directory); await second.folder.refresh();
  const local = second.store.engine.state.notes.find(item => item.id === first.note.id)!;
  assert.equal(local.values.content, '远端新内容');
  assert.deepEqual(local.clocks.content, first.store.engine.state.notes[0].clocks.content);
  assert.equal(await readFile(path.join(second.folder.directory, ...documentParts(first.note), 'note.md'), 'utf8'), '远端新内容');
  const before = (await stat(second.folder.ownFile)).mtimeMs; await second.folder.refresh();
  assert.equal((await stat(second.folder.ownFile)).mtimeMs, before);
});

test('external image filenames preserve Chinese, spaces and literal percent escapes through the media URL', async t => {
  const f = await device(t); await f.folder.update(engine => engine.apply({ type: 'note.update', id: f.note.id, patch: { format: 'markdown' } }));
  const filename = '图片 50% 和%20.png'; const relative = `assets/${filename}`;
  const assets = path.join(path.dirname(f.file(f.note, 'markdown')), 'assets'); await mkdir(assets);
  const bytes = await png(); await writeFile(path.join(assets, filename), bytes);
  const body = `![图片](assets/${encodeURIComponent(filename)})`;
  assert.deepEqual(referencedImages(body), [relative]);
  await writeFile(f.file(f.note, 'markdown'), body); await f.folder.refresh(); await f.folder.refresh();
  assert.equal(f.folder.status.error, null);
  const map = f.store.engine.state.notes[0].values.assets; assert.ok(map[relative]); assetMapSchema.parse(map);
  const url = new URL(assetURL(f.note, relative, map[relative]));
  const decoded = `assets/${decodeURIComponent(url.pathname.split('/').at(-1)!)}`;
  assert.equal(decoded, relative);
  assert.deepEqual((await f.documents.readImage(f.folder.directory, f.store.engine.state, f.note, decoded)).bytes, bytes);
});

test('unsafe image paths, HTML masquerading as images, and redirected folders cannot read or write unrelated files', async t => {
  const f = await device(t);
  for (const candidate of ['../secret.png', 'assets/../../secret.png', 'assets/%2e%2e%2fsecret.png', 'file:///C:/secret.png', 'assets/CON.png']) assert.equal(normalizeAssetPath(candidate), null);
  assert.deepEqual(referencedImages('```md\n![ignored](assets/no.png)\n```\n![yes][ref]\n\n[ref]: assets/yes.png'), ['assets/yes.png']);
  await assert.rejects(f.documents.cacheImage(Buffer.from('<svg><script>alert(1)</script></svg>')), /PNG/);
  await assert.rejects(f.documents.importAttachments({ [`${'a'.repeat(64)}.png`]: (await png()).toString('base64') }), /校验失败/);
  const outside = await temporaryDirectory(t); const target: DocumentTarget = { kind: 'note', id: crypto.randomUUID() };
  const parent = path.join(f.folder.directory, ...documentParts(target));
  await symlink(outside, parent, 'junction');
  await f.folder.update(engine => { engine.state.notes.push({ ...structuredClone(engine.state.notes[0]), id: target.id }); });
  assert.match(f.folder.status.error!, /符号链接/);
  assert.deepEqual(await readdir(outside), []);
});

test('linked notes share one real file, external edits and images with their task, including after restart', async t => {
  const f = await device(t);
  await f.folder.update(engine => {
    engine.apply({ type: 'task.update', id: f.task.id, patch: { notes: '# 关联内容', notesFormat: 'markdown' } });
    engine.apply({ type: 'task.link-note', id: f.task.id });
  });
  const noteId = linkedNoteForTask(f.store.engine.state, f.store.engine.state.tasks[0])!.id;
  const linkedNote: DocumentTarget = { kind: 'note', id: noteId };
  assert.equal(await f.documents.filePath(f.folder.directory, f.store.engine.state, linkedNote), f.file(f.task, 'markdown'));
  const relative = await f.folder.addImage(linkedNote, await png());
  await f.folder.update(engine => engine.apply({ type: 'note.update', id: noteId, patch: { content: `# 图片\n![图片](${relative})` } }));
  assert.equal(f.store.engine.state.tasks[0].values.notes, `# 图片\n![图片](${relative})`);
  assert.deepEqual((await f.documents.readImage(f.folder.directory, f.store.engine.state, linkedNote, relative)).bytes, await png());
  await writeFile(f.file(f.task, 'markdown'), `# 外部修改\n![图片](${relative})`);
  await f.folder.refresh(); await f.folder.refresh();
  assert.equal(f.store.engine.state.tasks[0].values.notes, f.store.engine.state.notes.find(note => note.id === noteId)!.values.content);
  assert.match(f.store.engine.state.tasks[0].values.notes, /外部修改/);
  const reopened = new DataStore(f.root); await reopened.initialize();
  assert.equal(linkedNoteForTask(reopened.engine.state, reopened.engine.state.tasks[0])!.id, noteId);
  const backup = JSON.parse(await f.documents.backup(f.store.engine.state));
  const other = await device(t); await other.documents.importAttachments(backup.attachments);
  await other.folder.update(engine => engine.merge(parseWorkspace(backup)));
  const restoredTask = other.store.engine.state.tasks.find(task => task.id === f.task.id)!;
  assert.equal(linkedNoteForTask(other.store.engine.state, restoredTask)!.id, noteId);
  assert.deepEqual((await other.documents.readImage(other.folder.directory, other.store.engine.state, linkedNote, relative)).bytes, await png());
});

for (const removed of ['task', 'note'] as const) test(`deleting the linked ${removed} preserves the survivor's Markdown, images and editable file`, async t => {
  const f = await device(t);
  await f.folder.update(engine => engine.apply({ type: 'task.update', id: f.task.id, patch: { notesFormat: 'markdown' } }));
  const relative = await f.folder.addImage(f.task, await png());
  await f.folder.update(engine => {
    engine.apply({ type: 'task.update', id: f.task.id, patch: { notes: `# 保留\n![图片](${relative})` } });
    engine.apply({ type: 'task.link-note', id: f.task.id });
  });
  const noteId = linkedNoteForTask(f.store.engine.state, f.store.engine.state.tasks[0])!.id;
  await f.folder.update(engine => engine.apply({ type: removed === 'task' ? 'task.update' : 'note.update', id: removed === 'task' ? f.task.id : noteId, patch: { deleted: true } }));
  const survivor: DocumentTarget = removed === 'task' ? { kind: 'note', id: noteId } : f.task;
  const file = await f.documents.filePath(f.folder.directory, f.store.engine.state, survivor);
  assert.equal(file, f.file(survivor, 'markdown'));
  assert.match(await readFile(file, 'utf8'), /保留/);
  assert.deepEqual(await readFile(path.join(path.dirname(file), relative)), await png());
  await writeFile(file, '# 解除关联后编辑'); await f.folder.refresh(); await f.folder.refresh();
  assert.equal(removed === 'task' ? f.store.engine.state.notes.find(note => note.id === noteId)!.values.content : f.store.engine.state.tasks[0].values.notes, '# 解除关联后编辑');
  assert.equal(linkedTaskForNote(f.store.engine.state, f.store.engine.state.notes.find(note => note.id === noteId)!), undefined);
  assert.equal(f.folder.status.error, null);
});

test('reimporting a verified backup repairs corrupted cached images', async t => {
  const f = await device(t); const bytes = await png();
  await f.folder.addBoardImage({ destination: 'background' }, bytes, '背景.png');
  const backup = JSON.parse(await f.documents.backup(f.store.engine.state));
  const id = f.store.engine.state.boards[0].values.backgroundId!;
  await writeFile(path.join(f.root, 'media', id), 'corrupted cache');
  await assert.rejects(f.documents.readBoardImage(f.folder.directory, f.store.engine.state, id));
  await f.folder.importBackup(parseWorkspace(backup), backup.attachments);
  assert.deepEqual((await f.documents.readBoardImage(f.folder.directory, f.store.engine.state, id)).bytes, bytes);
  assert.equal(f.folder.status.error, null);
});

test('export reads a coherent snapshot and finishes image reads before queued cleanup', async t => {
  const f = await device(t); const bytes = await png();
  await f.folder.addBoardImage({ destination: 'card' }, bytes, '导出图片.png');
  const cardId = f.store.engine.state.boardCards[0].id;
  const backup = f.documents.backup.bind(f.documents);
  let started!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.documents.backup = async workspace => { started(); await pending; return backup(workspace); };
  const exporting = f.folder.exportBackup();
  await waiting;
  const deleting = f.folder.update(engine => engine.apply({ type: 'board.card.update', id: cardId, patch: { deleted: true } }));
  release();
  const saved = JSON.parse(await exporting); await deleting;
  assert.equal(saved.boardCards[0].values.deleted, false);
  assert.equal(Object.keys(saved.attachments).length, 1);
  assert.equal(f.store.engine.state.boardCards[0].values.deleted, true);
});

test('main-window drafts flush the last keystroke and survive Strict Mode re-registration', async () => {
  let saved = ''; const draft = new FieldDraft({ content: '' }, async patch => { saved = patch.content!; return { content: saved }; }, 60000);
  const first = registerMainDraft(draft); first(); const second = registerMainDraft(draft);
  await Promise.resolve(); draft.change('content', '退出前的最后一个字'); await flushMainDrafts();
  assert.equal(saved, '退出前的最后一个字'); second(); draft.dispose();
});
