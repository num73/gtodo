import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { WorkspaceEngine } from '../src/shared/engine';
import { PreferencesStore } from '../electron/preferences';
import { OutlookSync } from '../electron/outlook-sync';
import { outlookEvents, type OutlookEvent } from '../electron/outlook-events';
import type { OutlookBridge } from '../electron/outlook-bridge';
import { temporaryDirectory } from './helpers';

const parent = { storeId: 'AABB', folderId: 'CCDD', name: '测试账户 / 日历' };
const target = { ...parent, folderId: 'EEFF', name: '测试账户 / 日历 / GTodo' };
const counts = { created: 1, updated: 0, removed: 0, unchanged: 0 };
function fixture() {
  const engine = new WorkspaceEngine('calendar-test');
  engine.apply({ type: 'task.add', title: '准备会议资料', listId: 'inbox', dueDate: '2028-02-29' });
  return engine;
}
test('calendar mapping preserves local all-day dates, completion, Unicode notes and steps', () => {
  const engine = fixture(); const id = engine.state.tasks[0].id;
  engine.apply({ type: 'task.update', id, patch: { notes: '第一行\n第二行：🙂', important: true, reminder: '2028-02-29T02:00:00.000Z', completed: true } });
  engine.apply({ type: 'step.add', taskId: id, title: '核对时间' });
  const event = outlookEvents(engine.state)[0].event!;
  assert.equal(event.date, '2028-02-29'); assert.equal(event.subject, '✓ 准备会议资料');
  assert.match(event.body, /第一行\n第二行：🙂/); assert.match(event.body, /☐ 核对时间/);
  assert.equal(event.important, true); assert.equal(event.revision.length, 64);
  const previous = event.revision;
  engine.apply({ type: 'task.update', id, patch: { notes: '已更新' } });
  assert.notEqual(outlookEvents(engine.state)[0].event!.revision, previous);
});
test('only explicit deletion or cleared deadline produces removal, and notes are never calendar events', () => {
  const engine = fixture(); const id = engine.state.tasks[0].id;
  engine.apply({ type: 'note.add', title: '桌面便签', content: '不会上传到 Outlook' });
  engine.apply({ type: 'task.add', title: '仅提醒', listId: 'inbox' });
  engine.apply({ type: 'task.update', id: engine.state.tasks[1].id, patch: { reminder: '2028-03-01T02:00:00.000Z' } });
  engine.apply({ type: 'task.update', id, patch: { dueDate: null } });
  assert.deepEqual(outlookEvents(engine.state).map(row => row.event), [null, null]);
  engine.apply({ type: 'task.update', id, patch: { dueDate: '2028-02-29', deleted: true } });
  assert.equal(outlookEvents(engine.state)[0].event, null);
});
test('repetition maps materialized tasks separately and stable snapshots have stable revisions', () => {
  const engine = fixture(); const id = engine.state.tasks[0].id;
  engine.apply({ type: 'task.update', id, patch: { repeat: 'monthly', completed: true } });
  const rows = outlookEvents(engine.state);
  assert.equal(rows.length, 2); assert.equal(rows[1].event!.date, '2028-03-29');
  assert.notEqual(rows[0].id, rows[1].id);
  assert.deepEqual(rows, outlookEvents(structuredClone(engine.state)));
});
test('Outlook date bounds fail before sending a partial plan', () => {
  const engine = fixture();
  engine.apply({ type: 'task.update', id: engine.state.tasks[0].id, patch: { dueDate: '9999-12-31' } });
  assert.throws(() => outlookEvents(engine.state), /1601/);
});
test('old preferences migrate with calendar sync off and targets stay in local preferences', async t => {
  const dir = await temporaryDirectory(t);
  await writeFile(path.join(dir, 'preferences.json'), JSON.stringify({ dataPath: path.join(dir, 'data'), zoom: 100, noteWindows: {} }));
  const prefs = new PreferencesStore(dir); await prefs.initialize();
  assert.deepEqual(prefs.value.outlook, { enabled: false, target: null });
  await prefs.update(value => { value.outlook = { enabled: true, target }; });
  const reopened = new PreferencesStore(dir); await reopened.initialize(); assert.equal(reopened.value.outlook.target!.folderId, 'EEFF');
});
test('calendar discovery is read-only, enabling requires a returned calendar, and failures retry without changing tasks', async t => {
  const prefs = new PreferencesStore(await temporaryDirectory(t)); await prefs.initialize();
  const engine = fixture(); const original = structuredClone(engine.state); const calls: string[] = []; let fail = true;
  const bridge: OutlookBridge = {
    list: async () => { calls.push('list'); return [parent]; },
    connect: async selected => { calls.push('connect'); assert.deepEqual(selected, parent); return target; },
    sync: async (_target, events) => { calls.push('sync'); assert.equal(events[0].id, original.tasks[0].id); if (fail) throw new Error('日历暂时离线'); return counts; },
  };
  const sync = new OutlookSync(prefs, () => engine.state, bridge, () => {}); t.after(() => sync.stop());
  await sync.sync(); assert.deepEqual(calls, []);
  const options = await sync.list(); assert.deepEqual(calls, ['list']);
  await assert.rejects(sync.configure(true, 'unknown'), /重新读取/); assert.equal(prefs.value.outlook.enabled, false);
  await sync.configure(true, options[0].id); await sync.sync();
  assert.equal(sync.snapshot().phase, 'error'); assert.match(sync.snapshot().error!, /离线/);
  assert.deepEqual(engine.state, original);
  fail = false; await sync.sync(); assert.equal(sync.snapshot().phase, 'idle'); assert.ok(sync.snapshot().lastSyncedAt);
  await sync.configure(false); await sync.sync();
  assert.equal(sync.snapshot().phase, 'off'); assert.equal(prefs.value.outlook.target!.folderId, target.folderId);
  assert.deepEqual(calls, ['list', 'connect', 'sync', 'sync']);
  assert.equal(JSON.parse(await readFile(prefs.file, 'utf8')).outlook.enabled, false);
});
test('concurrent sync requests share one operation and stopping aborts the worker', async t => {
  const prefs = new PreferencesStore(await temporaryDirectory(t)); await prefs.initialize();
  await prefs.update(value => { value.outlook = { enabled: true, target }; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0; let aborted = false;
  const bridge: OutlookBridge = { list: async () => [parent], connect: async () => target,
    sync: async (_target, _tasks, signal) => { calls++; entered(); return new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => { aborted = true; reject(new Error('stopped')); }, { once: true });
    }); },
  };
  const sync = new OutlookSync(prefs, () => fixture().state, bridge, () => {}); t.after(() => sync.stop());
  const running = sync.sync(); await started; const second = sync.sync();
  await sync.configure(false); await Promise.all([running, second]);
  assert.equal(calls, 1); assert.equal(aborted, true); assert.equal(sync.snapshot().phase, 'off');
});
test('unchanged folder refreshes and sticky note edits do not repeatedly launch Outlook', async t => {
  const prefs = new PreferencesStore(await temporaryDirectory(t)); await prefs.initialize();
  await prefs.update(value => { value.outlook = { enabled: true, target }; });
  const engine = fixture(); let calls = 0;
  const bridge: OutlookBridge = { list: async () => [parent], connect: async () => target, sync: async () => { calls++; return counts; } };
  const sync = new OutlookSync(prefs, () => engine.state, bridge, () => {}); t.after(() => sync.stop());
  sync.workspaceChanged(); await new Promise(resolve => setTimeout(resolve, 1650));
  assert.equal(calls, 1);
  engine.apply({ type: 'note.add', title: '不触发同步' });
  for (let i = 0; i < 10; i++) sync.workspaceChanged();
  await new Promise(resolve => setTimeout(resolve, 1650)); assert.equal(calls, 1);
});
