import { app, BrowserWindow, dialog, protocol, screen } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { NoteWindows } from '../electron/note-windows';
import { DataStore } from '../electron/storage';
import { PreferencesStore } from '../electron/preferences';
import { PomodoroWindow } from '../electron/pomodoro-window';

const directory = path.join(__dirname, 'profile');
app.setName('GTodo Note Test'); app.setPath('userData', directory);
protocol.registerSchemesAsPrivileged([{ scheme: 'gtodo', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.on('window-all-closed', () => {});
let quitting = false;
void app.whenReady().then(async () => {
  const store = new DataStore(directory); await store.initialize();
  const preferences = new PreferencesStore(directory); await preferences.initialize();
  await store.update(engine => {
    engine.apply({ type: 'note.add', title: '窗口加载测试（测试）', content: '中文备注\n保留换行与内容' });
    engine.apply({ type: 'note.add', title: '失败恢复测试（测试）', content: '失败后重新打开同一张便签' });
  });
  const [first, second] = store.engine.state.notes;
  const attempts = new Map<string, number>();
  let persistentFailure = true;
  protocol.handle('gtodo', request => {
    const id = new URL(request.url).searchParams.get('note')!;
    attempts.set(id, (attempts.get(id) ?? 0) + 1);
    if ((id === first.id && attempts.get(id) === 1) || (id === second.id && persistentFailure)) return Response.error();
    return new Response('<!doctype html><meta charset="utf-8"><title>GTodo window test</title><p>Native note load test</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  });
  const reports: { event: string; details: Record<string, unknown> }[] = [];
  const notes = new NoteWindows({ preferences, workspace: () => store.engine.state, publish() {}, native: { BrowserWindow, screen, dialog },
    report: (event, details) => reports.push({ event, details }), quitting: () => quitting,
    preload: path.resolve('dist-electron/preload.cjs'), icon: path.resolve('assets/icon.png'), url: 'gtodo://app/index.html' });
  await Promise.all([notes.open(first.id), notes.open(first.id)]);
  assert.equal(attempts.get(first.id), 2);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  assert.equal(BrowserWindow.getAllWindows()[0].isVisible(), true);
  assert.match(String(reports[0].details.error), /ERR_FAILED \(-2\)/);
  await notes.hide(first.id, false);
  await assert.rejects(notes.open(second.id), /便签已保存/);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  assert.equal(preferences.value.noteWindows[second.id].open, false);
  persistentFailure = false;
  await notes.open(second.id);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  assert.equal(BrowserWindow.getAllWindows()[0].webContents.getURL(), `gtodo://app/index.html?note=${second.id}`);
  await notes.pin(second.id, true);
  assert.equal(BrowserWindow.getAllWindows()[0].isAlwaysOnTop(), true);
  assert.equal(BrowserWindow.getAllWindows()[0].isVisible(), true);
  await notes.pin(second.id, false);
  assert.equal(store.engine.state.notes.length, 2);
  const reopened = new DataStore(directory); await reopened.initialize();
  assert.deepEqual(reopened.engine.state, store.engine.state);
  const timerWindow = new PomodoroWindow({ preferences, publish() {}, native: { BrowserWindow, screen, dialog }, report: (event, details) => reports.push({ event, details }), quitting: () => quitting,
    preload: path.resolve('dist-electron/preload.cjs'), icon: path.resolve('assets/icon.png'), url: 'gtodo://app/index.html' });
  await timerWindow.open();
  const nativeTimer = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('?window=pomodoro'))!;
  assert.ok(nativeTimer); assert.equal(nativeTimer.isVisible(), true);
  await timerWindow.pin(true); assert.equal(nativeTimer.isAlwaysOnTop(), true); assert.equal(nativeTimer.isVisible(), true);
  await timerWindow.pin(false); assert.equal(nativeTimer.isAlwaysOnTop(), false); assert.equal(nativeTimer.isVisible(), true);
  await timerWindow.pin(true);
  await timerWindow.hide(); assert.equal(nativeTimer.isDestroyed(), true); assert.equal(preferences.value.pomodoroWindow.open, false);
  await timerWindow.open(false);
  const restoredTimer = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('?window=pomodoro'))!;
  assert.equal(restoredTimer.isAlwaysOnTop(), true); assert.equal(restoredTimer.isVisible(), true);
  await timerWindow.hide();
  await writeFile(path.join(__dirname, 'result.json'), JSON.stringify({ passed: true, reports, attempts: Object.fromEntries(attempts) }, null, 2));
  console.log('Native Electron window recovery, timer pin/hide and saved-content checks passed.');
}).then(() => {
  quitting = true; for (const window of BrowserWindow.getAllWindows()) window.destroy(); app.quit();
}).catch(async error => {
  console.error(error);
  await writeFile(path.join(__dirname, 'result.json'), JSON.stringify({ passed: false, error: String(error) }));
  app.exit(1);
});
