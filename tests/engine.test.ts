import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeWorkspaces, WorkspaceEngine } from '../src/shared/engine';
import { commandSchema, nextDate, parseWorkspace } from '../src/shared/model';

function seed() { const engine = new WorkspaceEngine('first'); engine.apply({ type: 'task.add', title: '整理周计划', listId: 'inbox' }); return engine; }
test('independent offline field edits converge in both merge directions', () => {
  const base = seed(); const id = base.state.tasks[0].id;
  const a = new WorkspaceEngine('A', base.state); const b = new WorkspaceEngine('B', base.state);
  a.apply({ type: 'task.update', id, patch: { title: '修改后的标题', important: true } });
  b.apply({ type: 'task.update', id, patch: { notes: '另一台电脑的备注', dueDate: '2026-12-01' } });
  const ab = mergeWorkspaces(a.state, b.state); const ba = mergeWorkspaces(b.state, a.state);
  assert.deepEqual(ab, ba);
  assert.equal(ab.tasks[0].values.title, '修改后的标题');
  assert.equal(ab.tasks[0].values.notes, '另一台电脑的备注');
  assert.equal(ab.tasks[0].values.important, true);
  assert.deepEqual(mergeWorkspaces(ab, ab), ab);
});
test('tombstones survive stale snapshots and concurrent edits to other fields', () => {
  const a = seed(); const stale = structuredClone(a.state); const id = a.state.tasks[0].id;
  a.apply({ type: 'task.update', id, patch: { deleted: true } });
  const b = new WorkspaceEngine('offline', stale);
  b.apply({ type: 'task.update', id, patch: { title: '离线修改' } });
  const merged = mergeWorkspaces(a.state, b.state);
  assert.equal(merged.tasks[0].values.deleted, true);
  assert.equal(merged.tasks[0].values.title, '离线修改');
  assert.equal(mergeWorkspaces(merged, stale).tasks[0].values.deleted, true);
});
test('merge is associative and deterministic for conflicting edits', () => {
  const source = seed(); const id = source.state.tasks[0].id;
  const branches = ['A', 'B', 'C'].map(device => {
    const engine = new WorkspaceEngine(device, source.state);
    engine.apply({ type: 'task.update', id, patch: { title: device } });
    engine.state.tasks[0].clocks.title.tick = 9999999999999;
    return engine.state;
  });
  assert.deepEqual(mergeWorkspaces(mergeWorkspaces(branches[0], branches[1]), branches[2]), mergeWorkspaces(branches[0], mergeWorkspaces(branches[1], branches[2])));
  assert.equal(mergeWorkspaces(branches[0], branches[2]).tasks[0].values.title, 'C');
});
test('a clock observed from another device is advanced before new edits', () => {
  const a = seed(); a.state.tasks[0].clocks.title.tick = Date.now() + 100000;
  const b = new WorkspaceEngine('new-device'); b.merge(a.state);
  b.apply({ type: 'task.update', id: a.state.tasks[0].id, patch: { title: '最新修改' } });
  assert.equal(mergeWorkspaces(a.state, b.state).tasks[0].values.title, '最新修改');
});
test('deleting a list preserves tasks in inbox', () => {
  const engine = seed(); engine.apply({ type: 'list.add', name: '工作', color: 'blue' });
  const listId = engine.state.lists[0].id; const id = engine.state.tasks[0].id;
  engine.apply({ type: 'task.update', id, patch: { listId } });
  engine.apply({ type: 'list.update', id: listId, patch: { deleted: true } });
  assert.equal(engine.state.tasks[0].values.listId, 'inbox');
  assert.equal(engine.state.tasks[0].values.deleted, false);
  assert.throws(() => engine.apply({ type: 'task.add', title: 'x', listId }), /清单已删除/);
});
test('monthly repetition handles month boundaries and creates only one next occurrence', () => {
  const engine = seed(); const id = engine.state.tasks[0].id;
  engine.apply({ type: 'step.add', taskId: id, title: '复核' });
  engine.apply({ type: 'step.update', id: engine.state.steps[0].id, patch: { completed: true } });
  engine.apply({ type: 'task.update', id, patch: { dueDate: '2026-01-31', repeat: 'monthly', myDay: '2026-01-31', completed: true } });
  const next = engine.state.tasks.find(task => task.id !== id)!;
  assert.equal(next.values.dueDate, '2026-02-28');
  assert.equal(next.values.myDay, null);
  assert.equal(next.values.completed, false);
  assert.equal(engine.state.steps.find(step => step.values.taskId === next.id)!.values.completed, false);
  engine.apply({ type: 'task.update', id, patch: { completed: false } });
  engine.apply({ type: 'task.update', id, patch: { completed: true } });
  assert.equal(engine.state.tasks.length, 2);
  assert.equal(nextDate('2024-01-31', 'monthly'), '2024-02-29');
  assert.equal(nextDate('2026-12-31', 'daily'), '2027-01-01');
});
test('repeating on two devices does not duplicate the next task or its steps', () => {
  const base = seed(); const id = base.state.tasks[0].id;
  base.apply({ type: 'task.update', id, patch: { dueDate: '2026-11-19', repeat: 'weekly' } });
  base.apply({ type: 'step.add', taskId: id, title: '子任务' });
  const a = new WorkspaceEngine('A', base.state); const b = new WorkspaceEngine('B', base.state);
  a.apply({ type: 'task.update', id, patch: { completed: true } });
  b.apply({ type: 'task.update', id, patch: { completed: true } });
  const merged = mergeWorkspaces(a.state, b.state);
  assert.equal(merged.tasks.length, 2); assert.equal(merged.steps.length, 2);
});
test('rejects unknown schema, duplicate identifiers, missing clocks, impossible dates and empty titles', () => {
  const engine = seed();
  assert.throws(() => parseWorkspace({ ...engine.state, schemaVersion: 99 }));
  assert.throws(() => parseWorkspace({ ...engine.state, tasks: [...engine.state.tasks, ...engine.state.tasks] }));
  const corrupt = structuredClone(engine.state); delete (corrupt.tasks[0].clocks as Record<string, unknown>).title;
  assert.throws(() => parseWorkspace(corrupt));
  assert.throws(() => commandSchema.parse({ type: 'task.update', id: 'x', patch: { dueDate: '2026-02-31' } }));
  assert.throws(() => commandSchema.parse({ type: 'task.add', title: ' ', listId: 'inbox' }));
});
