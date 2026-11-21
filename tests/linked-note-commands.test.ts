import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommandWithDrafts } from '../electron/linked-note-commands';
import { WorkspaceEngine } from '../src/shared/engine';
import { FieldDraft, NoteDraft } from '../src/notes/draft';
import type { Command } from '../src/shared/model';
import { linkedNoteForTask } from '../src/shared/note-links';

function linked() {
  const engine = new WorkspaceEngine('saved-drafts');
  engine.apply({ type: 'task.add', title: '保存后解除关联', listId: 'inbox' });
  const task = engine.state.tasks[0];
  engine.apply({ type: 'task.link-note', id: task.id });
  const note = engine.state.notes[0];
  return { engine, task, note };
}
for (const removed of ['task', 'note'] as const) test(`deleting a ${removed} waits for drafts in both windows and preserves the final keystroke`, async () => {
  const { engine, task, note } = linked();
  const main = new FieldDraft({ title: task.values.title }, async patch => {
    engine.apply({ type: 'task.update', id: task.id, patch: { title: patch.title } });
    return { title: task.values.title };
  }, 60000);
  const sticky = new NoteDraft(note.values, async patch => {
    engine.apply({ type: 'note.update', id: note.id, patch }); return note.values;
  }, 60000);
  main.change('title', '删除前的新名称'); sticky.change('content', '删除前尚未自动保存的最后一个字');
  const order: string[] = [];
  const command: Command = { type: removed === 'task' ? 'task.update' : 'note.update', id: removed === 'task' ? task.id : note.id, patch: { deleted: true } };
  try {
    await applyCommandWithDrafts(command, {
      workspace: () => engine.state,
      flushMain: async () => { await main.flush(); order.push('main'); return true; },
      withSavedNote: async (id, action) => { assert.equal(id, note.id); await sticky.flush(); order.push('note'); return action(); },
      update: async command => { order.push('delete'); engine.apply(command); },
    });
    assert.deepEqual(order, ['main', 'note', 'delete']);
    assert.equal(task.values.title, '删除前的新名称');
    assert.equal(task.values.notes, '删除前尚未自动保存的最后一个字');
    assert.equal(note.values.content, task.values.notes); assert.equal(note.values.format, 'markdown');
    assert.equal(task.values.deleted, removed === 'task'); assert.equal(note.values.deleted, removed === 'note');
    assert.equal(linkedNoteForTask(engine.state, task), undefined);
  } finally { main.dispose(); sticky.dispose(); }
});

test('a failed main or note flush aborts deletion and keeps the association available for retry', async () => {
  for (const failure of ['main', 'note']) {
    const { engine, task, note } = linked(); const before = structuredClone(engine.state);
    await assert.rejects(applyCommandWithDrafts({ type: 'task.update', id: task.id, patch: { deleted: true } }, {
      workspace: () => engine.state,
      flushMain: async () => failure !== 'main',
      withSavedNote: async () => { throw new Error('便签尚未保存'); },
      update: async command => { engine.apply(command); },
    }), /尚未保存/);
    assert.deepEqual(engine.state, before); assert.equal(linkedNoteForTask(engine.state, task)?.id, note.id);
  }
});

test('deleting an independent note does not flush or depend on unrelated task edits', async () => {
  const { engine, task, note } = linked();
  engine.apply({ type: 'note.update', id: note.id, patch: { deleted: true } });
  engine.apply({ type: 'note.update', id: note.id, patch: { deleted: false } });
  await applyCommandWithDrafts({ type: 'note.update', id: note.id, patch: { deleted: true } }, {
    workspace: () => engine.state,
    flushMain: async () => { throw new Error('Unrelated main editor must not be flushed'); },
    withSavedNote: async (_id, action) => action(),
    update: async command => { engine.apply(command); },
  });
  assert.equal(note.values.deleted, true); assert.equal(task.values.deleted, false);
});
