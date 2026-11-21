import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { PreferencesStore } from '../electron/preferences';
import { temporaryDirectory } from './helpers';
import { creationDefaults, defaultUserPreferences, patchUserPreferences, resolveStartupView } from '../src/shared/preferences';
import { WorkspaceEngine } from '../src/shared/engine';

test('old local preferences gain compatible defaults without changing saved windows or folder', async t => {
  const directory = await temporaryDirectory(t), file = path.join(directory, 'preferences.json');
  const legacy = { dataPath: path.join(directory, 'existing-data'), zoom: 125, noteWindows: { existing: { open: true, pinned: true } } };
  await writeFile(file, JSON.stringify(legacy));
  const preferences = new PreferencesStore(directory); await preferences.initialize();
  assert.deepEqual(preferences.value.user, defaultUserPreferences);
  assert.equal(preferences.value.user.sidebarVisible, true);
  assert.equal(preferences.value.user.inboxVisible, true);
  assert.equal(preferences.value.dataPath, legacy.dataPath);
  assert.deepEqual(preferences.value.noteWindows, legacy.noteWindows);
  await writeFile(file, JSON.stringify({ ...legacy, user: { startupView: 'board' } }));
  await preferences.initialize();
  assert.deepEqual(preferences.value.user, { ...defaultUserPreferences, startupView: 'board' });
});

test('partial settings writes survive concurrency and restart, and invalid writes leave the file intact', async t => {
  const directory = await temporaryDirectory(t), preferences = new PreferencesStore(directory);
  await preferences.initialize();
  await Promise.all([
    preferences.update(value => { value.user = patchUserPreferences(value.user, { startupView: 'board', restoreNotes: false, sidebarVisible: false, inboxVisible: false }); }),
    preferences.update(value => { value.user = patchUserPreferences(value.user, { closeAction: 'background', noteColor: 'blue' }); }),
    preferences.update(value => { value.user = patchUserPreferences(value.user, { taskNotifications: false, startupView: undefined }); }),
  ]);
  const expected = { ...defaultUserPreferences, startupView: 'board', restoreNotes: false, sidebarVisible: false, inboxVisible: false, closeAction: 'background', noteColor: 'blue', taskNotifications: false };
  assert.deepEqual(preferences.value.user, expected);
  const original = await readFile(preferences.file, 'utf8');
  for (const patch of [{ startupView: 'unknown' }, { restoreNotes: 'false' }, { sidebarVisible: 'false' }, { inboxVisible: 'false' }, { boardTextFontSize: 0 }, { boardTextBackground: 'red' }, { dataPath: 'another-folder' }]) {
    await assert.rejects(preferences.update(value => { value.user = patchUserPreferences(value.user, patch); }));
    assert.equal(await readFile(preferences.file, 'utf8'), original);
  }
  const reopened = new PreferencesStore(directory); await reopened.initialize();
  assert.deepEqual(reopened.value.user, expected);
});

test('removing the default list redirects its startup page without resetting unrelated preferences', () => {
  const current = { ...defaultUserPreferences, startupView: 'inbox' as const, noteColor: 'blue' as const };
  const removed = patchUserPreferences(current, { inboxVisible: false });
  assert.equal(removed.startupView, 'all');
  assert.equal(removed.noteColor, 'blue');
  assert.equal(resolveStartupView({ startupView: 'inbox', inboxVisible: false }), 'all');
  assert.equal(patchUserPreferences(removed, { startupView: 'inbox' }).startupView, 'all');
  assert.equal(patchUserPreferences(removed, { inboxVisible: true }).startupView, 'all');
  assert.equal(patchUserPreferences({ ...current, startupView: 'board' }, { inboxVisible: false }).startupView, 'board');
});

test('creation preferences apply to new notes, linked notes and text while preserving explicit styles and existing content', () => {
  const engine = new WorkspaceEngine('preferences-test');
  const preferences = { ...defaultUserPreferences, noteColor: 'blue' as const, boardTextBackground: '#dbeafe', boardTextColor: '#123456', boardTextFontSize: 40 };
  engine.apply({ type: 'note.add', title: 'existing', color: 'rose' });
  const existing = structuredClone(engine.state.notes[0]);
  engine.apply(creationDefaults({ type: 'note.add' }, preferences));
  engine.apply(creationDefaults({ type: 'board.source.add', kind: 'note', title: 'board note', content: 'preserved' }, preferences));
  engine.apply({ type: 'task.add', title: 'linked task', listId: 'inbox' });
  const taskId = engine.state.tasks[0].id;
  engine.apply(creationDefaults({ type: 'task.link-note', id: taskId }, preferences));
  assert.deepEqual(engine.state.notes.map(note => note.values.color), ['rose', 'blue', 'blue', 'blue']);
  engine.apply(creationDefaults({ type: 'task.link-note', id: taskId }, { ...preferences, noteColor: 'green' }));
  assert.equal(engine.state.notes.length, 4); assert.equal(engine.state.notes[3].values.color, 'blue');
  engine.apply(creationDefaults({ type: 'note.add', color: 'yellow' }, preferences));
  assert.equal(engine.state.notes.at(-1)!.values.color, 'yellow');
  engine.apply(creationDefaults({ type: 'board.card.add', content: { kind: 'text', text: 'hello' }, style: { color: '#ffffff' } }, preferences));
  const card = engine.state.boardCards.at(-1)!.values;
  assert.equal(card.color, '#ffffff'); assert.equal(card.textColor, '#123456'); assert.equal(card.fontSize, 40);
  assert.deepEqual(engine.state.notes[0], existing);
});
