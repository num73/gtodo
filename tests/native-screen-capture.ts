import { app, BrowserWindow, ipcMain, nativeImage, screen, type DesktopCapturer, type IpcMainInvokeEvent } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { ScreenCapture } from '../electron/screen-capture';
import { capturePixels } from '../src/shared/screen-capture';

app.setName('GTodo Capture Test');
app.setPath('userData', path.join(__dirname, 'profile'));
if (process.env.GTODO_CAPTURE_TEST_SCALE) app.commandLine.appendSwitch('force-device-scale-factor', process.env.GTODO_CAPTURE_TEST_SCALE);
app.on('window-all-closed', () => {});
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

void app.whenReady().then(async () => {
  const displays = screen.getAllDisplays();
  // Use synthetic screen images: these tests never read or save the user's desktop.
  const sources = displays.map(display => {
    const size = { width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor) };
    return { display_id: String(display.id), thumbnail: nativeImage.createFromBitmap(Buffer.alloc(size.width * size.height * 4, 240), size) };
  });
  const manager = new ScreenCapture({
    native: { BrowserWindow, screen, nativeImage, desktopCapturer: { getSources: async () => sources } as unknown as DesktopCapturer },
    html: path.resolve('dist-electron/capture.html'), preload: path.resolve('dist-electron/capture-preload.cjs'),
  });
  ipcMain.handle('gtodo:capture-preview', event => manager.preview(event));
  ipcMain.handle('gtodo:capture-ready', event => manager.ready(event));
  ipcMain.handle('gtodo:capture-select', (event, value) => manager.select(event, value));
  ipcMain.handle('gtodo:capture-cancel', event => manager.cancelFrom(event));
  const owner = new BrowserWindow({ width: 420, height: 280, show: true, title: 'GTodo 截图测试', webPreferences: { sandbox: true, contextIsolation: true } });
  owner.setAlwaysOnTop(true, 'pop-up-menu');
  owner.show();
  assert.equal(owner.isVisible(), true);
  const originalBounds = owner.getBounds();
  const reports: unknown[] = [];
  try {
    for (const action of ['select-bottom-edge', 'cancel'] as const) {
      const capture = manager.capture(owner);
      // Attach immediately so startup errors are reported instead of unhandled.
      const result = capture.then(bytes => ({ bytes, error: null }), error => ({ bytes: null, error }));
      let overlays: BrowserWindow[] = [];
      for (let attempt = 0; attempt < 200; attempt++) {
        overlays = BrowserWindow.getAllWindows().filter(window => window !== owner);
        if (overlays.length === displays.length && overlays.every(window => window.isVisible())) break;
        if (!manager.active) throw (await result).error ?? new Error('Capture ended before becoming visible');
        await pause(25);
      }
      assert.equal(overlays.length, displays.length);
      assert.ok(overlays.every(window => window.isVisible()));
      assert.equal(owner.isVisible(), false);
      for (const window of overlays) {
        const display = screen.getDisplayMatching(window.getBounds());
        // This fails on the old implementation: a 2560x1440 display rendered into
        // a 2576x1400 window, exposing another live taskbar below the still image.
        assert.deepEqual(window.getBounds(), display.bounds);
        assert.deepEqual(window.getContentBounds(), display.bounds);
        const viewport = await window.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })');
        assert.equal(viewport.width, display.bounds.width);
        assert.equal(viewport.height, display.bounds.height);
        assert.equal(window.webContents.getZoomFactor(), 1);
        assert.equal(window.isAlwaysOnTop(), true);
        reports.push({ action, display: display.id, bounds: window.getBounds(), workArea: display.workArea, viewport });
      }
      if (action === 'select-bottom-edge') {
        const window = overlays[0];
        const display = screen.getDisplayMatching(window.getBounds());
        const size = sources.find(source => source.display_id === String(display.id))!.thumbnail.getSize();
        const selection = { x: 0, y: .9, width: 1, height: .1 };
        manager.select({ sender: window.webContents, senderFrame: window.webContents.mainFrame } as IpcMainInvokeEvent, selection);
        const captured = await result; if (captured.error) throw captured.error;
        assert.ok(captured.bytes);
        const actual = nativeImage.createFromBuffer(captured.bytes).getSize();
        const expected = capturePixels(selection, size);
        assert.deepEqual(actual, { width: expected.width, height: expected.height });
      } else {
        manager.cancel();
        const canceled = await result; if (canceled.error) throw canceled.error;
        assert.equal(canceled.bytes, null);
      }
      assert.ok(overlays.every(window => window.isDestroyed()));
      assert.equal(owner.isVisible(), true);
      assert.equal(owner.isAlwaysOnTop(), true);
      assert.deepEqual(owner.getBounds(), originalBounds);
    }
    await writeFile(path.join(__dirname, 'result.json'), JSON.stringify({ passed: true, reports }, null, 2));
    console.log('Native capture covers every full display, preserves pixel coordinates and restores the owner.');
  } finally { manager.cancel(); owner.destroy(); }
}).then(() => app.quit()).catch(async error => {
  console.error(error);
  await writeFile(path.join(__dirname, 'result.json'), JSON.stringify({ passed: false, error: String(error) }));
  app.exit(1);
});
