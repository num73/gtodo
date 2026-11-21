import { app, BrowserWindow, Notification, Tray } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

assert.ok(process.env.GTODO_DATA_DIR?.startsWith(path.resolve('.qa') + path.sep), 'Use an isolated test profile');
const phase = process.env.GTODO_SETTINGS_PHASE!;
app.getAppPath = () => path.resolve('.');
app.getVersion = () => require(path.resolve('package.json')).version;
// Keep actual notifications off the user's desktop. Exercise the main process
// callbacks using a controlled clock and interval triggers in this process only.
let notifications = 0, offset = 0;
Notification.prototype.show = () => { notifications++; };
Tray.prototype.displayBalloon = () => { notifications++; };
const originalNow = Date.now; Date.now = () => originalNow() + offset;
let reminderTick: (() => void) | undefined, timerTick: (() => void) | undefined;
const interval = globalThis.setInterval;
globalThis.setInterval = ((handler: (...args: any[]) => void, ms: number, ...args: any[]) => {
  if (ms === 15000) reminderTick = () => handler(...args);
  if (ms === 1000) timerTick = () => handler(...args);
  return interval(ms === 15000 || ms === 1000 ? () => {} : handler, ms, ...args);
}) as typeof setInterval;
require(path.resolve('dist-electron/main.cjs'));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  for (let i = 0; i < 240; i++) { const value = await read(); if (value) return value as NonNullable<T>; await pause(25); }
  throw new Error(`Timeout: ${label}`);
}
const result = (value: unknown) => writeFile(path.join(__dirname, `${phase}.json`), JSON.stringify(value, null, 2));
void (async () => {
  await app.whenReady();
  const main = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('index.html')), 'main');
  const evaluate = <T = any>(code: string): Promise<T> => main.webContents.executeJavaScript(code);
  await until(() => evaluate('!!document.querySelector(".app-body")'), 'rendered');
  await until(() => reminderTick && timerTick, 'startup restored');
  const get = () => evaluate('window.gtodo.getState()');
  if (phase === 'seed') {
    await evaluate('window.gtodo.setPreferences({startupView:"board",closeAction:"background",noteColor:"blue",taskNotifications:false,pomodoroNotifications:false})');
    main.close(); await until(() => !main.isVisible(), 'background close');
    assert.equal(main.isDestroyed(), false);
    main.show(); main.focus();
    const id = await evaluate('window.gtodo.createNote({title:"默认蓝色便签",content:"重启保留"})');
    const note = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes(`note=${id}`)), 'note');
    await until(() => note.isVisible(), 'note visible');
    assert.equal((await get()).workspace.notes[0].values.color, 'blue');
    assert.equal(await note.webContents.executeJavaScript('window.gtodo.setPreferences({closeAction:"quit"}).then(()=>false,()=>true)'), true, 'note IPC cannot change main settings');
    await evaluate('window.gtodo.openPomodoro()');
    await evaluate('window.gtodo.setPreferences({restoreNotes:false,restorePomodoro:false})');
    assert.equal(note.isVisible(), true, 'changing startup options must not close current notes');
    assert.ok(BrowserWindow.getAllWindows().some(window => window.isVisible() && window.webContents.getURL().includes('window=pomodoro')));
    assert.equal(await evaluate('window.gtodo.setPreferences({startupView:"unknown"}).then(()=>false,()=>true)'), true);

    await evaluate('window.gtodo.command({type:"task.add",title:"通知测试",listId:"inbox"})');
    const taskId = (await get()).workspace.tasks[0].id;
    await evaluate(`window.gtodo.command({type:"task.update",id:${JSON.stringify(taskId)},patch:{reminder:${JSON.stringify(new Date(Date.now() - 1000).toISOString())}}})`);
    reminderTick!(); assert.equal(notifications, 0);
    await evaluate('window.gtodo.setPreferences({taskNotifications:true})');
    reminderTick!(); assert.equal(notifications, 0, 'muted reminder is not replayed in this session');
    await evaluate(`window.gtodo.command({type:"task.update",id:${JSON.stringify(taskId)},patch:{reminder:${JSON.stringify(new Date(Date.now() - 2000).toISOString())}}})`);
    reminderTick!(); assert.equal(notifications, 1);
    await evaluate('window.gtodo.pomodoroCommand({type:"configure",settings:{focusMinutes:1,shortBreakMinutes:1,longBreakMinutes:1,longBreakEvery:4}})');
    await evaluate('window.gtodo.pomodoroCommand({type:"start"})');
    offset += 61000; timerTick!();
    await until(async () => (await evaluate('window.gtodo.getPomodoro()')).today.completed === 1, 'muted timer completed');
    assert.equal(notifications, 1);
    await evaluate('window.gtodo.setPreferences({pomodoroNotifications:true})');
    await evaluate('window.gtodo.pomodoroCommand({type:"select",phase:"focus"})');
    await evaluate('window.gtodo.pomodoroCommand({type:"start"})');
    offset += 61000; timerTick!();
    await until(async () => (await evaluate('window.gtodo.getPomodoro()')).today.completed === 2, 'enabled timer completed');
    assert.equal(notifications, 2);
    await evaluate(`window.gtodo.command({type:"task.update",id:${JSON.stringify(taskId)},patch:{reminder:null}})`);

    main.show(); main.focus(); main.setContentSize(900, 800);
    await evaluate('document.querySelector("[aria-label=打开设置]").click()');
    await until(() => evaluate('!!document.querySelector(".settings-tabs")'), 'settings');
    for (const index of [0, 1, 2, 3]) {
      await evaluate(`document.getElementById('settings-tab-${index}').click()`);
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await writeFile(path.join(__dirname, `settings-${index}.png`), (await main.webContents.capturePage()).toPNG());
    }
    await evaluate('window.gtodo.setZoom(200)'); main.setContentSize(720, 720);
    for (const index of [0, 1, 2, 3]) {
      await evaluate(`document.getElementById('settings-tab-${index}').click()`);
      await pause(80);
      const sizes = await evaluate('(()=>{const dialog=document.querySelector("dialog");return {scroll:dialog.scrollWidth,width:dialog.clientWidth}})()');
      assert.ok(sizes.scroll <= sizes.width + 1, `category ${index} overflows at 200%: ${JSON.stringify(sizes)}`);
    }
    await evaluate('window.gtodo.setZoom(100)');
    await result({ passed: true, notifications, checks: ['background close', 'default color', 'IPC validation and isolation', 'notifications muted and enabled', 'settings layout at 100% and 200%'] });
    await evaluate('window.gtodo.quit()');
  } else if (phase === 'quiet') {
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    assert.equal(await evaluate('document.querySelector("h1").textContent'), '我的看板');
    const state = await get();
    assert.equal(state.preferences.noteColor, 'blue');
    assert.equal(state.noteWindows[state.workspace.notes[0].id].open, false);
    assert.equal(state.pomodoroWindow.open, false);
    const saved = JSON.parse(await readFile(path.join(process.env.GTODO_DATA_DIR!, 'preferences.json'), 'utf8'));
    assert.equal(saved.noteWindows[state.workspace.notes[0].id].open, true, 'saved restoration history remains available');
    await evaluate('window.gtodo.setPreferences({restoreNotes:true,restorePomodoro:true,closeAction:"auto"})');
    await result({ passed: true, checks: ['preferences survive restart', 'restoration off preserves content and window history', 'auto close quits with no active windows'] });
    main.close();
  } else {
    const note = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('note=')), 'restored note');
    assert.equal(note.isVisible(), true);
    assert.ok(BrowserWindow.getAllWindows().some(window => window.isVisible() && window.webContents.getURL().includes('window=pomodoro')));
    main.close(); await until(() => !main.isVisible(), 'auto close keeps restored windows');
    main.show(); main.focus();
    await evaluate('window.gtodo.setPreferences({closeAction:"quit"})');
    await evaluate('window.gtodo.pomodoroCommand({type:"select",phase:"focus"})');
    await evaluate('window.gtodo.pomodoroCommand({type:"start"})');
    await note.webContents.executeJavaScript(`(() => {
      const field = document.querySelector('textarea[aria-label="便签内容"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, '退出时的最后输入');
      field.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    await result({ passed: true, checks: ['restoration on', 'auto close keeps active windows', 'quit close saves all windows and pauses timer'] });
    main.close();
  }
})().catch(async error => { await result({ passed: false, error: String(error), stack: error.stack }); app.exit(1); });
