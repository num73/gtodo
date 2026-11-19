import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { BrowserWindowConstructorOptions, WebContents } from 'electron';
import { PomodoroWindow } from '../electron/pomodoro-window';
import { PreferencesStore } from '../electron/preferences';
import { temporaryDirectory } from './helpers';

class FakeWindow extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, setZoomMode() {}, setZoomFactor() {}, send() {} });
  destroyed = false; visible = false; loads = 0; pinned = false;
  constructor(readonly options: BrowserWindowConstructorOptions, private load: () => Promise<void>) { super(); this.pinned = !!options.alwaysOnTop; }
  isDestroyed() { return this.destroyed; } isVisible() { return this.visible; }
  show() { this.visible = true; } showInactive() { this.show(); } focus() {} setEnabled() {}
  setAlwaysOnTop(pinned: boolean) { this.pinned = pinned; this.visible = false; }
  getNormalBounds() { return { x: this.options.x!, y: this.options.y!, width: this.options.width!, height: this.options.height! }; }
  destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
  async loadURL(url: string) { assert.equal(new URL(url).searchParams.get('window'), 'pomodoro'); this.loads++; await this.load(); }
}
async function fixture(t: Parameters<typeof temporaryDirectory>[0]) {
  const preferences = new PreferencesStore(await temporaryDirectory(t)); await preferences.initialize();
  const windows: FakeWindow[] = []; const controls = { load: async () => {} };
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  const native = { BrowserWindow: class extends FakeWindow { constructor(options: BrowserWindowConstructorOptions) { super(options, () => controls.load()); windows.push(this); } },
    screen: { getDisplayMatching: () => ({ workArea: area }), getDisplayNearestPoint: () => ({ workArea: area }), getCursorScreenPoint: () => ({ x: 10, y: 10 }) }, dialog: { showErrorBox() {} } } as unknown as ConstructorParameters<typeof PomodoroWindow>[0]['native'];
  const timerWindow = new PomodoroWindow({ preferences, native, publish() {}, quitting: () => false, report() {}, preload: '', icon: '', url: 'gtodo://app/index.html' });
  return { preferences, windows, controls, timerWindow };
}

test('independent timer window retries loading, avoids duplicates, and remembers pin and bounds across reopening', async t => {
  const f = await fixture(t); let attempts = 0;
  f.controls.load = async () => { assert.equal(f.windows[0].visible, false); if (++attempts === 1) throw new Error('ERR_FAILED'); };
  await Promise.all([f.timerWindow.open(), f.timerWindow.open()]);
  assert.equal(f.windows.length, 1); assert.equal(f.windows[0].loads, 2); assert.equal(f.timerWindow.hasVisible(), true);
  assert.equal(f.windows[0].options.parent, undefined); assert.equal(f.windows[0].options.frame, false);
  assert.equal(f.timerWindow.owns(f.windows[0].webContents as unknown as WebContents), true);
  f.windows[0].options.x = 100; f.windows[0].options.width = 450;
  await f.timerWindow.pin(true); assert.equal(f.timerWindow.hasVisible(), true); await f.timerWindow.hide();
  assert.equal(f.windows[0].destroyed, true); assert.equal(f.preferences.value.pomodoroWindow.open, false);
  f.controls.load = async () => {};
  await f.timerWindow.open(); assert.equal(f.windows[1].pinned, true); assert.equal(f.windows[1].options.width, 450); assert.equal(f.windows[1].options.x, 100);
  const reopened = new PreferencesStore(f.preferences.directory); await reopened.initialize();
  assert.equal(reopened.value.pomodoroWindow.open, true); assert.equal(reopened.value.pomodoroWindow.pinned, true);
  await f.timerWindow.hide();
});

test('a failed timer load cleans up the invisible window and allows a later retry', async t => {
  const f = await fixture(t); f.controls.load = async () => { throw new Error('ERR_FAILED'); };
  await assert.rejects(f.timerWindow.open(), /计时状态已保留/);
  assert.equal(f.windows[0].destroyed, true); assert.equal(f.preferences.value.pomodoroWindow.open, false);
  assert.equal(f.timerWindow.owns(f.windows[0].webContents as unknown as WebContents), false);
  f.controls.load = async () => {}; await f.timerWindow.open(); assert.equal(f.windows.length, 2); assert.equal(f.timerWindow.hasVisible(), true);
  await f.timerWindow.hide();
});

test('closing during timer loading is serialized and restores off-screen bounds inside the current display', async t => {
  const f = await fixture(t);
  await f.preferences.update(value => { value.pomodoroWindow.bounds = { x: 8000, y: -3000, width: 360, height: 530 }; });
  let finish!: () => void; f.controls.load = () => new Promise(resolve => { finish = resolve; });
  const opening = f.timerWindow.open();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const hiding = f.timerWindow.hide(); assert.equal(f.windows[0].destroyed, false);
  finish(); await Promise.all([opening, hiding]);
  assert.equal(f.windows[0].options.x, 1560); assert.equal(f.windows[0].options.y, 0);
  assert.equal(f.timerWindow.hasVisible(), false); assert.equal(f.preferences.value.pomodoroWindow.open, false);
});
