import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, protocol, screen, session, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { commandSchema, localDate, nextZoom, noteWindowActionSchema, parseWorkspace, zoomSteps, type AppState, type ZoomAction } from '../src/shared/model';
import { atomicWrite, DataStore } from './storage';
import { FolderStorage, MAX_DATA_BYTES } from './folder-storage';
import { PreferencesStore, type Preferences } from './preferences';
import { NoteWindows } from './note-windows';
import { createOutlookBridge } from './outlook-bridge';
import { OutlookSync } from './outlook-sync';
import { emptyOutlookStatus } from '../src/shared/outlook';
import { PomodoroTimer } from './pomodoro';
import { formatCountdown, phaseLabels, pomodoroCommandSchema, remainingTime } from '../src/shared/pomodoro';

app.setName('GTodo');
app.setAppUserModelId('app.gtodo.desktop');
if (process.env.GTODO_DATA_DIR && !app.isPackaged) app.setPath('userData', path.resolve(process.env.GTODO_DATA_DIR));
protocol.registerSchemesAsPrivileged([{ scheme: 'gtodo', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
let window: BrowserWindow | null = null;
let store: DataStore;
let preferences: PreferencesStore;
let folders: FolderStorage;
let notes: NoteWindows;
let outlook: OutlookSync | undefined;
let pomodoro: PomodoroTimer | undefined;
let pomodoroTick: ReturnType<typeof setInterval> | undefined;
let pomodoroNotification: Notification | undefined;
let tray: Tray | undefined;
let folderTimer: ReturnType<typeof setInterval> | undefined;
let boundsTimer: ReturnType<typeof setTimeout> | undefined;
let lastBounds: Preferences['window'];
let zoomQueue: Promise<unknown> = Promise.resolve();
const notified = new Set<string>();
let quitting = false;
const devURL = !app.isPackaged && process.env.GTODO_DEV_URL === 'http://127.0.0.1:5173' ? process.env.GTODO_DEV_URL : null;
function state(): AppState {
  return { workspace: structuredClone(store.engine.state), deviceId: store.engine.deviceId, dataPath: folders.directory,
    notice: store.notice, folder: { ...folders.status }, zoom: preferences.value.zoom, version: app.getVersion(), noteWindows: structuredClone(preferences.value.noteWindows), outlook: outlook?.snapshot() ?? emptyOutlookStatus() };
}
function changed() {
  const current = state();
  if (window && !window.isDestroyed()) window.webContents.send('gtodo:changed', current);
  notes?.broadcast(current);
}
function trusted(event: IpcMainInvokeEvent, allowNote = false) {
  const url = event.senderFrame?.url;
  const known = (window && event.sender === window.webContents) || (allowNote && notes?.owner(event.sender));
  if (!known || event.senderFrame !== event.sender.mainFrame || !(url?.startsWith('gtodo://app/') || (devURL && url?.startsWith(`${devURL}/`)))) throw new Error('未授权的应用请求。');
}
function handle(channel: string, callback: (value: unknown, event: IpcMainInvokeEvent) => unknown, allowNote = false) {
  ipcMain.handle(channel, async (event, value) => { trusted(event, allowNote); return callback(value, event); });
}
function ownNoteOnly(event: IpcMainInvokeEvent, id: string) {
  const owner = notes.owner(event.sender);
  if (owner && owner !== id) throw new Error('此便签只能修改自己的内容。');
}
function showMain() {
  if (!window || window.isDestroyed()) createWindow();
  if (window!.isMinimized()) window!.restore();
  window!.show(); window!.focus();
}
function showPomodoro() {
  showMain();
  const contents = window!.webContents;
  const open = () => { if (!contents.isDestroyed()) contents.send('gtodo:pomodoro-open'); };
  if (contents.isLoadingMainFrame()) contents.once('did-finish-load', open); else open();
}
async function createNote(input?: { title?: string; content?: string }) {
  let id = '';
  const command = commandSchema.parse({ ...input, type: 'note.add' });
  await folders.update(engine => { engine.apply(command); id = engine.state.notes.at(-1)!.id; });
  await notes.open(id); return id;
}
function trayAction(action: () => Promise<unknown>) {
  void action().catch(error => dialog.showErrorBox('GTodo', error instanceof Error ? error.message : String(error)));
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(app.getAppPath(), 'assets/icon.png')).resize({ width: 24, height: 24 }));
  updateTray();
  tray.on('click', showMain);
}
function updateTrayTooltip() {
  if (!tray) return;
  const timer = pomodoro?.snapshot();
  tray.setToolTip(timer && timer.session.status !== 'idle' ? `GTodo · ${phaseLabels[timer.session.phase]} ${formatCountdown(remainingTime(timer.session))}${timer.session.status === 'paused' ? ' · 已暂停' : ''}` : 'GTodo · 任务、便签与番茄钟');
}
function updateTray() {
  if (!tray) return;
  updateTrayTooltip();
  const timer = pomodoro?.snapshot();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 GTodo', click: showMain },
    { label: '番茄钟', click: showPomodoro },
    { label: timer?.session.status === 'running' ? '暂停计时' : timer?.session.status === 'paused' ? '继续计时' : `开始${phaseLabels[timer?.session.phase ?? 'focus']}`, enabled: !!timer && !timer.unavailable,
      click: () => trayAction(() => pomodoro!.command({ type: pomodoro!.snapshot().session.status === 'running' ? 'pause' : 'start' })) },
    { type: 'separator' },
    { label: '新建桌面便签', click: () => trayAction(() => createNote()) },
    { label: '显示所有便签', click: () => trayAction(async () => {
      for (const note of store.engine.state.notes.filter(note => !note.values.deleted)) await notes.open(note.id, false);
    }) },
    { type: 'separator' },
    { label: '退出 GTodo', click: () => app.quit() },
  ]));
}
function setZoom(action: ZoomAction): Promise<void> {
  const operation = zoomQueue.then(async () => {
    await preferences.update(value => { value.zoom = nextZoom(value.zoom, action); });
    if (window && !window.isDestroyed()) window.webContents.setZoomFactor(preferences.value.zoom / 100);
    changed();
  });
  zoomQueue = operation.catch(() => {}); return operation;
}
function keyboardZoom(action: ZoomAction) {
  void setZoom(action).catch(() => { store.notice = '缩放设置未能保存，请检查本机磁盘空间。'; changed(); });
}
function rememberWindow() {
  if (!window || window.isDestroyed()) return;
  const bounds = window.getNormalBounds();
  lastBounds = { ...bounds, maximized: window.isMaximized() };
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    void preferences.update(value => { value.window = lastBounds; }).catch(() => {});
  }, 400);
}
function createWindow() {
  const saved = preferences.value.window;
  const area = saved ? screen.getDisplayMatching(saved).workArea : screen.getPrimaryDisplay().workArea;
  const width = Math.min(saved?.width ?? 1320, area.width);
  const height = Math.min(saved?.height ?? 880, area.height);
  const x = saved ? Math.max(area.x, Math.min(saved.x, area.x + area.width - width)) : Math.round(area.x + (area.width - width) / 2);
  const y = saved ? Math.max(area.y, Math.min(saved.y, area.y + area.height - height)) : Math.round(area.y + (area.height - height) / 2);
  window = new BrowserWindow({
    width, height, x, y, minWidth: 360, minHeight: 400, resizable: true, frame: false, show: true,
    backgroundColor: '#ffffff', title: 'GTodo', icon: path.join(app.getAppPath(), 'assets/icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('did-fail-load', (_event, code, description) => console.error('Window load failed:', code, description));
  window.webContents.on('render-process-gone', (_event, details) => console.error('Window renderer exited:', details.reason));
  // Isolated zoom updates layout; manual mode only changes the stored level.
  window.webContents.setZoomMode('isolated');
  window.webContents.on('did-finish-load', () => window?.webContents.setZoomFactor(preferences.value.zoom / 100));
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return;
    let action: ZoomAction | null = null;
    if (['+', '='].includes(input.key) || input.code === 'NumpadAdd') action = 'in';
    if (input.key === '-' || input.code === 'NumpadSubtract') action = 'out';
    if (input.key === '0' || input.code === 'Numpad0') action = 'reset';
    if (action) { event.preventDefault(); keyboardZoom(action); }
  });
  let lastWheelZoom = 0;
  window.webContents.on('zoom-changed', (_event, direction) => {
    if (Date.now() - lastWheelZoom < 100) return;
    lastWheelZoom = Date.now(); keyboardZoom(direction);
  });
  if (!app.isPackaged && process.env.GTODO_QA === '1') {
    window.on('page-title-updated', (event, title) => { event.preventDefault(); window?.setTitle(`${title} [${app.getVersion()} 测试]`); });
  }
  window.once('ready-to-show', () => window?.show());
  window.on('resize', rememberWindow); window.on('move', rememberWindow);
  window.on('maximize', rememberWindow); window.on('unmaximize', rememberWindow);
  window.on('close', event => {
    rememberWindow();
    if (quitting) return;
    event.preventDefault();
    if (notes?.hasVisible() || preferences.value.outlook.enabled || pomodoro?.isActive()) window?.hide(); else app.quit();
  });
  window.on('closed', () => { window = null; });
  if (saved?.maximized) window.maximize();
  if (devURL) void window.loadURL(devURL); else void window.loadURL('gtodo://app/index.html');
}
async function initialize() {
  await app.whenReady(); Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const root = path.join(app.getAppPath(), 'dist');
  protocol.handle('gtodo', async request => {
    const url = new URL(request.url);
    const file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    const relative = path.relative(root, file);
    if (url.hostname !== 'app' || relative.startsWith('..') || path.isAbsolute(relative)) return new Response('Forbidden', { status: 403 });
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
    try { return new Response(await readFile(file), { headers: { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' } }); }
    catch { return new Response('Not found', { status: 404 }); }
  });
  // Preserve the 1.0 local workspace and device identity; never load old cloud credentials.
  store = new DataStore(app.getPath('userData')); await store.initialize();
  preferences = new PreferencesStore(app.getPath('userData')); await preferences.initialize();
  folders = new FolderStorage(store, preferences, () => { changed(); outlook?.workspaceChanged(); }); await folders.initialize();
  outlook = new OutlookSync(preferences, () => store.engine.state,
    createOutlookBridge(app.isPackaged ? path.join(process.resourcesPath, 'outlook-bridge.ps1') : path.join(app.getAppPath(), 'dist-electron/outlook-bridge.ps1')), changed);
  notes = new NoteWindows({ preferences, workspace: () => store.engine.state, publish: changed, quitting: () => quitting,
    preload: path.join(__dirname, 'preload.cjs'), icon: path.join(app.getAppPath(), 'assets/icon.png'), url: devURL ? `${devURL}/` : 'gtodo://app/index.html' });
  pomodoro = new PomodoroTimer({ directory: app.getPath('userData'), task: id => {
    const task = store.engine.state.tasks.find(task => task.id === id && !task.values.deleted && !task.values.completed);
    return task ? { id: task.id, title: task.values.title } : null;
  }, changed: timer => {
    if (window && !window.isDestroyed()) window.webContents.send('gtodo:pomodoro-changed', timer);
    updateTray();
  }, completed: completion => {
    const title = `GTodo · ${phaseLabels[completion.phase]}结束`;
    const body = completion.phase === 'focus' ? `${completion.taskTitle ? `${completion.taskTitle}\n` : ''}休息一下。准备好后开始休息计时。` : '休息结束，可以开始下一次专注。';
    if (Notification.isSupported()) {
      pomodoroNotification?.close();
      pomodoroNotification = new Notification({ title, body });
      pomodoroNotification.on('click', showPomodoro); pomodoroNotification.show();
    } else tray?.displayBalloon({ title, content: body, iconType: 'info' });
    if (window && !window.isDestroyed() && !window.isFocused()) window.flashFrame(true);
  } });
  await pomodoro.initialize();
  handle('gtodo:pomodoro-state', () => pomodoro!.snapshot());
  handle('gtodo:pomodoro-command', value => pomodoro!.command(pomodoroCommandSchema.parse(value)));
  handle('gtodo:state', () => state(), true);
  handle('gtodo:command', async (value, event) => {
    const command = commandSchema.parse(value);
    if (notes.owner(event.sender)) {
      if (command.type !== 'note.update') throw new Error('便签窗口无法执行此操作。');
      ownNoteOnly(event, command.id);
    }
    await folders.update(engine => engine.apply(command)); return state();
  }, true);
  handle('gtodo:note-create', value => createNote(z.object({ title: z.string().max(200).optional(), content: z.string().max(100000).optional() }).optional().parse(value)), true);
  handle('gtodo:note-window', async (value, event) => {
    const action = noteWindowActionSchema.parse(value); ownNoteOnly(event, action.id);
    if (action.type === 'open') await notes.open(action.id);
    if (action.type === 'hide') await notes.hide(action.id);
    if (action.type === 'pin') await notes.pin(action.id, action.pinned);
  }, true);
  handle('gtodo:note-delete', async (value, event) => {
    const id = z.string().uuid().parse(value); ownNoteOnly(event, id);
    return notes.withSaved(id, async () => {
      await folders.update(engine => engine.apply({ type: 'note.update', id, patch: { deleted: true } }));
      await notes.hide(id, false); return state();
    });
  }, true);
  handle('gtodo:note-flushed', (value, event) => {
    const result = z.object({ requestId: z.string().uuid(), success: z.boolean() }).parse(value);
    notes.acknowledge(event.sender, result.requestId, result.success);
  }, true);
  handle('gtodo:show-main', showMain, true);
  handle('gtodo:choose-folder', async () => {
    const result = await dialog.showOpenDialog(window!, { title: '选择 GTodo 数据文件夹', defaultPath: folders.directory, properties: ['openDirectory', 'createDirectory'], buttonLabel: '使用此文件夹' });
    if (!result.canceled && result.filePaths[0]) await folders.changeDirectory(result.filePaths[0]);
    return state();
  });
  handle('gtodo:open-folder', async () => { const error = await shell.openPath(folders.directory); if (error) throw new Error('无法打开数据文件夹，请检查路径是否存在。'); });
  handle('gtodo:refresh-folder', async () => { await folders.refresh(); return state(); });
  handle('gtodo:outlook-list', () => outlook!.list());
  handle('gtodo:outlook-configure', async value => {
    const input = z.object({ enabled: z.boolean(), calendarId: z.string().regex(/^[a-f\d]{64}$/).optional() }).parse(value);
    await outlook!.configure(input.enabled, input.calendarId); return state();
  });
  handle('gtodo:outlook-sync', async () => { await outlook!.sync(); return state(); });
  handle('gtodo:zoom', async value => {
    const action = z.union([z.enum(['in', 'out', 'reset']), z.number().refine(number => zoomSteps.includes(number as typeof zoomSteps[number]))]).parse(value);
    await setZoom(action); return state();
  });
  handle('gtodo:export', async () => {
    const result = await dialog.showSaveDialog(window!, { title: '导出 GTodo 备份', defaultPath: `GTodo-备份-${localDate()}.json`, filters: [{ name: 'GTodo 备份', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return false;
    await atomicWrite(result.filePath, JSON.stringify(store.engine.state, null, 2)); return true;
  });
  handle('gtodo:import', async () => {
    const result = await dialog.showOpenDialog(window!, { title: '导入并合并 GTodo 备份', properties: ['openFile'], filters: [{ name: 'GTodo 备份', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths[0]) return state();
    if ((await stat(result.filePaths[0])).size > MAX_DATA_BYTES) throw new Error('备份文件超过 24 MB。');
    let imported;
    try { imported = parseWorkspace(JSON.parse(await readFile(result.filePaths[0], 'utf8'))); }
    catch { throw new Error('这不是有效的 GTodo 备份，现有数据未改变。'); }
    await folders.update(engine => engine.merge(imported)); return state();
  });
  ipcMain.on('gtodo:window', (event, action) => {
    trusted(event);
    if (action === 'minimize') window?.minimize();
    if (action === 'maximize') { if (window?.isMaximized()) window.unmaximize(); else window?.maximize(); }
    if (action === 'close') window?.close();
  });
  ipcMain.on('gtodo:quit', event => { trusted(event); app.quit(); });
  createWindow(); createTray(); await notes.restore(); outlook.start();
  void pomodoro.tick().catch(() => {});
  let ticking = false;
  pomodoroTick = setInterval(() => {
    if (!ticking && !quitting) {
      ticking = true;
      void pomodoro!.tick().catch(() => {}).finally(() => { ticking = false; updateTrayTooltip(); });
    }
  }, 1000); pomodoroTick.unref();
  folderTimer = setInterval(() => void folders.refresh(), 3000); folderTimer.unref();
  powerMonitor.on('resume', () => { if (!quitting) { void folders.refresh(); outlook?.schedule(); } });
  powerMonitor.on('suspend', () => { void pomodoro?.pause().catch(() => {}); });
  setInterval(() => {
    for (const task of store.engine.state.tasks) {
      const reminder = task.values.reminder; const key = `${task.id}:${reminder}`;
      if (!reminder || task.values.completed || task.values.deleted || Date.parse(reminder) > Date.now() || notified.has(key)) continue;
      notified.add(key);
      if (Notification.isSupported()) {
        const notification = new Notification({ title: 'GTodo · 任务提醒', body: task.values.title });
        notification.on('click', () => { window?.restore(); window?.show(); window?.focus(); }); notification.show();
      }
    }
  }, 15000).unref();
}
app.on('second-instance', () => { if (preferences && !quitting) showMain(); });
app.on('window-all-closed', () => { if (!tray) app.quit(); });
let flushedOnQuit = false;
let preparingToQuit = false;
app.on('before-quit', event => {
  if (!flushedOnQuit && store && preferences && folders) {
    event.preventDefault();
    if (preparingToQuit) return;
    preparingToQuit = true;
    void (async () => {
      if (notes && !await notes.flushAll()) throw new Error('有便签尚未完成保存，已取消退出。请检查便签中的保存提示后重试。');
      if (boundsTimer) clearTimeout(boundsTimer);
      await Promise.all([
        zoomQueue, folders.flush(),
        lastBounds ? preferences.update(value => { value.window = lastBounds; }) : Promise.resolve(),
        notes?.saveAllBounds(),
      ]);
      await preferences.flush();
      await pomodoro?.pause();
      if (folderTimer) clearInterval(folderTimer);
      if (pomodoroTick) clearInterval(pomodoroTick);
      outlook?.stop();
      quitting = true; flushedOnQuit = true; tray?.destroy(); tray = undefined; app.quit();
    })().catch(error => { notes?.resumeInteractions(); dialog.showErrorBox('GTodo 尚未退出', error instanceof Error ? error.message : String(error)); })
      .finally(() => { preparingToQuit = false; });
  }
});
app.on('activate', () => { if (!window && !quitting) createWindow(); });
if (locked) initialize().catch(error => { dialog.showErrorBox('GTodo 无法启动', error instanceof Error ? error.message : String(error)); app.quit(); });
