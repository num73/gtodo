import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { BrowserWindowConstructorOptions, WebContents } from 'electron';
import { NoteWindows } from '../electron/note-windows';
import { PreferencesStore } from '../electron/preferences';
import { WorkspaceEngine } from '../src/shared/engine';
import { temporaryDirectory } from './helpers';

class FakeContents extends EventEmitter {
  setWindowOpenHandler() {}
  setZoomMode() {}
  setZoomFactor() {}
  isCrashed() { return false; }
  send(channel: string, ...args: unknown[]) { this.emit('sent', channel, ...args); }
}
class FakeWindow extends EventEmitter {
  webContents = new FakeContents();
  destroyed = false;
  visible = false;
  enabled = true;
  loads: string[] = [];
  constructor(readonly options: BrowserWindowConstructorOptions, private load: (url: string) => Promise<void>) { super(); }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  getNormalBounds() { return { x: 0, y: 0, width: 350, height: 390 }; }
  getTitle() { return this.options.title; }
  setTitle(title: string) { this.options.title = title; }
  setAlwaysOnTop() {}
  setEnabled(enabled: boolean) { this.enabled = enabled; }
  show() { this.visible = true; }
  showInactive() { this.show(); }
  focus() {}
  destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
  async loadURL(url: string) {
    this.loads.push(url);
    // Electron can emit ready-to-show for an error page, too.
    this.emit('ready-to-show');
    await this.load(url);
    this.emit('did-finish-load');
  }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const failed = () => Object.assign(new Error('ERR_FAILED (-2) loading gtodo://app/index.html'), { code: 'ERR_FAILED', errno: -2 });
async function fixture(t: Parameters<typeof temporaryDirectory>[0]) {
  const preferences = new PreferencesStore(await temporaryDirectory(t)); await preferences.initialize();
  const engine = new WorkspaceEngine(crypto.randomUUID());
  engine.apply({ type: 'task.add', title: '原任务', listId: 'inbox' });
  engine.apply({ type: 'note.add', title: '备注副本', content: '中文备注\n第二行' });
  const id = engine.state.notes[0].id;
  const windows: FakeWindow[] = [];
  const reports: { event: string; details: Record<string, unknown> }[] = [];
  const controls = { load: async (_url: string) => {}, flushed: true, quitting: false };
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  const native = {
    BrowserWindow: class extends FakeWindow {
      constructor(options: BrowserWindowConstructorOptions) {
        super(options, url => controls.load(url)); windows.push(this);
        this.webContents.on('sent', (channel, requestId) => {
          if (channel === 'gtodo:note-flush') notes.acknowledge(this.webContents as unknown as WebContents, requestId, controls.flushed);
        });
      }
    },
    screen: { getDisplayMatching: () => ({ workArea: area }), getDisplayNearestPoint: () => ({ workArea: area }), getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    dialog: { showErrorBox() {} },
  } as unknown as ConstructorParameters<typeof NoteWindows>[0]['native'];
  const notes = new NoteWindows({ preferences, workspace: () => engine.state, native,
    publish() {}, report: (event, details) => reports.push({ event, details }),
    quitting: () => controls.quitting, preload: '', icon: '', url: 'gtodo://app/index.html' });
  return { notes, preferences, engine, id, windows, reports, controls };
}

test('a transient ERR_FAILED retries the same saved note before showing its window', async t => {
  const f = await fixture(t); const before = structuredClone(f.engine.state); let attempts = 0;
  f.controls.load = async () => {
    assert.equal(f.windows[0].visible, false);
    if (++attempts === 1) throw failed();
  };
  await f.notes.open(f.id);
  assert.equal(attempts, 2); assert.equal(f.windows.length, 1); assert.equal(f.windows[0].visible, true);
  assert.equal(f.preferences.value.noteWindows[f.id].open, true);
  assert.equal(f.reports.length, 1); assert.deepEqual(f.engine.state, before);
  assert.equal(new URL(f.windows[0].loads[1]).searchParams.get('note'), f.id);
});

test('persistent load failure removes the blank window and allows reopening without creating another note', async t => {
  const f = await fixture(t); f.controls.load = async () => { throw failed(); };
  await assert.rejects(f.notes.open(f.id), /便签已保存/);
  assert.equal(f.windows[0].loads.length, 2); assert.equal(f.windows[0].destroyed, true);
  assert.equal(f.notes.hasVisible(), false);
  assert.equal(f.notes.owner(f.windows[0].webContents as unknown as WebContents), undefined);
  assert.equal(f.preferences.value.noteWindows[f.id].open, false);
  f.controls.load = async () => {}; await f.notes.open(f.id);
  assert.equal(f.windows.length, 2); assert.equal(f.windows[1].visible, true);
  assert.equal(f.engine.state.notes.length, 1); assert.equal(f.engine.state.notes[0].values.content, '中文备注\n第二行');
});

test('overlapping open requests wait for loading and never display a pending window', async t => {
  const f = await fixture(t); const entered = deferred(); const gate = deferred();
  f.controls.load = async () => { entered.resolve(); await gate.promise; };
  const first = f.notes.open(f.id); await entered.promise;
  let secondFinished = false;
  const second = f.notes.open(f.id).then(() => { secondFinished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.windows.length, 1); assert.equal(f.windows[0].visible, false); assert.equal(secondFinished, false);
  gate.resolve(); await Promise.all([first, second]);
  assert.equal(f.windows.length, 1); assert.equal(f.windows[0].loads.length, 1); assert.equal(f.windows[0].visible, true);
});

test('open, hide and reopen finish in order without destroying the replacement window', async t => {
  const f = await fixture(t); const entered = deferred(); const gate = deferred();
  f.controls.load = async () => { entered.resolve(); await gate.promise; };
  const first = f.notes.open(f.id); await entered.promise;
  const hide = f.notes.hide(f.id); const reopen = f.notes.open(f.id);
  gate.resolve(); await Promise.all([first, hide, reopen]);
  assert.equal(f.windows.length, 2); assert.equal(f.windows[0].destroyed, true);
  assert.equal(f.windows[1].visible, true); assert.equal(f.windows[1].destroyed, false);
  assert.equal(f.notes.owner(f.windows[1].webContents as unknown as WebContents), f.id);
  assert.equal(f.preferences.value.noteWindows[f.id].open, true);
});

test('one failed restored note does not prevent the remaining notes or main app from starting', async t => {
  const f = await fixture(t); f.engine.apply({ type: 'note.add', title: '第二张' });
  const secondId = f.engine.state.notes[1].id;
  await f.preferences.update(value => {
    value.noteWindows[f.id] = { open: true, pinned: true };
    value.noteWindows[secondId] = { open: true, pinned: false };
  });
  f.controls.load = async url => { if (new URL(url).searchParams.get('note') === f.id) throw failed(); };
  assert.equal(await f.notes.restore(), 1);
  assert.equal(f.preferences.value.noteWindows[f.id].open, false);
  assert.equal(f.preferences.value.noteWindows[f.id].pinned, true);
  assert.equal(f.preferences.value.noteWindows[secondId].open, true);
  assert.equal(f.windows[1].visible, true);
});

test('a failed draft flush keeps the visible note editable and a later hide can succeed', async t => {
  const f = await fixture(t); await f.notes.open(f.id); f.controls.flushed = false;
  await assert.rejects(f.notes.hide(f.id), /内容尚未保存/);
  assert.equal(f.windows[0].visible, true); assert.equal(f.windows[0].enabled, true);
  assert.equal(f.preferences.value.noteWindows[f.id].open, true);
  f.controls.flushed = true; await f.notes.hide(f.id);
  assert.equal(f.windows[0].destroyed, true); assert.equal(f.preferences.value.noteWindows[f.id].open, false);
});
