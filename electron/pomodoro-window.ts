import type { BrowserWindow, WebContents } from 'electron';
import type { PreferencesStore } from './preferences';

/** A single independent view of the timer, which continues to run in the main process. */
export class PomodoroWindow {
  private window: BrowserWindow | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private boundsTimer?: ReturnType<typeof setTimeout>;
  constructor(private options: {
    preferences: PreferencesStore; publish: () => void; quitting: () => boolean; preload: string; icon: string; url: string;
    native: Pick<typeof import('electron'), 'BrowserWindow' | 'dialog' | 'screen'>;
    report: (event: string, details: Record<string, unknown>) => void;
  }) {}
  private enqueue<T>(action: () => Promise<T>) {
    const next = this.queue.then(action); this.queue = next.catch(() => {}); return next;
  }
  owns(sender: WebContents) { return !!this.window && !this.window.isDestroyed() && this.window.webContents === sender; }
  hasVisible() { return !!this.window && !this.window.isDestroyed() && this.window.isVisible(); }
  send(channel: string, value: unknown) { if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, value); }
  setEnabled(enabled: boolean) { if (this.window && !this.window.isDestroyed()) this.window.setEnabled(enabled); }
  async saveBounds() {
    clearTimeout(this.boundsTimer);
    const current = this.window; if (!current || current.isDestroyed()) return;
    const bounds = current.getNormalBounds();
    await this.options.preferences.update(value => { value.pomodoroWindow.bounds = bounds; });
  }
  private remember() {
    clearTimeout(this.boundsTimer);
    this.boundsTimer = setTimeout(() => { void this.saveBounds().catch(error => this.options.report('pomodoro-window-bounds-failed', { error: String(error) })); }, 350);
  }
  open(focus = true) { return this.enqueue(async () => {
    if (this.options.quitting()) return;
    if (this.window && !this.window.isDestroyed()) {
      if (focus) { this.window.show(); this.window.focus(); } else this.window.showInactive();
      return;
    }
    const prior = this.options.preferences.value.pomodoroWindow;
    const { BrowserWindow, screen, dialog } = this.options.native;
    const area = prior.bounds ? screen.getDisplayMatching(prior.bounds).workArea : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(prior.bounds?.width ?? 360, area.width); const height = Math.min(prior.bounds?.height ?? 530, area.height);
    const x = Math.max(area.x, Math.min(prior.bounds?.x ?? area.x + area.width - width - 60, area.x + area.width - width));
    const y = Math.max(area.y, Math.min(prior.bounds?.y ?? area.y + 80, area.y + area.height - height));
    const current = new BrowserWindow({
      x, y, width, height, minWidth: 280, minHeight: 320, frame: false, resizable: true, maximizable: false, minimizable: false,
      show: false, skipTaskbar: true, alwaysOnTop: false, backgroundColor: '#ffffff', title: '番茄钟 · GTodo', icon: this.options.icon,
      webPreferences: { preload: this.options.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, zoomFactor: 1 },
    });
    this.window = current;
    current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    current.webContents.on('will-navigate', event => event.preventDefault());
    current.webContents.setZoomMode('isolated');
    current.webContents.on('did-finish-load', () => { if (!current.isDestroyed()) current.webContents.setZoomFactor(1); });
    current.on('page-title-updated', event => event.preventDefault());
    current.on('resize', () => this.remember()); current.on('move', () => this.remember());
    current.on('close', event => {
      if (this.options.quitting()) return;
      event.preventDefault(); void this.hide().catch(error => dialog.showErrorBox('番茄钟尚未收起', String(error)));
    });
    current.on('closed', () => { if (this.window === current) { clearTimeout(this.boundsTimer); this.window = null; } });
    const url = new URL(this.options.url); url.searchParams.set('window', 'pomodoro');
    try {
      for (let attempt = 1; ; attempt++) {
        try { await current.loadURL(url.href); break; }
        catch (error) {
          this.options.report('pomodoro-window-load-failed', { attempt, error: String(error) });
          if (attempt >= 2 || current.isDestroyed() || this.options.quitting()) throw error;
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }
      if (current.isDestroyed() || this.options.quitting()) return;
      await this.options.preferences.update(value => { value.pomodoroWindow.open = true; });
      if (prior.pinned) current.setAlwaysOnTop(true, 'pop-up-menu');
      if (focus) { current.show(); current.focus(); } else current.showInactive();
      this.options.publish();
    } catch (error) {
      if (!current.isDestroyed()) current.destroy();
      await this.options.preferences.update(value => { value.pomodoroWindow.open = false; });
      throw new Error('番茄钟窗口暂时无法打开，请重试。计时状态已保留。', { cause: error });
    }
  }); }
  hide() { return this.enqueue(async () => {
    await this.saveBounds();
    await this.options.preferences.update(value => { value.pomodoroWindow.open = false; });
    this.window?.destroy(); this.options.publish();
  }); }
  pin(pinned: boolean) { return this.enqueue(async () => {
    await this.options.preferences.update(value => { value.pomodoroWindow.pinned = pinned; });
    const visible = this.hasVisible();
    this.window?.setAlwaysOnTop(pinned, pinned ? 'pop-up-menu' : 'normal');
    // Windows can hide a frameless window while changing its native z-order.
    if (visible) this.window?.show();
    this.options.publish();
  }); }
  async flush() { await this.queue; await this.saveBounds(); }
}
