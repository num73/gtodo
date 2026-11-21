import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { WorkspaceEngine, mergeWorkspaces } from '../src/shared/engine';
import { parseWorkspace } from '../src/shared/model';
import { isDesktopNote, isNotebookNote, folderParent, noteFolder } from '../src/shared/notebook';
import { trashRecords } from '../src/shared/trash';
import { applyCommandWithDrafts } from '../electron/linked-note-commands';
import { DataStore } from '../electron/storage';
import { PreferencesStore } from '../electron/preferences';
import { FolderStorage } from '../electron/folder-storage';
import { temporaryDirectory } from './helpers';

test('a linked notebook and sticky note share their content and only enter trash after both views are removed', () => {
  const engine = new WorkspaceEngine('notebook-test'); engine.apply({ type: 'notebook.add', title: '一份内容' });
  const note = engine.state.notes[0]; engine.apply({ type: 'note.desktop', id: note.id });
  engine.apply({ type: 'note.update', id: note.id, patch: { content: '# 修改正文' } });
  engine.apply({ type: 'note.update', id: note.id, patch: { deleted: true } });
  assert.equal(isDesktopNote(note), false); assert.equal(isNotebookNote(note), true); assert.equal(trashRecords(engine.state).length, 0);
  assert.throws(() => engine.purge([{ kind: 'note', id: note.id, clock: note.clocks.deleted }]));
  engine.apply({ type: 'notebook.remove', id: note.id }); assert.equal(note.values.deleted, true);
  engine.restore(trashRecords(engine.state)[0]); assert.equal(isDesktopNote(note), true); assert.equal(isNotebookNote(note), true);
  assert.equal(note.values.content, '# 修改正文'); assert.equal(engine.state.notes.length, 1);
  engine.apply({ type: 'notebook.remove', id: note.id }); assert.equal(isDesktopNote(note), true);
  engine.apply({ type: 'note.update', id: note.id, patch: { deleted: true } });
  engine.purge(trashRecords(engine.state)); assert.equal(engine.state.notes.length, 0);
});
test('converting a sticky note and moving nested folders preserve IDs, contents and reachable children', () => {
  const engine = new WorkspaceEngine('folders-test'); engine.apply({ type: 'note.add', content: '原始内容' });
  const note = engine.state.notes[0]; engine.apply({ type: 'noteFolder.add', name: '项目', parentId: null });
  const parent = engine.state.noteFolders[0]; engine.apply({ type: 'noteFolder.add', name: '资料', parentId: parent.id });
  const child = engine.state.noteFolders[1];
  engine.apply({ type: 'note.notebook', id: note.id, mode: 'convert', folderId: child.id });
  assert.equal(isDesktopNote(note), false); assert.equal(isNotebookNote(note), true); assert.equal(note.values.content, '原始内容');
  assert.throws(() => engine.apply({ type: 'noteFolder.update', id: parent.id, patch: { parentId: child.id } }), /自身或子目录/);
  engine.apply({ type: 'noteFolder.update', id: child.id, patch: { deleted: true } });
  assert.equal(noteFolder(engine.state, note), null);
  engine.apply({ type: 'noteFolder.update', id: child.id, patch: { deleted: false } });
  assert.equal(noteFolder(engine.state, note), child.id);
  engine.apply({ type: 'noteFolder.update', id: parent.id, patch: { deleted: true } }); assert.equal(folderParent(engine.state, child.id), null);
});
test('offline removals of different views converge, retain edits, and cannot revive purged notes', () => {
  const first = new WorkspaceEngine('alpha'); first.apply({ type: 'notebook.add' }); const id = first.state.notes[0].id;
  first.apply({ type: 'note.desktop', id }); const second = new WorkspaceEngine('beta', first.state);
  first.apply({ type: 'notebook.remove', id }); second.apply({ type: 'note.update', id, patch: { content: '离线最后输入', deleted: true } });
  const merged = mergeWorkspaces(first.state, second.state);
  assert.deepEqual(merged, mergeWorkspaces(second.state, first.state)); assert.equal(merged.notes[0].values.deleted, true); assert.equal(merged.notes[0].values.content, '离线最后输入');
  const engine = new WorkspaceEngine('gamma', merged); engine.purge(trashRecords(engine.state)); engine.merge(first.state); assert.equal(engine.state.notes.length, 0);
});
test('legacy deleted sticky notes stay deleted when notebook metadata is added', () => {
  const engine = new WorkspaceEngine('migration'); engine.apply({ type: 'note.add' }); engine.apply({ type: 'note.update', id: engine.state.notes[0].id, patch: { deleted: true } });
  const input = JSON.parse(JSON.stringify(engine.state)); delete input.noteFolders;
  for (const name of ['desktop', 'notebook', 'folderId']) { delete input.notes[0].values[name]; delete input.notes[0].clocks[name]; }
  const restored = new WorkspaceEngine('another', parseWorkspace(input)); assert.equal(restored.state.notes[0].values.deleted, true);
  assert.deepEqual(restored.state.noteFolders, []);
});

test('undo restores only its own view and task-linked notes can reopen their desktop view', () => {
  const engine = new WorkspaceEngine('views'); engine.apply({ type: 'task.add', title: '关联任务', listId: 'inbox' });
  const task = engine.state.tasks[0]; engine.apply({ type: 'task.link-note', id: task.id }); const note = engine.state.notes[0];
  engine.apply({ type: 'note.notebook', id: note.id, mode: 'link' });
  engine.apply({ type: 'note.update', id: note.id, patch: { deleted: true } });
  engine.apply({ type: 'task.link-note', id: task.id });
  assert.equal(isDesktopNote(note), true); assert.equal(engine.state.notes.length, 1);
  engine.apply({ type: 'notebook.remove', id: note.id });
  engine.apply({ type: 'note.update', id: note.id, patch: { deleted: true } });
  engine.apply({ type: 'note.desktop', id: note.id });
  assert.equal(isDesktopNote(note), true); assert.equal(isNotebookNote(note), false);
  engine.apply({ type: 'note.update', id: note.id, patch: { deleted: true } });
  engine.apply({ type: 'note.notebook', id: note.id, mode: 'link' });
  assert.equal(isDesktopNote(note), false); assert.equal(isNotebookNote(note), true);
});
test('removing either linked view waits for both editor drafts and aborts on a failed save', async () => {
  const engine = new WorkspaceEngine('save'); engine.apply({ type: 'notebook.add' }); const id = engine.state.notes[0].id; engine.apply({ type: 'note.desktop', id });
  const steps: string[] = [];
  const options = { workspace: () => engine.state, flushMain: async () => { steps.push('main'); return true; }, withSavedNote: async (_id: string, action: () => Promise<unknown>) => { steps.push('sticky'); return action(); }, update: async (command: Parameters<typeof engine.apply>[0]) => { steps.push('update'); engine.apply(command); } };
  await applyCommandWithDrafts({ type: 'notebook.remove', id }, options); assert.deepEqual(steps, ['main', 'sticky', 'update']);
  engine.apply({ type: 'note.notebook', id, mode: 'link' }); steps.length = 0;
  await assert.rejects(applyCommandWithDrafts({ type: 'note.update', id, patch: { deleted: true } }, { ...options, flushMain: async () => false }));
  assert.equal(isDesktopNote(engine.state.notes[0]), true);
});
test('notebook files and folders survive backup, reload and conversion without duplicating the document', async t => {
  const directory = await temporaryDirectory(t); const store = new DataStore(directory); await store.initialize();
  const preferences = new PreferencesStore(directory); await preferences.initialize(); const folders = new FolderStorage(store, preferences); await folders.initialize();
  await folders.update(engine => { engine.apply({ type: 'noteFolder.add', name: '资料', parentId: null }); engine.apply({ type: 'notebook.add', title: '文档', folderId: engine.state.noteFolders[0].id }); });
  const note = store.engine.state.notes[0]; await folders.update(engine => { engine.apply({ type: 'note.desktop', id: note.id }); engine.apply({ type: 'note.update', id: note.id, patch: { content: '# 同一文档' } }); });
  const file = path.join(folders.directory, 'documents', 'notes', `note-${note.id}`, 'note.md'); assert.equal(await readFile(file, 'utf8'), '# 同一文档');
  const backup = parseWorkspace(JSON.parse(await folders.exportBackup())); assert.equal(backup.noteFolders.length, 1); assert.equal(backup.notes.length, 1);
  const reopened = new DataStore(directory); await reopened.initialize(); assert.equal(isNotebookNote(reopened.engine.state.notes[0]), true);
  assert.equal(isDesktopNote(reopened.engine.state.notes[0]), true);
});
