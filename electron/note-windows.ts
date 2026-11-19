import type { BrowserWindow, WebContents } from 'electron';
import type { AppState, Workspace } from '../src/shared/model';
import type { PreferencesStore } from './preferences';

export class NoteWindows {
  private windows = new Map<string, BrowserWindow>();
  private boundsTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private flushRequests = new Map<string, { sender: WebContents; finish: (success: boolean) => void }>();
  private operations = new Map<string, Promise<unknown>>();
  constructor(private options: {
    preferences: PreferencesStore; workspace: () => Workspace; publish: () => void;
    quitting: () => boolean; preload: string; icon: string; url: string;
    native: Pick<typeof import('electron'), 'BrowserWindow' | 'dialog' | 'screen'>;
    report: (event: string, details: Record<string, unknown>) => void;
  }) {}
  private enqueue<T>(id: string, action: () => Promise<T>): Promise<T> {
    const operation = (this.operations.get(id) ?? Promise.resolve()).then(action);
    const settled = operation.catch(() => {});
    this.operations.set(id, settled);
    void settled.then(() => { if (this.operations.get(id) === settled) this.operations.delete(id); });
    return operation;
  }
  owner(sender: WebContents) {
    return [...this.windows].find(([, window]) => !window.isDestroyed() && window.webContents === sender)?.[0];
  }
  hasVisible() { return [...this.windows.values()].some(window => !window.isDestroyed() && window.isVisible()); }
  private getNote(id: string) { return this.options.workspace().notes.find(note => note.id === id); }
  private async saveBounds(id: string, window: BrowserWindow) {
    if (window.isDestroyed()) return;
    const bounds = window.getNormalBounds();
    await this.options.preferences.update(value => {
      const previous = value.noteWindows[id] ?? { open: window.isVisible(), pinned: false };
      value.noteWindows[id] = { ...previous, bounds };
    });
  }
  private remember(id: string, window: BrowserWindow) {
    clearTimeout(this.boundsTimers.get(id));
    this.boundsTimers.set(id, setTimeout(() => {
      this.boundsTimers.delete(id);
      void this.saveBounds(id, window).catch(() => {});
    }, 350));
  }
  open(id: string, focus = true) { return this.enqueue(id, () => this.openSaved(id, focus)); }
  private async openSaved(id: string, focus: boolean) {
    if (this.options.quitting()) return;
    const note = this.getNote(id);
    if (!note || note.values.deleted) throw new Error('这张便签已不存在，请重新选择。');
    const prior = this.options.preferences.value.noteWindows[id] ?? { open: false, pinned: false };
    // Window visibility and coordinates belong to this computer, not the shared folder.
    await this.options.preferences.update(value => { value.noteWindows[id] = { ...value.noteWindows[id] ?? prior, open: true }; });
    let window = this.windows.get(id);
    if (window && !window.isDestroyed()) {
      if (focus) { window.show(); window.focus(); } else window.showInactive();
      this.options.publish(); return;
    }
    const { BrowserWindow, screen, dialog } = this.options.native;
    const area = prior.bounds ? screen.getDisplayMatching(prior.bounds).workArea : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(prior.bounds?.width ?? 350, area.width);
    const height = Math.min(prior.bounds?.height ?? 390, area.height);
    const offset = (this.windows.size % 7) * 24;
    const x = Math.max(area.x, Math.min(prior.bounds?.x ?? area.x + area.width - width - 38 - offset, area.x + area.width - width));
    const y = Math.max(area.y, Math.min(prior.bounds?.y ?? area.y + 70 + offset, area.y + area.height - height));
    window = new BrowserWindow({
      x, y, width, height, minWidth: 260, minHeight: 240, resizable: true, frame: false,
      show: false, maximizable: false, minimizable: false, skipTaskbar: true,
      alwaysOnTop: prior.pinned, backgroundColor: '#fff3ba', icon: this.options.icon,
      title: `便签 · ${note.values.title.trim() || '未命名便签'}`,
      webPreferences: { preload: this.options.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, zoomFactor: 1 },
    });
    const current = window;
    this.windows.set(id, current);
    current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    current.webContents.on('will-navigate', event => event.preventDefault());
    current.webContents.setZoomMode('isolated');
    current.webContents.on('did-finish-load', () => { if (!current.isDestroyed()) current.webContents.setZoomFactor(1); });
    current.on('page-title-updated', event => event.preventDefault());
    current.on('resize', () => this.remember(id, current));
    current.on('move', () => this.remember(id, current));
    current.on('close', event => {
      if (this.options.quitting()) return;
      event.preventDefault();
      void this.hide(id).catch(error => dialog.showErrorBox('便签尚未关闭', error instanceof Error ? error.message : String(error)));
    });
    current.on('closed', () => {
      if (this.windows.get(id) !== current) return;
      clearTimeout(this.boundsTimers.get(id)); this.boundsTimers.delete(id); this.windows.delete(id);
    });
    const url = new URL(this.options.url); url.searchParams.set('note', id);
    try {
      // A failed navigation may still emit ready-to-show. Keep the window hidden
      // until loading succeeds, and retry in the same window without adding a note.
      for (let attempt = 1; ; attempt++) {
        try { await current.loadURL(url.href); break; }
        catch (error) {
          this.options.report('note-load-failed', { id, attempt, error: String(error) });
          if (attempt >= 2 || current.isDestroyed() || this.options.quitting()) throw error;
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }
      if (!current.isDestroyed() && !this.options.quitting()) {
        if (focus) { current.show(); current.focus(); } else current.showInactive();
      }
    } catch (error) {
      if (!current.isDestroyed()) current.destroy();
      await this.options.preferences.update(value => {
        value.noteWindows[id] = { ...value.noteWindows[id] ?? prior, open: false };
      }).catch(failure => this.options.report('note-window-preferences-failed', { id, error: String(failure) }));
      this.options.publish();
      throw new Error('便签已保存，但窗口暂时无法打开。请在“桌面便签”中重新打开；若仍失败，请退出并重启 GTodo。', { cause: error });
    }
    this.options.publish();
  }
  async restore() {
    let failed = 0;
    for (const [id, value] of Object.entries(this.options.preferences.value.noteWindows)) {
      if (value.open && this.getNote(id) && !this.getNote(id)!.values.deleted) {
        try { await this.open(id, false); } catch { failed++; }
      }
    }
    return failed;
  }
  async pin(id: string, pinned: boolean) {
    if (!this.getNote(id)) throw new Error('便签不存在。');
    await this.options.preferences.update(value => { value.noteWindows[id] = { ...value.noteWindows[id] ?? { open: false }, pinned }; });
    this.windows.get(id)?.setAlwaysOnTop(pinned);
    this.options.publish();
  }
  flush(id: string): Promise<boolean> {
    const window = this.windows.get(id);
    if (!window || window.isDestroyed() || !window.isVisible()) return Promise.resolve(true);
    if (window.webContents.isCrashed()) return Promise.resolve(false);
    return new Promise(resolve => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => finish(false), 5000);
      const finish = (success: boolean) => { clearTimeout(timer); this.flushRequests.delete(requestId); resolve(success); };
      this.flushRequests.set(requestId, { sender: window.webContents, finish });
      window.webContents.send('gtodo:note-flush', requestId);
    });
  }
  acknowledge(sender: WebContents, requestId: string, success: boolean) {
    const pending = this.flushRequests.get(requestId);
    if (pending?.sender === sender) pending.finish(success);
  }
  async flushAll() {
    for (const window of this.windows.values()) if (!window.isDestroyed() && window.isVisible()) window.setEnabled(false);
    const results = await Promise.all([...this.windows.keys()].map(id => this.flush(id)));
    return results.every(Boolean);
  }
  resumeInteractions() {
    for (const window of this.windows.values()) if (!window.isDestroyed()) window.setEnabled(true);
  }
  async withSaved<T>(id: string, action: () => Promise<T>): Promise<T> {
    const window = this.windows.get(id);
    if (window && !window.isDestroyed()) window.setEnabled(false);
    try {
      if (!await this.flush(id)) throw new Error('便签内容尚未保存，窗口已保留。请检查便签中的提示后重试。');
      return await action();
    } finally { if (window && !window.isDestroyed()) window.setEnabled(true); }
  }
  hide(id: string, flush = true): Promise<void> {
    const hideSaved = async () => {
      const window = this.windows.get(id);
      if (window && !window.isDestroyed()) await this.saveBounds(id, window);
      await this.options.preferences.update(value => { value.noteWindows[id] = { ...value.noteWindows[id] ?? { pinned: false }, open: false }; });
      window?.destroy(); this.options.publish();
    };
    return this.enqueue(id, () => flush ? this.withSaved(id, hideSaved) : hideSaved());
  }
  async saveAllBounds() {
    for (const timer of this.boundsTimers.values()) clearTimeout(timer);
    this.boundsTimers.clear();
    await Promise.all([...this.windows].map(([id, window]) => this.saveBounds(id, window)));
  }
  broadcast(state: AppState) {
    for (const [id, window] of this.windows) {
      if (window.isDestroyed()) continue;
      window.webContents.send('gtodo:changed', state);
      const title = `便签 · ${this.getNote(id)?.values.title.trim() || '未命名便签'}`;
      if (window.getTitle() !== title) window.setTitle(title);
    }
  }
}
