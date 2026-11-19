import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeWorkspaces, WorkspaceEngine } from '../src/shared/engine';
import { parseWorkspace } from '../src/shared/model';
import { linkedNoteForTask, linkedTaskForNote } from '../src/shared/note-links';

function seed(link = true) {
  const engine = new WorkspaceEngine('first');
  engine.apply({ type: 'task.add', title: '会议准备', listId: 'inbox', dueDate: '2026-12-01' });
  const taskId = engine.state.tasks[0].id;
  engine.apply({ type: 'task.update', id: taskId, patch: { notes: '整理议题' } });
  if (link) engine.apply({ type: 'task.link-note', id: taskId });
  return { engine, taskId, noteId: engine.state.notes[0]?.id };
}

test('tasks start without notes and explicit linking is atomic, idempotent and uses only the remark', () => {
  const { engine, taskId } = seed(false);
  assert.equal(engine.state.notes.length, 0);
  assert.equal(engine.state.tasks[0].values.noteLink, null);
  engine.apply({ type: 'task.link-note', id: taskId });
  const note = linkedNoteForTask(engine.state, engine.state.tasks[0])!;
  assert.equal(note.values.content, '整理议题');
  assert.equal(note.values.title, '会议准备');
  assert.equal(linkedTaskForNote(engine.state, note)?.id, taskId);
  engine.apply({ type: 'task.link-note', id: taskId });
  assert.equal(engine.state.notes.length, 1);
  assert.equal(engine.state.notes[0].id, note.id);
});

test('linked content, Markdown and images update both ways while titles and colors stay independent', () => {
  const { engine, taskId, noteId } = seed();
  const asset = `${'a'.repeat(64)}.png`; const assets = { [`assets/${asset}`]: asset };
  engine.apply({ type: 'task.update', id: taskId, patch: { notes: '# 内容\n```js\n1\n```', notesFormat: 'markdown', notesAssets: assets } });
  const task = engine.state.tasks[0]; const note = engine.state.notes[0];
  assert.equal(note.values.content, task.values.notes);
  assert.equal(note.values.format, 'markdown'); assert.deepEqual(note.values.assets, assets);
  engine.apply({ type: 'note.update', id: noteId, patch: { content: '# 在便签里修改', title: '便签名称', color: 'blue' } });
  assert.equal(task.values.notes, '# 在便签里修改');
  assert.equal(task.values.title, '会议准备');
  assert.deepEqual(task.clocks.notes, note.clocks.content);
  engine.apply({ type: 'note.update', id: noteId, patch: { format: 'text' } });
  assert.equal(task.values.notesFormat, 'text');
});

for (const removed of ['task', 'note'] as const) test(`deleting a linked ${removed} preserves the other side and undo never reconnects it`, () => {
  const { engine, taskId, noteId } = seed();
  engine.apply({ type: 'note.update', id: noteId, patch: { content: '删除前最新内容', format: 'markdown' } });
  const command = removed === 'task' ? { type: 'task.update' as const, id: taskId } : { type: 'note.update' as const, id: noteId };
  engine.apply({ ...command, patch: { deleted: true } });
  const task = engine.state.tasks[0]; const note = engine.state.notes[0];
  assert.equal(task.values.deleted, removed === 'task'); assert.equal(note.values.deleted, removed === 'note');
  assert.equal(task.values.notes, '删除前最新内容'); assert.equal(note.values.content, '删除前最新内容');
  assert.equal(linkedNoteForTask(engine.state, task), undefined);
  engine.apply({ ...command, patch: { deleted: false } });
  assert.equal(linkedNoteForTask(engine.state, task), undefined);
  engine.apply({ type: 'task.update', id: taskId, patch: { notes: '独立的备注' } });
  engine.apply({ type: 'note.update', id: noteId, patch: { content: '独立的便签' } });
  assert.equal(task.values.notes, '独立的备注'); assert.equal(note.values.content, '独立的便签');
  engine.apply({ ...command, patch: { deleted: true } });
  assert.equal(task.values.notes, '独立的备注'); assert.equal(note.values.content, '独立的便签');
  const reopened = new WorkspaceEngine('reopened', parseWorkspace(JSON.parse(JSON.stringify(engine.state))));
  assert.equal(linkedNoteForTask(reopened.state, reopened.state.tasks[0]), undefined);
  reopened.apply({ type: removed === 'task' ? 'note.update' : 'task.update', id: removed === 'task' ? noteId : taskId, patch: { deleted: true } });
  assert.equal(reopened.state.tasks.filter(task => !task.values.deleted).length, 0);
  assert.equal(reopened.state.notes.filter(note => !note.values.deleted).length, 0);
});

test('creating a new link after deletion leaves the old note detached and repeats never inherit a link', () => {
  const { engine, taskId, noteId } = seed();
  engine.apply({ type: 'note.update', id: noteId, patch: { deleted: true } });
  engine.apply({ type: 'task.link-note', id: taskId });
  assert.equal(engine.state.notes.length, 2);
  assert.notEqual(linkedNoteForTask(engine.state, engine.state.tasks[0])!.id, noteId);
  engine.apply({ type: 'note.update', id: noteId, patch: { deleted: false, content: '旧便签单独修改' } });
  assert.equal(engine.state.tasks[0].values.notes, '整理议题');
  engine.apply({ type: 'task.update', id: taskId, patch: { repeat: 'daily', completed: true } });
  const next = engine.state.tasks.find(task => task.id !== taskId)!;
  assert.equal(next.values.noteLink, null); assert.equal(next.values.notes, '整理议题');
});

test('old backups and pre-existing copied notes remain independent', () => {
  const { engine, taskId } = seed(false);
  engine.apply({ type: 'note.add', title: '会议准备', content: '整理议题' });
  const old = JSON.parse(JSON.stringify(engine.state));
  delete old.tasks[0].values.noteLink; delete old.tasks[0].clocks.noteLink;
  const migrated = new WorkspaceEngine('migrated', parseWorkspace(old));
  assert.equal(migrated.state.tasks[0].values.noteLink, null);
  migrated.apply({ type: 'task.update', id: taskId, patch: { notes: '只改任务' } });
  assert.equal(migrated.state.notes[0].values.content, '整理议题');
});

test('offline edits from both linked surfaces converge, including deletion and stale snapshots', () => {
  const { engine: base, taskId, noteId } = seed();
  const a = new WorkspaceEngine('a', base.state); const b = new WorkspaceEngine('b', base.state); const c = new WorkspaceEngine('c', base.state);
  a.apply({ type: 'task.update', id: taskId, patch: { notes: '任务端离线编辑', notesFormat: 'markdown' } });
  b.apply({ type: 'note.update', id: noteId, patch: { content: '便签端离线编辑', color: 'green' } });
  const ab = mergeWorkspaces(a.state, b.state); const ba = mergeWorkspaces(b.state, a.state);
  assert.deepEqual(ab, ba); assert.deepEqual(mergeWorkspaces(ab, ab), ab);
  assert.equal(ab.tasks[0].values.notes, ab.notes[0].values.content);
  assert.equal(ab.notes[0].values.format, 'markdown'); assert.equal(ab.notes[0].values.color, 'green');
  c.apply({ type: 'task.update', id: taskId, patch: { deleted: true } });
  assert.deepEqual(mergeWorkspaces(ab, c.state), mergeWorkspaces(a.state, mergeWorkspaces(b.state, c.state)));
  const merged = mergeWorkspaces(ab, c.state);
  assert.equal(merged.tasks[0].values.deleted, true); assert.equal(merged.notes[0].values.deleted, false);
  assert.equal(linkedTaskForNote(merged, merged.notes[0]), undefined);
  assert.equal(linkedNoteForTask(mergeWorkspaces(merged, base.state), merged.tasks[0]), undefined);
});

test('an offline task edit is not lost when linking and deleting the task arrive in a different order', () => {
  const { engine: initial, taskId } = seed(false);
  const linked = new WorkspaceEngine('linked', initial.state); linked.apply({ type: 'task.link-note', id: taskId });
  const removed = new WorkspaceEngine('removed', linked.state); removed.apply({ type: 'task.update', id: taskId, patch: { deleted: true } });
  const offline = new WorkspaceEngine('offline', initial.state); offline.merge(initial.state);
  offline.apply({ type: 'task.update', id: taskId, patch: { notes: '离线时输入的内容' } });
  offline.state.tasks[0].clocks.notes = { tick: removed.state.tasks[0].clocks.deleted.tick + 10, device: 'offline' };
  const first = mergeWorkspaces(mergeWorkspaces(linked.state, offline.state), removed.state);
  const second = mergeWorkspaces(linked.state, mergeWorkspaces(offline.state, removed.state));
  assert.deepEqual(first, second);
  assert.equal(first.notes[0].values.content, '离线时输入的内容');
  assert.equal(first.tasks[0].values.deleted, true);
});
