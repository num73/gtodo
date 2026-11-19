import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { WorkspaceEngine, mergeWorkspaces } from '../src/shared/engine';
import { emptyWorkspace, parseWorkspace, type NoteValues } from '../src/shared/model';
import { NoteDraft } from '../src/notes/draft';
import { DataStore } from '../electron/storage';
import { PreferencesStore } from '../electron/preferences';
import { FolderStorage } from '../electron/folder-storage';
import { temporaryDirectory } from './helpers';

const values = (): NoteValues => ({ title: '便签', content: '', color: 'yellow', format: 'text', assets: {}, createdAt: new Date().toISOString(), deleted: false });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('1.1 workspaces without notes migrate without changing their tasks', async t => {
  const store = new DataStore(await temporaryDirectory(t)); await store.initialize();
  await store.update(engine => engine.apply({ type: 'task.add', title: '已有任务', listId: 'inbox' }));
  const old = JSON.parse(await readFile(store.file, 'utf8')); delete old.workspace.notes;
  await writeFile(store.file, JSON.stringify(old));
  const reopened = new DataStore(store.directory); await reopened.initialize();
  assert.equal(reopened.engine.state.tasks[0].values.title, '已有任务');
  assert.deepEqual(reopened.engine.state.notes, []);
  assert.deepEqual(parseWorkspace({ schemaVersion: 1, lists: [], tasks: [], steps: [] }), emptyWorkspace());
});

test('note text and colors merge independently and deleted notes stay deleted', () => {
  const first = new WorkspaceEngine('computer-a'); first.apply({ type: 'note.add', title: '旅行清单' });
  const id = first.state.notes[0].id;
  const second = new WorkspaceEngine('computer-b', first.state);
  first.apply({ type: 'note.update', id, patch: { content: '带上充电器' } });
  second.apply({ type: 'note.update', id, patch: { color: 'green' } });
  const merged = mergeWorkspaces(first.state, second.state);
  assert.equal(merged.notes[0].values.content, '带上充电器');
  assert.equal(merged.notes[0].values.color, 'green');
  first.merge(merged); first.apply({ type: 'note.update', id, patch: { deleted: true } });
  assert.equal(mergeWorkspaces(first.state, second.state).notes[0].values.deleted, true);
  first.apply({ type: 'note.update', id, patch: { deleted: false } });
  assert.equal(first.state.notes[0].values.content, '带上充电器');
});

test('notes are in folder snapshots and backups, while window placement remains local', async t => {
  const directory = await temporaryDirectory(t); const local = new DataStore(directory); await local.initialize();
  const preferences = new PreferencesStore(directory); await preferences.initialize();
  const folder = new FolderStorage(local, preferences); await folder.initialize();
  await folder.update(engine => engine.apply({ type: 'note.add', title: '桌面提醒', content: '下午整理资料' }));
  const id = local.engine.state.notes[0].id;
  await preferences.update(value => { value.noteWindows[id] = { open: true, pinned: true, bounds: { x: 40, y: 80, width: 320, height: 360 } }; });
  const snapshot = JSON.parse(await readFile(folder.ownFile, 'utf8'));
  assert.equal(parseWorkspace(snapshot).notes[0].values.content, '下午整理资料');
  assert.equal('noteWindows' in snapshot, false);
  const newPreferences = new PreferencesStore(directory); await newPreferences.initialize();
  assert.deepEqual(newPreferences.value.noteWindows[id], preferences.value.noteWindows[id]);
  const newStore = new DataStore(directory); await newStore.initialize();
  assert.equal(newStore.engine.state.notes[0].id, id);
});

test('draft flush saves immediately and includes typing that arrives during a slow save', async () => {
  const firstSave = deferred<NoteValues>(); const patches: unknown[] = [];
  let saved = values();
  const draft = new NoteDraft(saved, async patch => {
    patches.push(patch);
    if (patches.length === 1) return firstSave.promise;
    saved = { ...saved, ...patch }; return saved;
  }, 60000);
  draft.change('content', '第一个版本'); const flush = draft.flush();
  draft.change('content', '第一个版本，继续输入'); draft.change('title', '正在记录');
  saved = { ...saved, content: '第一个版本' }; firstSave.resolve(saved);
  await flush;
  assert.equal(saved.content, '第一个版本，继续输入'); assert.equal(saved.title, '正在记录');
  assert.equal(draft.getSnapshot().dirty, false); assert.equal(patches.length, 2); draft.dispose();
});

test('folder updates never replace unsaved text and a failed save can be retried', async () => {
  let fail = true; let saved = values();
  const draft = new NoteDraft(saved, async patch => {
    if (fail) throw new Error('磁盘空间不足'); saved = { ...saved, ...patch }; return saved;
  }, 60000);
  draft.change('content', '还没写完的内容');
  draft.receive({ ...saved, content: '其他设备的内容', color: 'blue' });
  assert.equal(draft.getSnapshot().values.content, '还没写完的内容');
  assert.equal(draft.getSnapshot().values.color, 'blue');
  await assert.rejects(draft.flush(), /磁盘空间不足/);
  assert.equal(draft.getSnapshot().dirty, true); assert.match(draft.getSnapshot().error, /磁盘空间不足/);
  fail = false; await draft.flush();
  assert.equal(saved.content, '还没写完的内容'); assert.equal(draft.getSnapshot().dirty, false); draft.dispose();
});

test('idle typing is automatically persisted without waiting for blur', async () => {
  const completed = deferred<void>(); let saved = values();
  const draft = new NoteDraft(saved, async patch => { saved = { ...saved, ...patch }; completed.resolve(); return saved; }, 10);
  draft.change('content', '自动保存'); await completed.promise; await draft.flush();
  assert.equal(saved.content, '自动保存'); assert.equal(draft.getSnapshot().dirty, false); draft.dispose();
});
