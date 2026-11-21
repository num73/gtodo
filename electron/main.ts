import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, protocol, screen, session, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { commandSchema, localDate, nextZoom, noteWindowActionSchema, parseWorkspace, zoomSteps, type AppState, type Command, type ZoomAction } from '../src/shared/model';
import { linkedNoteForTask } from '../src/shared/note-links';
import { applyCommandWithDrafts } from './linked-note-commands';
import { withSavedWorkspace } from './workspace-actions';
import { atomicWrite, DataStore } from './storage';
import { FolderStorage } from './folder-storage';
import { PreferencesStore, type Preferences } from './preferences';
import { NoteWindows } from './note-windows';
import { Diagnostics } from './diagnostics';
import { documentEntry, MAX_BACKUP_BYTES } from './document-files';
import { documentFormatSchema, documentTargetSchema, MAX_IMAGE_BYTES, type CreateNoteInput, type DocumentTarget } from '../src/shared/documents';
import { createOutlookBridge } from './outlook-bridge';
import { OutlookSync } from './outlook-sync';
import { emptyOutlookStatus } from '../src/shared/outlook';
import { PomodoroTimer } from './pomodoro';
import { PomodoroWindow } from './pomodoro-window';
import { paneLayoutSchema } from '../src/shared/layout';
import { formatCountdown, phaseLabels, pomodoroCommandSchema, remainingTime } from '../src/shared/pomodoro';
import { trashTargetSchema, trashTargetsSchema } from '../src/shared/trash';
import { ScreenCapture } from './screen-capture';
import { APP_USER_MODEL_ID, taskbarDetails } from './taskbar';
import { boardImageInputSchema } from '../src/shared/board';
import { creationDefaults, patchUserPreferences } from '../src/shared/preferences';

app.setName('GTodo');
app.setAppUserModelId(APP_USER_MODEL_ID);
if (process.env.GTODO_DATA_DIR && !app.isPackaged) app.setPath('userData', path.resolve(process.env.GTODO_DATA_DIR));
const diagnostics = new Diagnostics(app.getPath('userData'));
const startupStages: Record<string, number> = {};
let startupReported = false;
const startupMark = (name: string) => { startupStages[name] ??= Math.round(process.uptime() * 1000); };
startupMark('mainEntryMs');
protocol.registerSchemesAsPrivileged([{ scheme: 'gtodo', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
let window: BrowserWindow | null = null;
let mainRendererReady = false;
let store: DataStore;
let preferences: PreferencesStore;
let folders: FolderStorage;
let initialFolderRead: Promise<void> = Promise.resolve();
let startupWindows: Promise<void> = Promise.resolve();
let folderReady = false;
let notes: NoteWindows;
let screenCapture: ScreenCapture | undefined;
let outlook: OutlookSync | undefined;
let pomodoro: PomodoroTimer | undefined;
let pomodoroWindow: PomodoroWindow | undefined;
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
  const mainWindow = window && !window.isDestroyed() ? { maximized: window.isMaximized(), fullScreen: window.isFullScreen() } : { maximized: false, fullScreen: false };
  const noteWindows = structuredClone(preferences.value.noteWindows);
  for (const [id, settings] of Object.entries(noteWindows)) settings.open = !!notes?.isVisible(id);
  return { workspace: structuredClone(store.engine.state), deviceId: store.engine.deviceId, dataPath: folders.directory,
    notice: store.notice, folder: { ...folders.status }, zoom: preferences.value.zoom, version: app.getVersion(), mainWindow, preferences: { ...preferences.value.user }, paneLayout: { ...preferences.value.paneLayout }, pomodoroWindow: { ...structuredClone(preferences.value.pomodoroWindow), open: !!pomodoroWindow?.hasVisible() }, noteWindows, outlook: outlook?.snapshot() ?? emptyOutlookStatus() };
}
function changed() {
  const current = state();
  if (window && !window.isDestroyed()) window.webContents.send('gtodo:changed', current);
  notes?.broadcast(current);
  pomodoroWindow?.send('gtodo:changed', current);
}
function trusted(event: IpcMainInvokeEvent, allowNote = false, allowPomodoro = false) {
  const url = event.senderFrame?.url;
  const known = (window && event.sender === window.webContents) || (allowNote && notes?.owner(event.sender)) || (allowPomodoro && pomodoroWindow?.owns(event.sender));
  if (!known || event.senderFrame !== event.sender.mainFrame || !(url?.startsWith('gtodo://app/') || (devURL && url?.startsWith(`${devURL}/`)))) throw new Error('未授权的应用请求。');
}
function handle(channel: string, callback: (value: unknown, event: IpcMainInvokeEvent) => unknown, allowNote = false, allowPomodoro = false) {
  ipcMain.handle(channel, async (event, value) => { trusted(event, allowNote, allowPomodoro); return callback(value, event); });
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
  trayAction(() => pomodoroWindow!.open());
}
async function createNote(input?: CreateNoteInput) {
  let id = '';
  const command = creationDefaults(commandSchema.parse({ ...input, type: 'note.add' }), preferences.value.user);
  if (command.type !== 'note.add') throw new Error('便签请求无效。');
  await folders.update(engine => {
    const assets = input?.source ? documentEntry(engine.state, input.source).assets : {};
    engine.apply({ ...command, assets }); id = engine.state.notes.at(-1)!.id;
  });
  await notes.open(id); return id;
}
async function applyCommand(command: Command) {
  await applyCommandWithDrafts(creationDefaults(command, preferences.value.user), {
    workspace: () => store.engine.state,
    flushMain: () => mainRendererReady ? notes.flushWindow(window) : Promise.resolve(true),
    withSavedNote: (id, action) => notes.withSaved(id, action),
    update: command => folders.update(engine => engine.apply(command)),
  });
}
async function withSavedData<T>(operation: string, action: () => Promise<T>) {
  await startupWindows;
  return withSavedWorkspace(action, {
    flushMain: () => mainRendererReady ? notes.flushWindow(window) : Promise.resolve(true),
    flushNotes: () => notes.flushAll(),
    resume: () => { if (!preparingToQuit) notes.resumeInteractions(); },
    failureMessage: `有内容尚未保存，已取消${operation}。请检查保存提示后重试。`,
  });
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
  mainRendererReady = false;
  const saved = preferences.value.window;
  const area = saved ? screen.getDisplayMatching(saved).workArea : screen.getPrimaryDisplay().workArea;
  const width = Math.min(saved?.width ?? 1320, area.width);
  const height = Math.min(saved?.height ?? 880, area.height);
  const x = saved ? Math.max(area.x, Math.min(saved.x, area.x + area.width - width)) : Math.round(area.x + (area.width - width) / 2);
  const y = saved ? Math.max(area.y, Math.min(saved.y, area.y + area.height - height)) : Math.round(area.y + (area.height - height) / 2);
  window = new BrowserWindow({
    width, height, x, y, minWidth: 360, minHeight: 400, resizable: true, frame: false, show: false,
    backgroundColor: '#ffffff', title: 'GTodo', icon: path.join(app.getAppPath(), 'assets/icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  const taskbar = taskbarDetails({ platform: process.platform, packaged: app.isPackaged,
    executable: process.execPath, portableExecutable: process.env.PORTABLE_EXECUTABLE_FILE });
  if (taskbar) window.setAppDetails(taskbar);
  // Apply the identity and stable relaunch target before the first taskbar entry.
  window.show();
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
  window.on('maximize', () => { rememberWindow(); changed(); });
  window.on('unmaximize', () => { rememberWindow(); changed(); });
  window.on('enter-full-screen', changed); window.on('leave-full-screen', changed);
  window.on('close', event => {
    rememberWindow();
    if (quitting) return;
    event.preventDefault();
    const action = preferences.value.user.closeAction;
    if (action === 'background' || (action === 'auto' && (notes?.hasVisible() || pomodoroWindow?.hasVisible() || preferences.value.outlook.enabled || pomodoro?.isActive()))) window?.hide(); else app.quit();
  });
  window.on('closed', () => { window = null; });
  if (saved?.maximized) window.maximize();
  if (devURL) void window.loadURL(devURL); else void window.loadURL('gtodo://app/index.html');
}
async function initialize() {
  await app.whenReady(); Menu.setApplicationMenu(null);
  startupMark('electronReadyMs');
  const allowFullscreen = (contents: Electron.WebContents | null, permission: string, details: { isMainFrame: boolean; requestingUrl?: string }) =>
    permission === 'fullscreen' && contents === window?.webContents && details.isMainFrame &&
    (details.requestingUrl === 'gtodo://app/index.html' || !!devURL && details.requestingUrl === `${devURL}/`);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowFullscreen(contents, permission, details)));
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => allowFullscreen(contents, permission, details));
  const root = path.join(app.getAppPath(), 'dist');
  protocol.handle('gtodo', async request => {
    const url = new URL(request.url);
    if (url.hostname === 'app' && url.pathname.startsWith('/board-media/')) {
      try {
        const data = await folders.documents.readBoardImage(folders.directory, store.engine.state, decodeURIComponent(url.pathname.slice('/board-media/'.length)));
        return new Response(data.bytes, { headers: { 'Content-Type': `image/${data.type === 'jpg' ? 'jpeg' : data.type}`, 'Cache-Control': 'no-store' } });
      } catch { return new Response('Image unavailable', { status: 404, headers: { 'Cache-Control': 'no-store' } }); }
    }
    if (url.hostname === 'app' && url.pathname.startsWith('/media/')) {
      try {
        const parts = url.pathname.split('/').slice(2).map(decodeURIComponent);
        if (parts.length !== 3) return new Response('Not found', { status: 404 });
        const target = documentTargetSchema.parse({ kind: parts[0], id: parts[1] });
        const data = await folders.documents.readImage(folders.directory, store.engine.state, target, `assets/${parts[2]}`);
        return new Response(data.bytes, { headers: { 'Content-Type': `image/${data.type === 'jpg' ? 'jpeg' : data.type}`, 'Cache-Control': 'no-store' } });
      } catch { return new Response('Image unavailable', { status: 404, headers: { 'Cache-Control': 'no-store' } }); }
    }
    const file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    const relative = path.relative(root, file);
    if (url.hostname !== 'app' || relative.startsWith('..') || path.isAbsolute(relative)) return new Response('Forbidden', { status: 403 });
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
    try { return new Response(await readFile(file), { headers: { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' } }); }
    catch (error) {
      diagnostics.report('app-resource-failed', { resource: url.pathname, error: String(error) });
      return new Response('Not found', { status: 404 });
    }
  });
  // Preserve the 1.0 local workspace and device identity; never load old cloud credentials.
  store = new DataStore(app.getPath('userData')); await store.initialize();
  startupMark('localDataMs');
  preferences = new PreferencesStore(app.getPath('userData')); await preferences.initialize();
  startupMark('preferencesMs');
  folders = new FolderStorage(store, preferences, () => { changed(); if (folderReady) outlook?.workspaceChanged(); });
  screenCapture = new ScreenCapture({ native: { BrowserWindow, desktopCapturer, screen, nativeImage },
    html: path.join(__dirname, 'capture.html'), preload: path.join(__dirname, 'capture-preload.cjs') });
  outlook = new OutlookSync(preferences, () => store.engine.state,
    createOutlookBridge(app.isPackaged ? path.join(process.resourcesPath, 'outlook-bridge.ps1') : path.join(app.getAppPath(), 'dist-electron/outlook-bridge.ps1')), changed);
  notes = new NoteWindows({ preferences, workspace: () => store.engine.state, publish: changed, quitting: () => quitting,
    native: { BrowserWindow, screen, dialog }, report: diagnostics.report,
    preload: path.join(__dirname, 'preload.cjs'), icon: path.join(app.getAppPath(), 'assets/icon.png'), url: devURL ? `${devURL}/` : 'gtodo://app/index.html' });
  pomodoroWindow = new PomodoroWindow({ preferences, publish: changed, quitting: () => quitting, native: { BrowserWindow, screen, dialog }, report: diagnostics.report,
    preload: path.join(__dirname, 'preload.cjs'), icon: path.join(app.getAppPath(), 'assets/icon.png'), url: devURL ? `${devURL}/` : 'gtodo://app/index.html' });
  pomodoro = new PomodoroTimer({ directory: app.getPath('userData'), task: id => {
    const task = store.engine.state.tasks.find(task => task.id === id && !task.values.deleted && !task.values.completed);
    return task ? { id: task.id, title: task.values.title } : null;
  }, changed: timer => {
    if (window && !window.isDestroyed()) window.webContents.send('gtodo:pomodoro-changed', timer);
    pomodoroWindow?.send('gtodo:pomodoro-changed', timer);
    updateTray();
  }, completed: completion => {
    if (!preferences.value.user.pomodoroNotifications) return;
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
  handle('gtodo:pomodoro-state', () => pomodoro!.snapshot(), false, true);
  handle('gtodo:pomodoro-command', value => pomodoro!.command(pomodoroCommandSchema.parse(value)), false, true);
  handle('gtodo:pomodoro-open', async value => {
    const taskId = z.string().min(1).max(160).optional().parse(value);
    await pomodoroWindow!.open();
    const session = pomodoro!.snapshot().session;
    if (taskId && !(session.status !== 'idle' && session.phase === 'focus' && session.task?.id === taskId)) await pomodoro!.command({ type: 'select', phase: 'focus', taskId });
  });
  handle('gtodo:pomodoro-window', async value => {
    const action = z.discriminatedUnion('type', [z.object({ type: z.literal('hide') }), z.object({ type: z.literal('pin'), pinned: z.boolean() })]).parse(value);
    if (action.type === 'hide') await pomodoroWindow!.hide(); else await pomodoroWindow!.pin(action.pinned);
  }, false, true);
  handle('gtodo:pane-layout', async value => {
    const layout = paneLayoutSchema.parse(value);
    await preferences.update(value => { value.paneLayout = layout; }); changed(); return state();
  });
  handle('gtodo:preferences', async patch => {
    await preferences.update(value => { value.user = patchUserPreferences(value.user, patch); });
    if (!preferences.value.user.pomodoroNotifications) { pomodoroNotification?.close(); window?.flashFrame(false); }
    changed(); return state();
  });
  handle('gtodo:state', (_value, event) => {
    if (event.sender === window?.webContents) {
      mainRendererReady = true;
      if (!startupReported) { startupReported = true; startupMark('firstStateMs'); diagnostics.report('startup-local-ready', { ...startupStages }); }
    }
    return state();
  }, true, true);
  handle('gtodo:command', async (value, event) => {
    const command = commandSchema.parse(value);
    if (notes.owner(event.sender)) {
      if (command.type !== 'note.update') throw new Error('便签窗口无法执行此操作。');
      ownNoteOnly(event, command.id);
    }
    await applyCommand(command); return state();
  }, true);
  handle('gtodo:note-link', async value => {
    const command = creationDefaults(commandSchema.parse({ type: 'task.link-note', id: value }), preferences.value.user);
    if (command.type !== 'task.link-note') throw new Error('关联请求无效。');
    if (mainRendererReady && !await notes.flushWindow(window)) throw new Error('任务备注尚未保存，请重试。');
    let id = '';
    await folders.update(engine => {
      engine.apply(command);
      id = linkedNoteForTask(engine.state, engine.state.tasks.find(task => task.id === command.id)!)!.id;
    });
    await notes.open(id); return id;
  });
  handle('gtodo:note-create', (value, event) => {
    const input = z.object({ title: z.string().max(200).optional(), content: z.string().max(100000).optional(), format: documentFormatSchema.optional(), source: documentTargetSchema.optional() }).optional().parse(value);
    if (input?.source) checkDocumentOwner(event, input.source);
    return createNote(input);
  }, true);
  function checkDocumentOwner(event: IpcMainInvokeEvent, target: DocumentTarget) {
    if (notes.owner(event.sender)) {
      if (target.kind !== 'note') throw new Error('便签窗口只能访问自己的文档。');
      ownNoteOnly(event, target.id);
    }
    documentEntry(store.engine.state, target);
  }
  handle('gtodo:board-image-pick', async (value, event) => {
    const input = boardImageInputSchema.parse(value);
    const owner = BrowserWindow.fromWebContents(event.sender)!;
    const result = await dialog.showOpenDialog(owner, { title: input.destination === 'background' ? '选择看板背景' : '添加图片到看板', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    if ((await stat(file)).size > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 10 MB。');
    const bytes = await readFile(file);
    const assetId = await folders.documents.stageBoardImage(bytes);
    if (input.destination === 'card') await folders.addBoardImage(input, bytes, path.basename(file));
    return { state: state(), assetId };
  });
  handle('gtodo:board-image', async value => {
    const input = boardImageInputSchema.extend({ bytes: z.instanceof(Uint8Array).refine(bytes => bytes.length <= MAX_IMAGE_BYTES), name: z.string().max(200) }).parse(value);
    await folders.addBoardImage(input, input.bytes, input.name);
    return state();
  });
  handle('gtodo:document-image-pick', async (value, event) => {
    const target = documentTargetSchema.parse(value); checkDocumentOwner(event, target);
    const owner = BrowserWindow.fromWebContents(event.sender)!;
    const result = await dialog.showOpenDialog(owner, { title: '插入图片', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    if ((await stat(file)).size > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 10 MB。');
    const relative = await folders.addImage(target, await readFile(file));
    return { path: relative, name: path.basename(file) };
  }, true);
  handle('gtodo:document-image-capture', async (value, event) => {
    const target = documentTargetSchema.parse(value); checkDocumentOwner(event, target);
    if (documentEntry(store.engine.state, target).format !== 'markdown') throw new Error('请先启用 Markdown。');
    await startupWindows;
    if (quitting || preparingToQuit) throw new Error('应用正在退出。');
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) throw new Error('编辑窗口已关闭。');
    const bytes = await screenCapture!.capture(owner);
    if (!bytes) return null;
    checkDocumentOwner(event, target);
    const relative = await folders.addImage(target, bytes);
    return { path: relative, name: `截图 ${new Date().toLocaleString('zh-CN')}` };
  }, true);
  ipcMain.handle('gtodo:capture-preview', event => screenCapture!.preview(event));
  ipcMain.handle('gtodo:capture-ready', event => screenCapture!.ready(event));
  ipcMain.handle('gtodo:capture-select', (event, value) => screenCapture!.select(event, value));
  ipcMain.handle('gtodo:capture-cancel', event => screenCapture!.cancelFrom(event));
  handle('gtodo:document-image', async (value, event) => {
    const input = z.object({ target: documentTargetSchema, name: z.string().max(200), bytes: z.custom<Uint8Array>(value => value instanceof Uint8Array && value.byteLength <= MAX_IMAGE_BYTES) }).parse(value);
    checkDocumentOwner(event, input.target);
    return { path: await folders.addImage(input.target, input.bytes), name: input.name };
  }, true);
  handle('gtodo:document-show', async (value, event) => {
    const target = documentTargetSchema.parse(value); checkDocumentOwner(event, target);
    await folders.refresh();
    if (folders.status.error) throw new Error(folders.status.error);
    shell.showItemInFolder(await folders.documents.filePath(folders.directory, store.engine.state, target));
  }, true);
  handle('gtodo:open-link', value => {
    const url = z.string().max(4000).parse(value); const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只支持网页链接。');
    return shell.openExternal(parsed.href);
  }, true);
  handle('gtodo:note-window', async (value, event) => {
    const action = noteWindowActionSchema.parse(value); ownNoteOnly(event, action.id);
    if (action.type === 'open') await notes.open(action.id);
    if (action.type === 'hide') await notes.hide(action.id);
    if (action.type === 'pin') await notes.pin(action.id, action.pinned);
  }, true);
  handle('gtodo:note-delete', async (value, event) => {
    const id = z.string().uuid().parse(value); ownNoteOnly(event, id);
    await applyCommand({ type: 'note.update', id, patch: { deleted: true } });
    await notes.hide(id, false); return state();
  }, true);
  handle('gtodo:note-flushed', (value, event) => {
    const result = z.object({ requestId: z.string().uuid(), success: z.boolean() }).parse(value);
    notes.acknowledge(event.sender, result.requestId, result.success);
  }, true);
  handle('gtodo:show-main', showMain, true, true);
  handle('gtodo:choose-folder', async () => {
    const result = await dialog.showOpenDialog(window!, { title: '选择 GTodo 数据文件夹', defaultPath: folders.directory, properties: ['openDirectory', 'createDirectory'], buttonLabel: '使用此文件夹' });
    if (!result.canceled && result.filePaths[0]) await withSavedData('切换数据文件夹', () => folders.changeDirectory(result.filePaths[0]));
    return state();
  });
  handle('gtodo:open-folder', async () => { const error = await shell.openPath(folders.directory); if (error) throw new Error('无法打开数据文件夹，请检查路径是否存在。'); });
  handle('gtodo:refresh-folder', async () => { await folders.refresh(); return state(); });
  handle('gtodo:trash', async () => { await initialFolderRead; return folders.getTrash(); });
  handle('gtodo:trash-restore', async value => { await folders.restoreTrash(trashTargetSchema.parse(value)); return state(); });
  handle('gtodo:trash-purge', async value => {
    const targets = trashTargetsSchema.parse(value);
    await startupWindows;
    try {
      if (!(await Promise.all([notes.flushAll(), mainRendererReady ? notes.flushWindow(window) : Promise.resolve(true)])).every(Boolean)) throw new Error('有备注或便签尚未保存，已取消清理。');
      const result = await folders.purgeTrash(targets);
      for (const item of store.engine.state.purged) if (item.kind === 'note' && preferences.value.noteWindows[item.id]?.open) await notes.hide(item.id, false);
      return result;
    } finally { notes.resumeInteractions(); }
  });
  handle('gtodo:outlook-list', () => outlook!.list());
  handle('gtodo:outlook-configure', async value => {
    const input = z.object({ enabled: z.boolean(), calendarId: z.string().regex(/^[a-f\d]{64}$/).optional() }).parse(value);
    if (input.enabled) await initialFolderRead;
    await outlook!.configure(input.enabled, input.calendarId); return state();
  });
  handle('gtodo:outlook-sync', async () => { await initialFolderRead; await outlook!.sync(); return state(); });
  handle('gtodo:zoom', async value => {
    const action = z.union([z.enum(['in', 'out', 'reset']), z.number().refine(number => zoomSteps.includes(number as typeof zoomSteps[number]))]).parse(value);
    await setZoom(action); return state();
  });
  handle('gtodo:export', async () => {
    const result = await dialog.showSaveDialog(window!, { title: '导出 GTodo 备份', defaultPath: `GTodo-备份-${localDate()}.json`, filters: [{ name: 'GTodo 备份', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return false;
    return withSavedData('导出备份', async () => {
      await atomicWrite(result.filePath!, await folders.exportBackup()); return true;
    });
  });
  handle('gtodo:import', async () => {
    const result = await dialog.showOpenDialog(window!, { title: '导入并合并 GTodo 备份', properties: ['openFile'], filters: [{ name: 'GTodo 备份', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths[0]) return state();
    if ((await stat(result.filePaths[0])).size > MAX_BACKUP_BYTES) throw new Error('备份文件超过 160 MB。');
    let imported;
    let attachments;
    try { const data = JSON.parse(await readFile(result.filePaths[0], 'utf8')); imported = parseWorkspace(data); attachments = data.attachments; }
    catch { throw new Error('这不是有效的 GTodo 备份，现有数据未改变。'); }
    await withSavedData('导入备份', () => folders.importBackup(imported, attachments)); return state();
  });
  ipcMain.on('gtodo:window', (event, action) => {
    trusted(event);
    if (action === 'minimize') window?.minimize();
    if (action === 'maximize') {
      if (window?.isFullScreen()) window.setFullScreen(false);
      else if (window?.isMaximized()) window.unmaximize();
      else window?.maximize();
    }
    if (action === 'close') window?.close();
  });
  ipcMain.on('gtodo:quit', event => { trusted(event); app.quit(); });
  createWindow(); createTray();
  startupMark('windowCreatedMs');
  // Display the local cache first. Folder reconciliation stays on its existing
  // serialized queue, so edits still merge external changes before committing.
  const folderStarted = performance.now();
  initialFolderRead = folders.initialize();
  startupWindows = initialFolderRead.then(async () => {
    folderReady = true;
    diagnostics.report('startup-folder-ready', { elapsedMs: Math.round(process.uptime() * 1000), durationMs: Math.round(performance.now() - folderStarted) });
    if (quitting) return;
    if (preferences.value.user.restoreNotes && await notes.restore()) {
      store.notice = [store.notice, '部分便签未能打开，内容已保留，可在“桌面便签”中重新打开。'].filter(Boolean).join('\n');
      changed();
    }
    if (preferences.value.user.restorePomodoro && preferences.value.pomodoroWindow.open) {
      try { await pomodoroWindow!.open(false); }
      catch { store.notice = '番茄钟窗口未能恢复，可从左侧栏重新打开。'; changed(); }
    }
  });
  await startupWindows;
  if (quitting) return;
  outlook.start();
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
      if (!preferences.value.user.taskNotifications) continue;
      if (Notification.isSupported()) {
        const notification = new Notification({ title: 'GTodo · 任务提醒', body: task.values.title });
        notification.on('click', () => { window?.restore(); window?.show(); window?.focus(); }); notification.show();
      }
    }
  }, 15000).unref();
}
app.on('second-instance', () => { if (window && !quitting && !preparingToQuit) showMain(); });
app.on('window-all-closed', () => { if (!tray) app.quit(); });
let flushedOnQuit = false;
let preparingToQuit = false;
app.on('before-quit', event => {
  screenCapture?.cancel();
  if (!flushedOnQuit && store && preferences && folders) {
    event.preventDefault();
    if (preparingToQuit) return;
    preparingToQuit = true;
    void (async () => {
      if (window && !window.isDestroyed()) window.setEnabled(false);
      // A quit from the early main window must include any windows still being
      // restored, so no late renderer can appear after the final draft flush.
      await startupWindows.catch(() => {});
      pomodoroWindow?.setEnabled(false);
      if (notes && !(await Promise.all([notes.flushAll(), mainRendererReady ? notes.flushWindow(window) : Promise.resolve(true)])).every(Boolean)) throw new Error('有备注或便签尚未完成保存，已取消退出。请检查保存提示后重试。');
      if (boundsTimer) clearTimeout(boundsTimer);
      await Promise.all([
        zoomQueue, folders.flush(),
        lastBounds ? preferences.update(value => { value.window = lastBounds; }) : Promise.resolve(),
        notes?.saveAllBounds(),
        pomodoroWindow?.flush(),
      ]);
      await preferences.flush();
      await pomodoro?.pause();
      await diagnostics.flush();
      if (folderTimer) clearInterval(folderTimer);
      if (pomodoroTick) clearInterval(pomodoroTick);
      outlook?.stop();
      quitting = true; flushedOnQuit = true; tray?.destroy(); tray = undefined; app.quit();
    })().catch(error => { notes?.resumeInteractions(); pomodoroWindow?.setEnabled(true); if (window && !window.isDestroyed()) window.setEnabled(true); dialog.showErrorBox('GTodo 尚未退出', error instanceof Error ? error.message : String(error)); })
      .finally(() => { preparingToQuit = false; });
  }
});
app.on('activate', () => { if (!window && !quitting) createWindow(); });
if (locked) initialize().catch(error => { dialog.showErrorBox('GTodo 无法启动', error instanceof Error ? error.message : String(error)); app.quit(); });
