import type { BrowserWindow, DesktopCapturer, IpcMainInvokeEvent, NativeImage as Image, Rectangle, Screen, WebContents } from 'electron';
import { pathToFileURL } from 'node:url';
import { capturePixels, type CapturePreview } from '../src/shared/screen-capture';
import { MAX_IMAGE_BYTES } from '../src/shared/documents';

type Overlay = { window: BrowserWindow; image: Image; displayId: number; bounds: Rectangle; ready: boolean };
type CaptureJob = {
  owner: BrowserWindow; hidden: BrowserWindow[]; overlays: Map<number, Overlay>; loaded: boolean;
  timer: ReturnType<typeof setTimeout>; cancel: () => void;
  resolve: (value: Buffer | null) => void; reject: (error: Error) => void;
};
export class ScreenCapture {
  private job: CaptureJob | null = null;
  constructor(private options: {
    native: { BrowserWindow: typeof import('electron').BrowserWindow; desktopCapturer: DesktopCapturer; screen: Screen; nativeImage: typeof import('electron').nativeImage };
    html: string; preload: string;
  }) {}
  get active() { return !!this.job; }
  capture(owner: BrowserWindow): Promise<Buffer | null> {
    if (this.job) return Promise.reject(new Error('已有截图正在进行，请先完成或取消。'));
    if (owner.isDestroyed()) return Promise.reject(new Error('编辑窗口已关闭。'));
    return new Promise((resolve, reject) => {
      const cancel = () => this.cancel();
      const job: CaptureJob = { owner, hidden: [], overlays: new Map(), loaded: false, resolve, reject, cancel,
        timer: setTimeout(() => this.finish(job, null, new Error('截图启动超时，请重试。')), 15000) };
      this.job = job;
      owner.once('closed', cancel);
      this.options.native.screen.on('display-added', cancel);
      this.options.native.screen.on('display-removed', cancel);
      this.options.native.screen.on('display-metrics-changed', cancel);
      void this.start(job).catch(error => this.finish(job, null, error instanceof Error ? error : new Error('无法读取屏幕，请重试。')));
    });
  }
  private async start(job: CaptureJob) {
    const { BrowserWindow, screen, desktopCapturer, nativeImage } = this.options.native;
    const displays = screen.getAllDisplays().filter(display => display.bounds.width > 0 && display.bounds.height > 0);
    if (!displays.length) throw new Error('没有可截图的屏幕。');
    job.hidden = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed() && window.isVisible() && !window.isMinimized());
    for (const window of job.hidden) window.hide();
    // Let the compositor remove GTodo's windows before taking the still image.
    await new Promise(resolve => setTimeout(resolve, 180));
    if (this.job !== job) return;
    const sources = await desktopCapturer.getSources({ types: ['screen'], fetchWindowIcons: false, thumbnailSize: {
      width: Math.ceil(Math.max(...displays.map(display => display.bounds.width * display.scaleFactor))),
      height: Math.ceil(Math.max(...displays.map(display => display.bounds.height * display.scaleFactor))),
    } });
    if (this.job !== job) return;
    const loading: Promise<void>[] = [];
    for (const display of displays) {
      const source = sources.find(source => source.display_id === String(display.id)) ?? (displays.length === 1 && sources.length === 1 ? sources[0] : undefined);
      if (!source || source.thumbnail.isEmpty()) throw new Error('无法获取屏幕图像，请重试。');
      // Normalize to a single 1x PNG representation; selection uses actual image
      // dimensions, never the app zoom or a monitor's DIP coordinates.
      const image = nativeImage.createFromBuffer(source.thumbnail.toPNG());
      const overlay = new BrowserWindow({ ...display.bounds, title: 'GTodo · 框选截图', frame: false, thickFrame: false, show: false,
        fullscreen: true, skipTaskbar: true, resizable: false, movable: false, hasShadow: false, backgroundColor: '#202124',
        webPreferences: { preload: this.options.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, zoomFactor: 1, partition: 'gtodo-screen-capture' } });
      job.overlays.set(overlay.webContents.id, { window: overlay, image, displayId: display.id, bounds: { ...display.bounds }, ready: false });
      overlay.setAlwaysOnTop(true, 'screen-saver');
      overlay.webContents.setZoomMode('isolated'); overlay.webContents.setZoomFactor(1);
      overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      overlay.webContents.on('will-navigate', event => event.preventDefault());
      overlay.webContents.on('render-process-gone', () => this.finish(job, null, new Error('截图窗口已停止，请重试。')));
      overlay.on('closed', () => { if (this.job === job) this.finish(job, null); });
      overlay.webContents.on('before-input-event', (event, input) => { if (input.key === 'Escape') { event.preventDefault(); this.finish(job, null); } });
      loading.push(overlay.loadFile(this.options.html));
    }
    await Promise.all(loading);
    if (this.job !== job) return;
    job.loaded = true; this.show(job);
  }
  private owned(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>) {
    const overlay = this.job?.overlays.get(event.sender.id);
    if (!overlay || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== pathToFileURL(this.options.html).href) throw new Error('未授权的截图请求。');
    return overlay;
  }
  preview(event: IpcMainInvokeEvent): CapturePreview {
    const overlay = this.owned(event);
    return { image: overlay.image.toDataURL(), ...overlay.image.getSize() };
  }
  ready(event: IpcMainInvokeEvent) { this.owned(event).ready = true; this.show(this.job!); }
  private show(job: CaptureJob) {
    if (this.job !== job || !job.loaded || [...job.overlays.values()].some(overlay => !overlay.ready)) return;
    clearTimeout(job.timer);
    job.timer = setTimeout(() => this.finish(job, null, new Error('截图已超时，请重新截图。')), 120000);
    const focusedDisplay = this.options.native.screen.getDisplayNearestPoint(this.options.native.screen.getCursorScreenPoint()).id;
    for (const overlay of job.overlays.values()) {
      // Windows can clamp the initial HWND to its work area even when fullscreen
      // was requested. Remove the native sizing frame and restore the entire
      // monitor's bounds before showing, including the taskbar's screen area.
      overlay.window.setBounds(overlay.bounds);
      overlay.window.showInactive();
      overlay.window.moveTop();
    }
    const focused = [...job.overlays.values()].find(overlay => overlay.displayId === focusedDisplay) ?? [...job.overlays.values()][0];
    focused.window.focus();
  }
  select(event: IpcMainInvokeEvent, input: unknown) {
    const overlay = this.owned(event); const job = this.job!;
    const rect = capturePixels(input, overlay.image.getSize());
    const bytes = overlay.image.crop(rect).toPNG();
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('截图超过 10 MB，请框选较小的区域。');
    this.finish(job, bytes);
  }
  cancelFrom(event: IpcMainInvokeEvent) { this.owned(event); this.cancel(); }
  cancel() { if (this.job) this.finish(this.job, null); }
  owns(sender: WebContents) { return !!this.job?.overlays.has(sender.id); }
  private finish(job: CaptureJob, bytes: Buffer | null, error?: Error) {
    if (this.job !== job) return;
    this.job = null; clearTimeout(job.timer);
    job.owner.removeListener('closed', job.cancel);
    this.options.native.screen.removeListener('display-added', job.cancel);
    this.options.native.screen.removeListener('display-removed', job.cancel);
    this.options.native.screen.removeListener('display-metrics-changed', job.cancel);
    for (const overlay of job.overlays.values()) if (!overlay.window.isDestroyed()) overlay.window.destroy();
    job.overlays.clear();
    for (const window of job.hidden) if (!window.isDestroyed()) window.showInactive();
    if (!job.owner.isDestroyed() && job.hidden.includes(job.owner)) { job.owner.show(); job.owner.focus(); }
    if (error) job.reject(error); else job.resolve(bytes);
  }
}
