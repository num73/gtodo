import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { DataStore } from '../electron/storage';
import { PreferencesStore } from '../electron/preferences';
import { nextZoom } from '../src/shared/model';
import { temporaryDirectory } from './helpers';

test('concurrent commands persist serially and survive a fresh application instance', async t => {
  const directory = await temporaryDirectory(t); const store = new DataStore(directory); await store.initialize();
  await Promise.all(Array.from({ length: 30 }, (_, i) => store.update(engine => engine.apply({ type: 'task.add', title: `任务 ${i}`, listId: 'inbox' }))));
  const reopened = new DataStore(directory); await reopened.initialize();
  assert.equal(reopened.engine.state.tasks.length, 30); assert.equal(reopened.engine.deviceId, store.engine.deviceId);
});
test('invalid mutation does not replace durable or in-memory state and queue remains usable', async t => {
  const store = new DataStore(await temporaryDirectory(t)); await store.initialize();
  const before = await readFile(store.file, 'utf8');
  await assert.rejects(store.update(engine => engine.apply({ type: 'task.add', title: '不能保存', listId: 'missing' })));
  assert.equal(await readFile(store.file, 'utf8'), before); assert.equal(store.engine.state.tasks.length, 0);
  await store.update(engine => engine.apply({ type: 'task.add', title: '正常任务', listId: 'inbox' }));
  assert.equal(store.engine.state.tasks.length, 1);
});
test('corrupted main file recovers known-good backup without losing device identity', async t => {
  const dir = await temporaryDirectory(t); const store = new DataStore(dir); await store.initialize();
  await store.update(engine => engine.apply({ type: 'task.add', title: '保留的任务', listId: 'inbox' }));
  await store.update(engine => engine.apply({ type: 'task.add', title: '下一版的任务', listId: 'inbox' }));
  await writeFile(store.file, '{broken');
  const reopened = new DataStore(dir); await reopened.initialize();
  assert.match(reopened.notice!, /备份恢复/); assert.equal(reopened.engine.state.tasks.length, 1);
  assert.equal(reopened.engine.deviceId, store.engine.deviceId);
});
test('corrupt main and backup fail closed rather than overwrite user data', async t => {
  const dir = await temporaryDirectory(t); await writeFile(path.join(dir, 'workspace.json'), 'broken');
  await writeFile(path.join(dir, 'workspace.json.bak'), 'also-broken');
  await assert.rejects(new DataStore(dir).initialize(), /停止写入/);
  assert.equal(await readFile(path.join(dir, 'workspace.json'), 'utf8'), 'broken');
});
test('folder, zoom and window preferences survive concurrent updates and a restart', async t => {
  const directory = await temporaryDirectory(t); const preferences = new PreferencesStore(directory); await preferences.initialize();
  const dataPath = path.join(directory, 'chosen-folder');
  const window = { x: 200, y: 100, width: 480, height: 600, maximized: false };
  await Promise.all([
    preferences.update(value => { value.dataPath = dataPath; }),
    preferences.update(value => { value.zoom = 150; }),
    preferences.update(value => { value.window = window; }),
  ]);
  const reopened = new PreferencesStore(directory); await reopened.initialize();
  assert.deepEqual(reopened.value, { dataPath, zoom: 150, window, noteWindows: {}, outlook: { enabled: false, target: null } });
  await assert.rejects(preferences.update(value => { value.zoom = 500; }));
  assert.equal(preferences.value.zoom, 150);
});
test('zoom steps clamp at their limits and reset exactly to 100 percent', () => {
  assert.equal(nextZoom(100, 'in'), 110);
  assert.equal(nextZoom(125, 'out'), 110);
  assert.equal(nextZoom(60, 'out'), 60);
  assert.equal(nextZoom(200, 'in'), 200);
  assert.equal(nextZoom(175, 'reset'), 100);
  assert.equal(nextZoom(100, 150), 150);
  assert.equal(nextZoom(100, 999), 100);
});
