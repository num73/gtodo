import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IpcMainInvokeEvent, Rectangle } from 'electron';
import { ScreenCapture } from '../electron/screen-capture';
import { capturePixels } from '../src/shared/screen-capture';

test('capture rectangles use actual pixels for mixed DPI, reverse drags and viewport edges', () => {
  assert.deepEqual(capturePixels({ x: .25, y: .25, width: .5, height: .5 }, { width: 3840, height: 2160 }), { x: 960, y: 540, width: 1920, height: 1080 });
  assert.deepEqual(capturePixels({ x: 0, y: 0, width: 1, height: 1 }, { width: 2560, height: 1440 }), { x: 0, y: 0, width: 2560, height: 1440 });
  assert.deepEqual(capturePixels({ x: .1, y: .2, width: .9, height: .8 }, { width: 101, height: 101 }), { x: 10, y: 20, width: 91, height: 81 });
  for (const rect of [{ x: -1, y: 0, width: 1, height: 1 }, { x: .5, y: 0, width: 1, height: 1 }, { x: NaN, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }]) assert.throws(() => capturePixels(rect, { width: 100, height: 100 }));
  assert.throws(() => capturePixels({ x: 0, y: 0, width: .001, height: 1 }, { width: 100, height: 100 }), /太小/);
});

function fixture(fail = false) {
  const html = path.resolve('.qa/capture.html'); const windows: FakeWindow[] = []; const crops: unknown[] = [];
  class FakeWindow extends EventEmitter {
    visible = true; destroyed = false; minimized = false; focused = false;
    bounds: Rectangle;
    webContents = Object.assign(new EventEmitter(), { id: windows.length + 1, mainFrame: { url: pathToFileURL(html).href }, setZoomMode() {}, setZoomFactor() {}, setWindowOpenHandler() {} });
    constructor(options: Partial<Rectangle> & { show?: boolean } = {}) {
      super(); this.visible = options.show ?? true;
      // Mimic the initial work-area clamp: the bottom 48 DIP belong to the taskbar.
      this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 500, height: (options.height ?? 300) - 48 };
      windows.push(this);
    }
    static getAllWindows() { return windows.filter(window => !window.destroyed); }
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } isMinimized() { return this.minimized; }
    hide() { this.visible = false; } showInactive() { this.visible = true; } show() { this.visible = true; } focus() { this.focused = true; }
    setBounds(bounds: Rectangle) { this.bounds = { ...bounds }; } moveTop() {}
    setAlwaysOnTop() {} async loadFile() { if (fail) throw new Error('load failed'); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const image = { isEmpty: () => false, toPNG: () => Buffer.from('full-screen'), toDataURL: () => 'data:image/png;base64,TEST', getSize: () => ({ width: 2000, height: 1000 }), crop: (rect: unknown) => { crops.push(rect); return { toPNG: () => Buffer.from('selection') }; } };
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => [{ id: 11, bounds: { x: -1000, y: 0, width: 1000, height: 500 }, scaleFactor: 2 }, { id: 22, bounds: { x: 0, y: 0, width: 1000, height: 500 }, scaleFactor: 1 }],
    getDisplayNearestPoint: () => ({ id: 22 }), getCursorScreenPoint: () => ({ x: 10, y: 10 }),
  });
  const owner = new FakeWindow(); const note = new FakeWindow(); const minimized = new FakeWindow(); minimized.minimized = true;
  const native = { BrowserWindow: FakeWindow, screen, nativeImage: { createFromBuffer: () => image }, desktopCapturer: { getSources: async () => {
    assert.equal(owner.visible, false); assert.equal(note.visible, false);
    return [{ display_id: '22', thumbnail: image }, { display_id: '11', thumbnail: image }];
  } } } as unknown as ConstructorParameters<typeof ScreenCapture>[0]['native'];
  const manager = new ScreenCapture({ native, html, preload: 'unused-preload' });
  const event = (window: FakeWindow) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame }) as unknown as IpcMainInvokeEvent;
  const waitForOverlays = async () => {
    for (let attempt = 0; attempt < 100 && windows.length < 5; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(windows.length, 5);
    return windows.slice(3);
  };
  return { manager, owner, note, minimized, windows, event, crops, screen, waitForOverlays };
}

test('capture maps displays by ID, isolates IPC, returns only cropped bytes and restores visible windows', async () => {
  const f = fixture(); const result = f.manager.capture(f.owner as never);
  try {
    await assert.rejects(f.manager.capture(f.owner as never), /已有截图/);
    const overlays = await f.waitForOverlays();
    assert.throws(() => f.manager.preview(f.event(f.owner)), /未授权/);
    assert.throws(() => f.manager.cancelFrom({ ...f.event(overlays[0]), senderFrame: null }), /未授权/);
    for (const overlay of overlays) { assert.equal(f.manager.preview(f.event(overlay)).width, 2000); f.manager.ready(f.event(overlay)); }
    assert.ok(overlays.every(overlay => overlay.visible)); assert.equal(overlays[1].focused, true);
    assert.deepEqual(overlays.map(overlay => overlay.bounds), f.screen.getAllDisplays().map(display => display.bounds));
    f.manager.select(f.event(overlays[1]), { x: .1, y: .2, width: .5, height: .4 });
    assert.equal((await result)!.toString(), 'selection');
    assert.deepEqual(f.crops, [{ x: 200, y: 200, width: 1000, height: 400 }]);
    assert.ok(f.owner.visible && f.note.visible && f.owner.focused); assert.equal(f.minimized.minimized, true);
    assert.ok(overlays.every(overlay => overlay.destroyed)); assert.equal(f.manager.active, false);
    assert.equal(f.screen.listenerCount('display-removed'), 0);
  } finally { f.manager.cancel(); }
});

test('escape, a disappearing display and failed overlay loading restore windows without producing an image', async () => {
  for (const reason of ['escape', 'display', 'load'] as const) {
    const f = fixture(reason === 'load'); const result = f.manager.capture(f.owner as never);
    const completed = reason === 'load' ? assert.rejects(result, /load failed/) : result;
    try {
      const overlays = await f.waitForOverlays();
      if (reason === 'escape') overlays[0].webContents.emit('before-input-event', { preventDefault() {} }, { key: 'Escape' });
      if (reason === 'display') f.screen.emit('display-removed');
      if (reason === 'load') await completed; else assert.equal(await completed, null);
      assert.ok(f.owner.visible && f.note.visible); assert.equal(f.manager.active, false); assert.equal(f.crops.length, 0);
    } finally { f.manager.cancel(); }
  }
});
