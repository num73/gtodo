import test, { afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { JSDOM } from 'jsdom';
import { WorkspaceEngine } from '../src/shared/engine';
import { localDate, nextZoom, type AppState, type DesktopAPI } from '../src/shared/model';
import { emptyOutlookStatus } from '../src/shared/outlook';
import { PomodoroTimer } from '../electron/pomodoro';
import type { PomodoroSnapshot } from '../src/shared/pomodoro';
import { defaultPaneLayout, type PaneLayout } from '../src/shared/layout';
import { trashRecords } from '../src/shared/trash';
import { flushMainDrafts } from '../src/notes/draft';

// Renderer behavior is tested in an isolated DOM, without controlling the user's preview window.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLDialogElement: dom.window.HTMLDialogElement, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
let viewportWidth = 1320;
Object.defineProperty(dom.window, 'innerWidth', { get: () => viewportWidth, configurable: true });
const mediaListeners = new Set<() => void>();
dom.window.matchMedia = (query: string) => ({
  media: query, get matches() { return viewportWidth <= Number(query.match(/max-width:\s*(\d+)px/)?.[1] ?? 0); },
  addEventListener: (_event: string, listener: () => void) => mediaListeners.add(listener),
  removeEventListener: (_event: string, listener: () => void) => mediaListeners.delete(listener),
}) as unknown as MediaQueryList;
const { render, screen, within, cleanup, waitFor, fireEvent, act } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');
const { default: App } = await import('../src/App');
const { default: PomodoroWindow } = await import('../src/pomodoro/PomodoroWindow');
afterEach(() => { cleanup(); viewportWidth = 1320; });
after(() => dom.window.close());
async function resize(width: number) { await act(async () => { viewportWidth = width; for (const listener of mediaListeners) listener(); dom.window.dispatchEvent(new dom.window.Event('resize')); }); }

async function mount(initialPaneLayout: PaneLayout = defaultPaneLayout) {
  const engine = new WorkspaceEngine('ui-test-device');
  let dataPath = 'isolated-test-profile'; let zoom = 100; let outlook = emptyOutlookStatus();
  const timerListeners = new Set<(state: PomodoroSnapshot) => void>();
  const stateListeners = new Set<(state: AppState) => void>();
  let timerView: ReturnType<typeof render> | null = null;
  let paneLayout: PaneLayout = { ...initialPaneLayout };
  let mainWindow = { maximized: false, fullScreen: false };
  const pomodoroWindow = { open: false, pinned: false };
  const timer = new PomodoroTimer({ directory: 'unused-memory-only', write: async () => {}, task: id => {
    const task = engine.state.tasks.find(task => task.id === id && !task.values.completed && !task.values.deleted);
    return task ? { id: task.id, title: task.values.title } : null;
  }, changed: value => { for (const listener of timerListeners) listener(value); } });
  const snapshot = (): AppState => ({ workspace: structuredClone(engine.state), deviceId: engine.deviceId, dataPath, notice: null, folder: { error: null, lastRead: null }, zoom, version: '0.2.1', mainWindow: { ...mainWindow }, paneLayout: { ...paneLayout }, pomodoroWindow: { ...pomodoroWindow }, noteWindows: {}, outlook });
  const publish = () => { for (const listener of stateListeners) listener(snapshot()); };
  const api: DesktopAPI = {
    getPomodoro: async () => timer.snapshot(), pomodoroCommand: command => timer.command(command),
    onPomodoro: callback => { timerListeners.add(callback); return () => { timerListeners.delete(callback); }; },
    openPomodoro: async taskId => {
      pomodoroWindow.open = true;
      if (!timerView) timerView = render(React.createElement(PomodoroWindow));
      if (taskId && timer.snapshot().session.task?.id !== taskId) await timer.command({ type: 'select', phase: 'focus', taskId });
    },
    pomodoroWindow: async action => {
      if (action.type === 'hide') { timerView?.unmount(); timerView = null; pomodoroWindow.open = false; }
      else pomodoroWindow.pinned = action.pinned;
      publish();
    },
    setPaneLayout: async value => { paneLayout = { ...value }; publish(); return snapshot(); },
    getState: async () => snapshot(),
    command: async value => { engine.apply(value); publish(); return snapshot(); },
    onState: callback => { stateListeners.add(callback); return () => { stateListeners.delete(callback); }; }, refreshFolder: async () => snapshot(),
    chooseDataFolder: async () => { dataPath = 'D:\\OneDrive\\GTodo'; return snapshot(); }, openDataFolder: async () => {},
    setZoom: async action => { zoom = nextZoom(zoom, action); return snapshot(); },
    exportBackup: async () => true, importBackup: async () => snapshot(),
    getTrash: async () => ({ items: trashRecords(engine.state), residualBytes: 0, residualFiles: 0, error: null }),
    restoreTrash: async target => { engine.restore(target); publish(); return snapshot(); },
    purgeTrash: async targets => { engine.purge(targets); publish(); return { freedBytes: 512, error: null }; },
    listOutlookCalendars: async () => [{ id: 'a'.repeat(64), name: '测试账户 / 日历' }],
    configureOutlook: async input => { outlook = { ...outlook, enabled: input.enabled, phase: input.enabled ? 'idle' : 'off', targetName: '测试账户 / 日历 / GTodo' }; return snapshot(); },
    syncOutlook: async () => { outlook.lastSyncedAt = new Date().toISOString(); return snapshot(); },
    windowControl: () => {},
    createNote: async input => { engine.apply({ type: 'note.add', ...input }); return engine.state.notes.at(-1)!.id; },
    createLinkedNote: async id => { engine.apply({ type: 'task.link-note', id }); publish(); return engine.state.tasks.find(task => task.id === id)!.values.noteLink!.noteId; },
    pickBoardImage: async () => null, insertBoardImage: async () => snapshot(),
    pickDocumentImage: async () => null, captureDocumentImage: async () => null, insertDocumentImage: async () => ({ path: `assets/${'a'.repeat(64)}.png`, name: '图片.png' }), showDocumentFile: async () => {}, openLink: async () => {},
    noteWindow: async () => {}, deleteNote: async id => { engine.apply({ type: 'note.update', id, patch: { deleted: true } }); publish(); return snapshot(); },
    showMain: async () => {}, onNoteFlush: () => () => {}, noteFlushed: async () => {}, quit: () => {},
  };
  window.gtodo = api;
  render(React.createElement(App));
  await screen.findByRole('heading', { name: '我的一天' });
  const user = userEvent.setup({ document: dom.window.document });
  const add = async (title: string) => {
    await user.type(screen.getByRole('textbox', { name: '添加任务' }), title);
    await user.click(screen.getByRole('button', { name: '添加' }));
    await screen.findByText(title, { exact: true });
  };
  return { engine, api, user, add, timer, setMainWindow: (value: typeof mainWindow) => { mainWindow = value; publish(); } };
}

test('window button follows native maximize, restore and full-screen state', async () => {
  const { user, api, setMainWindow } = await mount();
  const actions: string[] = [];
  api.windowControl = action => { actions.push(action); };
  const normalIcon = screen.getByRole('button', { name: '最大化' }).innerHTML;
  await user.click(screen.getByRole('button', { name: '最大化' }));
  assert.deepEqual(actions, ['maximize']);
  await act(async () => setMainWindow({ maximized: true, fullScreen: false }));
  const restore = screen.getByRole('button', { name: '还原窗口' });
  assert.notEqual(restore.innerHTML, normalIcon);
  await user.click(restore);
  assert.deepEqual(actions, ['maximize', 'maximize']);
  await act(async () => setMainWindow({ maximized: false, fullScreen: false }));
  assert.equal(screen.getByRole('button', { name: '最大化' }).innerHTML, normalIcon);
  await act(async () => setMainWindow({ maximized: false, fullScreen: true }));
  assert.notEqual(screen.getByRole('button', { name: '退出全屏' }).innerHTML, normalIcon);
});

test('navigation stays visible when both columns fit and returns after expanding a closed drawer', async () => {
  await resize(640);
  const { user } = await mount({ sidebar: 420, details: 322 });
  const navigation = document.getElementById('list-navigation')!;
  assert.equal(document.querySelector('.app-shell')?.getAttribute('data-navigation'), 'sidebar');
  assert.equal(navigation.hasAttribute('inert'), false);
  assert.ok(screen.getByRole('separator', { name: '调整清单栏宽度' }));
  // An oversized saved preference must shrink to fit instead of hiding navigation.
  await resize(500);
  assert.equal(document.querySelector('.app-shell')?.getAttribute('data-navigation'), 'sidebar');
  assert.ok(Number(screen.getByRole('separator', { name: '调整清单栏宽度' }).getAttribute('aria-valuenow')) <= 194);
  await resize(420);
  assert.equal(navigation.hasAttribute('inert'), true);
  await user.click(screen.getByRole('button', { name: '展开清单导航' }));
  await user.click(screen.getByRole('button', { name: '收起清单导航' }));
  await resize(640);
  assert.equal(navigation.hasAttribute('inert'), false);
  assert.equal(document.querySelector('.app-shell')?.getAttribute('data-navigation'), 'sidebar');
});

test('board resize at the canvas edge keeps the origin fixed and clamps the size', async () => {
  const { api, engine, user } = await mount();
  await act(async () => { await api.command({ type: 'board.card.add', content: { kind: 'text', text: '边缘贴纸' }, layout: { x: 5800, y: 5800, width: 200, height: 200 } }); });
  await user.click(screen.getByRole('button', { name: '我的看板' }));
  const handle = screen.getByRole('button', { name: '调整文字贴纸大小：边缘贴纸' });
  fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
  fireEvent.keyDown(handle, { key: 'ArrowDown', shiftKey: true });
  await act(() => flushMainDrafts());
  assert.deepEqual(engine.state.boardCards[0].values.layout, { x: 5800, y: 5800, width: 200, height: 200 });
});

test('retrying a missing background preview does not submit the settings form', async () => {
  const { api, engine, user } = await mount();
  api.pickBoardImage = async () => ({ state: await api.getState(), assetId: `${'c'.repeat(64)}.png` });
  await user.click(screen.getByRole('button', { name: '我的看板' }));
  await user.click(screen.getByRole('button', { name: '背景' }));
  await user.click(screen.getByRole('button', { name: '选择背景图片' }));
  fireEvent.error(await screen.findByRole('img', { name: '背景预览' }));
  await user.click(screen.getByRole('button', { name: '重试加载' }));
  assert.ok(screen.getByRole('dialog', { name: '看板背景' }));
  assert.equal(engine.state.boards.length, 0);
});

test('leaving the board waits for every image in an ongoing import', async () => {
  const { api, engine, user } = await mount();
  api.insertBoardImage = async input => api.command({ type: 'board.card.add', content: { kind: 'image', assetId: `${'d'.repeat(64)}.png`, name: input.name }, layout: input.layout });
  await user.click(screen.getByRole('button', { name: '我的看板' }));
  let release!: (value: ArrayBuffer) => void;
  const pending = new Promise<ArrayBuffer>(resolve => { release = resolve; });
  const files = ['第一张.png', '第二张.png'].map(name => ({ name, type: 'image/png', size: 10, arrayBuffer: () => pending }));
  fireEvent.paste(screen.getByRole('heading', { name: '我的看板' }), { clipboardData: { files } });
  try {
    await user.click(screen.getByRole('button', { name: '我的一天' }));
    assert.ok(screen.getByRole('heading', { name: '我的看板' }), 'navigation must wait for images that have not reached IPC yet');
  } finally {
    await act(async () => { release(new ArrayBuffer(10)); await pending; });
    await waitFor(() => assert.equal(engine.state.boardCards.length, 2));
  }
  await screen.findByRole('heading', { name: '我的一天' });
});

test('board pins tasks live, saves keyboard movement and resize, removes with undo without deleting source', async () => {
  const { api, engine, user, add } = await mount(); await add('看板中的任务');
  await user.click(screen.getByRole('button', { name: '我的看板' }));
  const board = within(screen.getByRole('region', { name: '自由看板' }));
  await user.click(board.getByRole('button', { name: '任务' }));
  await user.click(screen.getByRole('button', { name: /看板中的任务.*贴到看板/ }));
  const card = await screen.findByRole('article', { name: '任务贴纸：看板中的任务' });
  assert.equal(engine.state.boardCards.length, 1);
  const start = { ...engine.state.boardCards[0].values.layout };
  fireEvent.keyDown(card, { key: 'ArrowRight', shiftKey: true });
  fireEvent.keyDown(within(card).getByRole('button', { name: '调整任务贴纸大小：看板中的任务' }), { key: 'ArrowDown' });
  await user.click(screen.getByRole('button', { name: /^我的一天/ }));
  await screen.findByRole('heading', { name: '我的一天' });
  assert.equal(engine.state.boardCards[0].values.layout.x, start.x + 50);
  assert.equal(engine.state.boardCards[0].values.layout.height, start.height + 10);
  await user.click(screen.getByRole('button', { name: '我的看板' }));
  await user.click(screen.getByRole('button', { name: '完成任务：看板中的任务' }));
  await waitFor(() => assert.equal(engine.state.tasks[0].values.completed, true));
  await act(async () => { await api.command({ type: 'task.update', id: engine.state.tasks[0].id, patch: { title: '实时更新的任务' } }); });
  await screen.findByRole('article', { name: '任务贴纸：实时更新的任务' });
  await user.click(screen.getByRole('article', { name: '任务贴纸：实时更新的任务' }));
  await user.click(screen.getByRole('button', { name: '从看板移除' }));
  await waitFor(() => assert.equal(engine.state.boardCards[0].values.deleted, true));
  assert.equal(engine.state.tasks[0].values.deleted, false);
  await user.click(screen.getByRole('button', { name: '撤销' }));
  await screen.findByRole('article', { name: '任务贴纸：实时更新的任务' });
  assert.deepEqual(engine.state.boardCards[0].values.layout, { ...start, x: start.x + 50, height: start.height + 10 });
});

test('board creates a persistent note, edits slogans, retains failed saves, and can retry', async () => {
  const { api, engine, user } = await mount();
  await user.click(screen.getByRole('button', { name: '我的看板' }));
  const board = within(screen.getByRole('region', { name: '自由看板' }));
  await user.click(board.getByRole('button', { name: '便签' }));
  await user.click(screen.getByRole('button', { name: '新建便签' }));
  await user.type(screen.getByRole('textbox', { name: '便签内容' }), '记得留一点时间读书');
  await user.click(screen.getByRole('button', { name: '创建并贴上' }));
  await screen.findByRole('article', { name: '便签贴纸：无标题便签' });
  assert.equal(engine.state.notes[0].values.content, '记得留一点时间读书');
  await user.click(board.getByRole('button', { name: '文字 / 标语' }));
  await user.type(screen.getByRole('textbox', { name: '文字内容' }), '每天前进一点点');
  const original = api.command; let fail = true;
  api.command = async command => { if (fail && command.type === 'board.card.add') throw new Error('测试保存失败'); return original(command); };
  await user.click(screen.getByRole('button', { name: '贴到看板' }));
  await screen.findByText('测试保存失败');
  assert.equal((screen.getByRole('textbox', { name: '文字内容' }) as HTMLTextAreaElement).value, '每天前进一点点');
  fail = false; await user.click(screen.getByRole('button', { name: '贴到看板' }));
  await screen.findByRole('article', { name: '文字贴纸：每天前进一点点' });
  await user.click(screen.getByRole('button', { name: '打开文字：每天前进一点点' }));
  await user.clear(screen.getByRole('textbox', { name: '文字内容' }));
  await user.type(screen.getByRole('textbox', { name: '文字内容' }), '今日事，今日毕');
  await user.selectOptions(screen.getByRole('combobox', { name: '文字对齐' }), 'center');
  await user.click(screen.getByRole('button', { name: '保存修改' }));
  await screen.findByRole('article', { name: '文字贴纸：今日事，今日毕' });
  assert.equal(engine.state.boardCards.find(card => card.values.content.kind === 'text')!.values.align, 'center');
});

test('board background chooser stages preview and cancel keeps the old background; apply saves chosen styles', async () => {
  const { api, engine, user } = await mount();
  const id = `${'c'.repeat(64)}.png`;
  api.pickBoardImage = async () => ({ state: await api.getState(), assetId: id });
  await user.click(screen.getByRole('button', { name: '我的看板' }));
  await user.click(screen.getByRole('button', { name: '背景' }));
  await user.click(screen.getByRole('button', { name: '选择背景图片' }));
  await screen.findByRole('img', { name: '背景预览' });
  await user.click(screen.getByRole('button', { name: '取消' }));
  assert.equal(engine.state.boards.length, 0);
  await user.click(screen.getByRole('button', { name: '背景' }));
  await user.click(screen.getByRole('button', { name: '选择背景图片' }));
  await screen.findByRole('img', { name: '背景预览' });
  await user.selectOptions(screen.getByRole('combobox', { name: '背景显示' }), 'contain');
  fireEvent.change(screen.getByLabelText('背景颜色'), { target: { value: '#112233' } });
  await user.click(screen.getByRole('button', { name: '应用背景' }));
  await waitFor(() => assert.equal(engine.state.boards[0].values.backgroundId, id));
  assert.equal(engine.state.boards[0].values.backgroundFit, 'contain');
  assert.equal(engine.state.boards[0].values.backgroundColor, '#112233');
});

test('board pastes images and accepts a file drop over its empty state; invalid images show feedback', async () => {
  const { api, engine, user } = await mount();
  api.insertBoardImage = async input => api.command({ type: 'board.card.add', content: { kind: 'image', assetId: `${'d'.repeat(64)}.png`, name: input.name }, layout: input.layout });
  await user.click(screen.getByRole('button', { name: '我的看板' }));
  const file = { name: '图片.png', type: 'image/png', size: 10, arrayBuffer: async () => new ArrayBuffer(10) };
  const drop = new dom.window.MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 80, clientY: 100 });
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [file], types: ['Files'] } });
  fireEvent(screen.getByText('把想做的、想记的，贴在这里'), drop);
  await screen.findByRole('article', { name: '图片贴纸：图片.png' });
  fireEvent.paste(screen.getByRole('heading', { name: '我的看板' }), { clipboardData: { files: [{ ...file, name: '粘贴.png' }] } });
  await screen.findByRole('article', { name: '图片贴纸：粘贴.png' });
  assert.equal(engine.state.boardCards.length, 2);
  fireEvent.paste(screen.getByRole('heading', { name: '我的看板' }), { clipboardData: { files: [{ ...file, name: '内容.txt', type: 'text/plain' }] } });
  await screen.findByText(/请选择 PNG、JPEG、GIF 或 WebP 图片/);
  assert.equal(engine.state.boardCards.length, 2);
});

test('board preserves unsaved movement after failure and blocks leaving until the retry succeeds', async () => {
  const { api, engine, user } = await mount();
  await act(async () => { await api.command({ type: 'board.card.add', content: { kind: 'text', text: '保留位置' } }); });
  await user.click(screen.getByRole('button', { name: '我的看板' }));
  const original = api.command; let fail = true;
  api.command = async command => { if (fail && command.type === 'board.card.update' && command.patch.layout) throw new Error('位置保存失败'); return original(command); };
  fireEvent.keyDown(screen.getByRole('article', { name: '文字贴纸：保留位置' }), { key: 'ArrowRight' });
  await user.click(screen.getByRole('button', { name: '我的一天' }));
  await screen.findByText('位置未保存');
  assert.ok(screen.getByRole('heading', { name: '我的看板' }));
  assert.equal(engine.state.boardCards[0].values.layout.x, 40);
  fail = false; await user.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => assert.equal(engine.state.boardCards[0].values.layout.x, 50));
  await user.click(screen.getByRole('button', { name: '我的一天' }));
  await screen.findByRole('heading', { name: '我的一天' });
});

test('settings recycle bin restores records and requires confirmation before permanent deletion', async () => {
  const { api, engine, user, add } = await mount(); await add('回收站中的任务');
  await act(async () => { await api.command({ type: 'task.update', id: engine.state.tasks[0].id, patch: { deleted: true, notes: '回收站备注预览' } }); });
  await user.click(screen.getByRole('button', { name: '打开设置' }));
  await user.click(screen.getByRole('button', { name: '打开回收站' }));
  await screen.findByRole('article', { name: '任务：回收站中的任务' });
  assert.ok(screen.getByText('回收站备注预览'));
  await user.click(screen.getByRole('button', { name: '永久删除' }));
  assert.ok(screen.getByRole('alertdialog', { name: '永久删除确认' }));
  assert.equal(engine.state.tasks.length, 1);
  await user.click(screen.getByRole('button', { name: '取消' }));
  assert.equal(engine.state.tasks.length, 1);
  await user.click(screen.getByRole('button', { name: '恢复' }));
  await screen.findByText('回收站为空'); assert.equal(engine.state.tasks[0].values.deleted, false);
  await act(async () => { await api.command({ type: 'task.update', id: engine.state.tasks[0].id, patch: { deleted: true } }); });
  await user.click(screen.getByRole('button', { name: '刷新回收站' }));
  await screen.findByRole('article', { name: '任务：回收站中的任务' });
  await user.click(screen.getByRole('button', { name: '清空回收站' }));
  await user.click(screen.getByRole('button', { name: '确认永久删除' }));
  await screen.findByText('回收站为空'); assert.equal(engine.state.tasks.length, 0);
  assert.equal(engine.state.purged.length, 1);
});

test('recycle bin keeps failed operations visible and allows retrying residual file cleanup', async () => {
  const { api, engine, user, add } = await mount(); await add('不能误删的任务');
  await act(async () => { await api.command({ type: 'task.update', id: engine.state.tasks[0].id, patch: { deleted: true } }); });
  let residual = true; let calls = 0;
  api.getTrash = async () => ({ items: trashRecords(engine.state), residualBytes: residual ? 2048 : 0, residualFiles: residual ? 1 : 0, error: null });
  api.purgeTrash = async targets => { calls++; if (calls === 1) throw new Error('文件夹不可用'); assert.equal(targets.length, 0); residual = false; return { freedBytes: 2048, error: null }; };
  await user.click(screen.getByRole('button', { name: '打开设置' }));
  await user.click(screen.getByRole('button', { name: '打开回收站' }));
  await screen.findByRole('button', { name: '清理残留文件' });
  await user.click(screen.getByRole('button', { name: '清理残留文件' }));
  await user.click(screen.getByRole('button', { name: '确认永久删除' }));
  await screen.findByRole('alert'); assert.match(screen.getByRole('alert').textContent!, /文件夹不可用/);
  assert.equal(engine.state.tasks.length, 1);
  await user.click(screen.getByRole('button', { name: '确认永久删除' }));
  await waitFor(() => assert.equal(screen.queryByRole('button', { name: '清理残留文件' }), null));
  assert.equal(engine.state.tasks.length, 1); assert.equal(calls, 2);
});
test('Pomodoro starts from a task, persists across closing its panel and prevents task completion', async () => {
  const { user, add, engine, timer } = await mount(); await add('专注写作');
  await user.click(screen.getByText('专注写作', { exact: true }));
  await user.click(screen.getByRole('button', { name: '专注此任务' }));
  await screen.findByRole('main', { name: '番茄钟窗口' });
  assert.equal(screen.queryByRole('dialog', { name: '番茄钟' }), null);
  assert.equal((screen.getByRole('combobox', { name: '番茄钟关联任务' }) as HTMLSelectElement).value, engine.state.tasks[0].id);
  await user.click(screen.getByRole('button', { name: '开始专注' }));
  await screen.findByRole('button', { name: '暂停' });
  assert.equal((screen.getByRole('combobox', { name: '番茄钟关联任务' }) as HTMLSelectElement).disabled, true);
  await user.click(screen.getByRole('button', { name: '收起番茄钟' }));
  assert.equal(timer.snapshot().session.status, 'running');
  await user.click(screen.getByRole('button', { name: '打开番茄钟' }));
  await user.click(screen.getByRole('button', { name: '暂停' }));
  await screen.findByRole('button', { name: '继续' });
  await user.click(screen.getByRole('button', { name: '重置' }));
  await screen.findByRole('button', { name: '开始专注' });
  assert.equal(screen.getByRole('timer', { name: '剩余时间' }).textContent, '25:00');
  assert.equal(engine.state.tasks[0].values.completed, false);
});

test('Pomodoro controls remain available in compact mode and custom settings update the clock', async () => {
  const { user, timer } = await mount(); await resize(360);
  await user.click(screen.getByRole('button', { name: '展开清单导航' }));
  await user.click(screen.getByRole('button', { name: '打开番茄钟' }));
  await user.click(screen.getByRole('button', { name: '时长设置' }));
  fireEvent.change(screen.getByLabelText('专注分钟数'), { target: { value: '45' } });
  await user.click(screen.getByRole('button', { name: '保存时长' }));
  assert.equal(timer.snapshot().settings.focusMinutes, 45);
  assert.equal(screen.getByRole('timer', { name: '剩余时间' }).textContent, '45:00');
  await user.click(screen.getByRole('button', { name: '短休息' }));
  assert.equal(screen.getByRole('timer', { name: '剩余时间' }).textContent, '05:00');
  await user.click(screen.getByRole('button', { name: '开始短休息' }));
  assert.equal(timer.snapshot().session.phase, 'shortBreak');
});

test('Pomodoro shows an IPC failure and does not pretend the timer started', async () => {
  const { user, api } = await mount();
  api.pomodoroCommand = async () => { throw new Error('计时保存失败'); };
  await user.click(screen.getByRole('button', { name: '打开番茄钟' }));
  await user.click(screen.getByRole('button', { name: '开始专注' }));
  await screen.findByRole('alert');
  assert.equal(screen.getByRole('alert').textContent, '计时保存失败');
  assert.ok(screen.getByRole('button', { name: '开始专注' }));
});
test('UI creates, stars, completes and searches a task through the desktop bridge', async () => {
  const { engine, user, add } = await mount(); await add('整理工作计划');
  assert.equal(engine.state.tasks.length, 1);
  await user.click(screen.getByRole('button', { name: '标为重要 整理工作计划' }));
  assert.equal(engine.state.tasks[0].values.important, true);
  await user.click(screen.getByRole('button', { name: /^重要/ }));
  await screen.findByRole('heading', { name: '重要' });
  await user.click(screen.getByRole('button', { name: '完成 整理工作计划' }));
  assert.equal(engine.state.tasks[0].values.completed, true);
  await user.type(screen.getByRole('textbox', { name: '搜索任务' }), '工作计划');
  await screen.findByRole('heading', { name: '搜索结果' });
  assert.ok(screen.getByText('整理工作计划', { exact: true }));
});
test('right-click deletes only the targeted task without opening details and undo restores it', async () => {
  const { engine, user, add } = await mount();
  await add('保留的任务'); await add('右键删除的任务');
  const target = engine.state.tasks.find(task => task.values.title === '右键删除的任务')!;
  const kept = engine.state.tasks.find(task => task.values.title === '保留的任务')!;
  fireEvent.contextMenu(screen.getByText('右键删除的任务', { exact: true }), { clientX: 420, clientY: 180 });
  assert.ok(screen.getByRole('menu', { name: '任务操作' }));
  assert.equal(screen.queryByLabelText('任务详情'), null);
  await user.click(screen.getByRole('menuitem', { name: '删除任务' }));
  await waitFor(() => assert.equal(engine.state.tasks.find(task => task.id === target.id)!.values.deleted, true));
  assert.equal(screen.queryByText('右键删除的任务', { exact: true }), null);
  assert.ok(screen.getByText('保留的任务', { exact: true }));
  assert.equal(engine.state.tasks.find(task => task.id === kept.id)!.values.deleted, false);
  assert.equal(screen.queryByRole('menu'), null);
  assert.equal(screen.queryByLabelText('任务详情'), null);
  await user.click(screen.getByRole('button', { name: '撤销' }));
  await screen.findByText('右键删除的任务', { exact: true });
  assert.equal(engine.state.tasks.length, 2);
  assert.equal(engine.state.tasks.find(task => task.id === target.id)!.values.deleted, false);
});

test('completed search results support the task menu without losing the query or another task draft', async () => {
  const { engine, user, add } = await mount();
  await add('示例：保留任务'); await add('示例：已完成任务');
  await user.click(screen.getByRole('button', { name: '完成 示例：已完成任务' }));
  await user.type(screen.getByRole('textbox', { name: '搜索任务' }), '示例');
  await user.click(screen.getByText('示例：保留任务', { exact: true }));
  const notes = screen.getByRole('textbox', { name: '备注' }) as HTMLTextAreaElement;
  fireEvent.change(notes, { target: { value: '继续编辑的备注' } });
  const target = screen.getByText('示例：已完成任务', { exact: true }).closest('.task-body') as HTMLButtonElement;
  fireEvent.contextMenu(target, { clientX: 500, clientY: 250 });
  await user.keyboard('{Escape}');
  assert.equal(screen.queryByRole('menu'), null);
  assert.equal(document.activeElement, target);
  assert.equal((screen.getByRole('textbox', { name: '搜索任务' }) as HTMLInputElement).value, '示例');
  assert.equal(screen.getByRole('textbox', { name: '备注' }), notes);
  assert.equal(notes.value, '继续编辑的备注');
  await user.keyboard('{Shift>}{F10}{/Shift}');
  assert.equal(document.activeElement, screen.getByRole('menuitem', { name: '标记为未完成' }));
  await user.keyboard('{End}');
  assert.equal(document.activeElement, screen.getByRole('menuitem', { name: '删除任务' }));
  await user.keyboard('{Enter}');
  await waitFor(() => assert.equal(screen.queryByText('示例：已完成任务', { exact: true }), null));
  assert.equal((screen.getByRole('textbox', { name: '任务名称' }) as HTMLInputElement).value, '示例：保留任务');
  assert.equal(screen.getByRole('textbox', { name: '备注' }), notes);
  assert.equal(notes.value, '继续编辑的备注');
  assert.equal((screen.getByRole('textbox', { name: '搜索任务' }) as HTMLInputElement).value, '示例');
  await user.click(screen.getByRole('button', { name: '撤销' }));
  await screen.findByText('示例：已完成任务', { exact: true });
  assert.equal(engine.state.tasks.find(task => task.values.title === '示例：已完成任务')!.values.completed, true);
});

test('a failed context-menu deletion leaves the task intact and reports the storage error', async () => {
  const { engine, api, user, add } = await mount(); await add('保留未删除任务');
  const command = api.command;
  api.command = async input => {
    if (input.type === 'task.update' && input.patch.deleted) throw new Error('无法保存删除操作');
    return command(input);
  };
  fireEvent.contextMenu(screen.getByText('保留未删除任务', { exact: true }), { clientX: 420, clientY: 180 });
  await user.click(screen.getByRole('menuitem', { name: '删除任务' }));
  await screen.findByText('无法保存删除操作', { exact: true });
  assert.ok(screen.getByText('保留未删除任务', { exact: true }));
  assert.equal(engine.state.tasks[0].values.deleted, false);
  assert.equal(screen.queryByText('任务已删除', { exact: true }), null);
  assert.equal(screen.queryByRole('button', { name: '撤销' }), null);
});

function openTaskMenu(title: string) {
  fireEvent.contextMenu(screen.getByText(title, { exact: true }), { clientX: 420, clientY: 250 });
}

test('task menus move tasks in and out of My Day and Important without deleting or opening them', async () => {
  const { engine, user, add } = await mount();
  await add('菜单操作目标'); await add('保留原样');
  const target = engine.state.tasks.find(task => task.values.title === '菜单操作目标')!;
  const other = structuredClone(engine.state.tasks.find(task => task.values.title === '保留原样'));
  openTaskMenu('菜单操作目标');
  await user.click(screen.getByRole('menuitem', { name: '从我的一天移除' }));
  await waitFor(() => assert.equal(screen.queryByText('菜单操作目标', { exact: true }), null));
  assert.equal(target.values.myDay, null); assert.equal(target.values.deleted, false);
  assert.equal(screen.queryByLabelText('任务详情'), null);
  await user.click(screen.getByRole('button', { name: /^全部任务/ }));
  openTaskMenu('菜单操作目标');
  assert.ok(screen.getByRole('menuitem', { name: '添加到我的一天' }));
  await user.click(screen.getByRole('menuitem', { name: '标记为重要' }));
  assert.equal(target.values.important, true);
  await user.click(screen.getByRole('button', { name: /^重要/ }));
  openTaskMenu('菜单操作目标');
  await user.click(screen.getByRole('menuitem', { name: '取消重要标记' }));
  await waitFor(() => assert.equal(screen.queryByText('菜单操作目标', { exact: true }), null));
  assert.equal(target.values.important, false); assert.equal(target.values.deleted, false);
  await user.click(screen.getByRole('button', { name: /^全部任务/ }));
  openTaskMenu('菜单操作目标');
  await user.click(screen.getByRole('menuitem', { name: '添加到我的一天' }));
  assert.equal(target.values.myDay, localDate());
  await user.click(screen.getByRole('button', { name: /^我的一天/ }));
  assert.ok(screen.getByText('菜单操作目标', { exact: true }));
  assert.equal(screen.queryByLabelText('任务详情'), null);
  assert.deepEqual(engine.state.tasks.find(task => task.values.title === '保留原样'), other);
});

test('a past My Day date offers adding today and completion can be reversed from the completed view', async () => {
  const { engine, api, user, add } = await mount(); await add('昨天安排的任务');
  const target = engine.state.tasks[0];
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  await act(async () => { await api.command({ type: 'task.update', id: target.id, patch: { myDay: localDate(yesterday), notes: '保留备注' } }); });
  await user.click(screen.getByRole('button', { name: /^全部任务/ }));
  openTaskMenu('昨天安排的任务');
  assert.equal(screen.queryByRole('menuitem', { name: '从我的一天移除' }), null);
  await user.click(screen.getByRole('menuitem', { name: '添加到我的一天' }));
  openTaskMenu('昨天安排的任务');
  await user.click(screen.getByRole('menuitem', { name: '标记为已完成' }));
  assert.equal(target.values.completed, true);
  await user.click(within(screen.getByRole('navigation', { name: '智能清单' })).getByRole('button', { name: /^已完成/ }));
  openTaskMenu('昨天安排的任务');
  assert.equal(screen.queryByRole('menuitem', { name: '专注此任务' }), null);
  await user.click(screen.getByRole('menuitem', { name: '标记为未完成' }));
  await waitFor(() => assert.equal(screen.queryByText('昨天安排的任务', { exact: true }), null));
  assert.equal(target.values.completed, false); assert.equal(target.values.deleted, false);
  assert.equal(target.values.notes, '保留备注'); assert.equal(target.values.myDay, localDate());
});

test('menu keyboard navigation and live labels preserve a search query and another task draft', async () => {
  const { engine, api, user, add } = await mount();
  await add('菜单：正在编辑'); await add('菜单：另一个任务');
  await user.type(screen.getByRole('textbox', { name: '搜索任务' }), '菜单：');
  await user.click(screen.getByText('菜单：正在编辑', { exact: true }));
  const notes = screen.getByRole('textbox', { name: '备注' }) as HTMLTextAreaElement;
  fireEvent.change(notes, { target: { value: '正在编辑的草稿' } });
  const target = engine.state.tasks.find(task => task.values.title === '菜单：另一个任务')!;
  openTaskMenu('菜单：另一个任务');
  assert.equal(document.activeElement, screen.getByRole('menuitem', { name: '标记为已完成' }));
  await user.keyboard('{ArrowDown}');
  assert.equal(document.activeElement, screen.getByRole('menuitem', { name: '从我的一天移除' }));
  await user.keyboard('{End}{ArrowDown}');
  assert.equal(document.activeElement, screen.getByRole('menuitem', { name: '标记为已完成' }));
  await user.keyboard('{Home}{ArrowUp}');
  assert.equal(document.activeElement, screen.getByRole('menuitem', { name: '删除任务' }));
  await act(async () => { await api.command({ type: 'task.update', id: target.id, patch: { myDay: null, important: true, completed: true } }); });
  assert.ok(screen.getByRole('menuitem', { name: '标记为未完成' }));
  assert.ok(screen.getByRole('menuitem', { name: '添加到我的一天' }));
  assert.ok(screen.getByRole('menuitem', { name: '取消重要标记' }));
  assert.equal(screen.queryByRole('menuitem', { name: '专注此任务' }), null);
  await user.keyboard('{Escape}');
  assert.equal(document.activeElement, screen.getByText('菜单：另一个任务', { exact: true }).closest('.task-body'));
  assert.equal((screen.getByRole('textbox', { name: '搜索任务' }) as HTMLInputElement).value, '菜单：');
  assert.equal(screen.getByRole('textbox', { name: '备注' }), notes);
  assert.equal(notes.value, '正在编辑的草稿');
  openTaskMenu('菜单：另一个任务');
  await user.click(screen.getByRole('menuitem', { name: '取消重要标记' }));
  assert.equal(target.values.important, false); assert.equal(notes.value, '正在编辑的草稿');
});

test('failed task-menu updates retain the task state and can be retried', async () => {
  const { engine, api, user, add } = await mount(); await add('保存失败后重试');
  const command = api.command;
  api.command = async input => {
    if (input.type === 'task.update' && input.patch.important) throw new Error('无法保存星标');
    return command(input);
  };
  openTaskMenu('保存失败后重试');
  await user.click(screen.getByRole('menuitem', { name: '标记为重要' }));
  await screen.findByText('无法保存星标', { exact: true });
  assert.equal(engine.state.tasks[0].values.important, false);
  assert.ok(screen.getByText('保存失败后重试', { exact: true }));
  api.command = command;
  openTaskMenu('保存失败后重试');
  await user.click(screen.getByRole('menuitem', { name: '标记为重要' }));
  assert.equal(engine.state.tasks[0].values.important, true);
});

test('task menus open a focused timer or task details only when explicitly selected', async () => {
  const { engine, user, add, timer } = await mount(); await add('从右键开始专注');
  openTaskMenu('从右键开始专注');
  await user.click(screen.getByRole('menuitem', { name: '专注此任务' }));
  await screen.findByRole('main', { name: '番茄钟窗口' });
  assert.equal(timer.snapshot().session.task?.id, engine.state.tasks[0].id);
  assert.equal(screen.queryByLabelText('任务详情'), null);
  await user.click(screen.getByRole('button', { name: '收起番茄钟' }));
  openTaskMenu('从右键开始专注');
  await user.click(screen.getByRole('menuitem', { name: '打开任务详情' }));
  assert.equal((screen.getByRole('textbox', { name: '任务名称' }) as HTMLInputElement).value, '从右键开始专注');
  assert.equal(engine.state.tasks[0].values.completed, false);
});

test('UI edits task notes, steps and deadline and keeps them on the same record', async () => {
  const { engine, user, add } = await mount(); await add('准备资料');
  await user.click(screen.getByText('准备资料', { exact: true }));
  await user.type(screen.getByRole('textbox', { name: '备注' }), '整理会议讨论结果'); await user.tab();
  await waitFor(() => assert.equal(engine.state.tasks[0].values.notes, '整理会议讨论结果'));
  await user.type(screen.getByRole('textbox', { name: '添加步骤' }), '核对日期{Enter}');
  await screen.findByText('核对日期', { exact: true });
  await user.click(screen.getByRole('button', { name: '完成步骤 核对日期' }));
  assert.equal(engine.state.steps[0].values.completed, true);
  fireEvent.change(screen.getByLabelText('截止日期', { exact: true }), { target: { value: '2026-12-01' } });
  await waitFor(() => assert.equal(engine.state.tasks[0].values.dueDate, '2026-12-01'));
  assert.equal(engine.state.tasks.length, 1);
});
test('UI creates a custom list and routes a new task into it', async () => {
  const { engine, user, add } = await mount();
  await user.click(screen.getAllByRole('button', { name: '新建清单' })[0]);
  await user.type(screen.getByLabelText('清单名称'), '生活清单');
  await user.click(screen.getByRole('button', { name: '绿色' }));
  await user.click(screen.getByRole('button', { name: '保存清单' }));
  await screen.findByRole('heading', { name: '生活清单' });
  await add('买一本新书');
  assert.equal(engine.state.lists[0].values.color, 'green');
  assert.equal(engine.state.tasks[0].values.listId, engine.state.lists[0].id);
});

test('search additions go to inbox without silently inheriting the previous smart list', async () => {
  const { engine, user, add } = await mount();
  await user.click(screen.getByRole('button', { name: /^重要/ }));
  await user.type(screen.getByRole('textbox', { name: '搜索任务' }), '找不到的关键词');
  assert.ok(screen.getByText('新任务将添加到“任务”'));
  await add('搜索时记下的新任务');
  await screen.findByRole('heading', { name: '任务' });
  const task = engine.state.tasks[0].values;
  assert.equal(task.listId, 'inbox'); assert.equal(task.important, false);
  assert.equal(task.myDay, null); assert.equal(task.dueDate, null);
});

test('planned composer displays its default date and clearing it creates a visible undated task', async () => {
  const { engine, user, add } = await mount();
  await user.click(screen.getByRole('button', { name: /^计划/ }));
  assert.equal((screen.getByLabelText('新任务截止日期') as HTMLInputElement).value, localDate());
  assert.ok(screen.getByText('截止日期：今天'));
  await add('今天要交的任务');
  assert.equal(engine.state.tasks[0].values.dueDate, localDate());
  await user.click(screen.getByRole('button', { name: '清除新任务截止日期' }));
  await add('还没有定日期的任务');
  await screen.findByRole('heading', { name: '任务' });
  assert.equal(engine.state.tasks[1].values.dueDate, null);
});

test('planned sort matches its label and each list remembers its own sorting choice', async () => {
  const { engine, api, user } = await mount();
  await act(async () => {
    await api.command({ type: 'task.add', title: '较早添加、较早截止', listId: 'inbox', dueDate: '2030-01-01' });
    await api.command({ type: 'task.add', title: '较晚添加、较晚截止', listId: 'inbox', dueDate: '2030-02-01' });
    engine.state.tasks[0].values.createdAt = '2026-01-01T00:00:00.000Z';
    engine.state.tasks[1].values.createdAt = '2026-01-02T00:00:00.000Z';
    await api.command({ type: 'task.update', id: engine.state.tasks[0].id, patch: { important: true } });
  });
  await user.click(screen.getByRole('button', { name: /^计划/ }));
  const order = () => [...document.querySelectorAll('.task-title')].map(element => element.textContent);
  assert.equal((screen.getByLabelText('任务排序') as HTMLSelectElement).value, 'due');
  assert.deepEqual(order(), ['较早添加、较早截止', '较晚添加、较晚截止']);
  await user.selectOptions(screen.getByLabelText('任务排序'), 'created');
  assert.deepEqual(order(), ['较晚添加、较晚截止', '较早添加、较早截止']);
  await user.click(screen.getByRole('button', { name: /^全部任务/ }));
  await user.selectOptions(screen.getByLabelText('任务排序'), 'title');
  await user.click(screen.getByRole('button', { name: /^计划/ }));
  assert.equal((screen.getByLabelText('任务排序') as HTMLSelectElement).value, 'created');
});

test('collapsed completed tasks remain discoverable in search and in the completed view', async () => {
  const { user, add } = await mount(); await add('已完成也能找到');
  await user.click(screen.getByRole('button', { name: '完成 已完成也能找到' }));
  await user.click(screen.getByRole('button', { name: /^已完成/, expanded: true }));
  assert.equal(screen.queryByText('已完成也能找到', { exact: true }), null);
  await user.type(screen.getByRole('textbox', { name: '搜索任务' }), '也能找到');
  assert.ok(screen.getByText('已完成也能找到', { exact: true }));
  await user.click(within(screen.getByRole('navigation', { name: '智能清单' })).getByRole('button', { name: /^已完成/ }));
  assert.ok(screen.getByText('已完成也能找到', { exact: true }));
});

test('Escape saves a title without blur and closes only the current details layer', async () => {
  const { engine, user, add } = await mount(); await add('查找原任务');
  await user.type(screen.getByRole('textbox', { name: '搜索任务' }), '查找');
  await user.click(screen.getByText('查找原任务', { exact: true }));
  const title = screen.getByRole('textbox', { name: '任务名称' });
  title.focus(); fireEvent.change(title, { target: { value: '查找改名后的任务' } });
  await user.keyboard('{Escape}');
  await waitFor(() => assert.equal(screen.queryByRole('textbox', { name: '任务名称' }), null));
  assert.equal(engine.state.tasks[0].values.title, '查找改名后的任务');
  assert.equal((screen.getByRole('textbox', { name: '搜索任务' }) as HTMLInputElement).value, '查找');
  await waitFor(() => assert.equal(document.activeElement?.textContent?.startsWith('查找改名后的任务'), true));
});

test('failed task edits block leaving details, preserve text, and allow a successful retry', async () => {
  const { engine, api, user, add } = await mount(); await add('保存前的名称');
  await user.click(screen.getByText('保存前的名称', { exact: true }));
  const command = api.command;
  api.command = async () => { throw new Error('磁盘暂时不可写'); };
  fireEvent.change(screen.getByRole('textbox', { name: '任务名称' }), { target: { value: '一定要保留的名称' } });
  await user.click(screen.getByRole('button', { name: /^全部任务/ }));
  await screen.findByText('内容未能保存，请重试后再离开当前页面。');
  assert.equal((screen.getByRole('textbox', { name: '任务名称' }) as HTMLTextAreaElement).value, '一定要保留的名称');
  assert.equal(engine.state.tasks[0].values.title, '保存前的名称');
  api.command = command;
  await user.click(screen.getByRole('button', { name: '关闭任务详情' }));
  await waitFor(() => assert.equal(screen.queryByRole('textbox', { name: '任务名称' }), null));
  assert.equal(engine.state.tasks[0].values.title, '一定要保留的名称');
});

test('unsaved task names survive incoming updates and the final keystroke during a save', async () => {
  const { engine, api, user, add } = await mount(); await add('原来的名称');
  await user.click(screen.getByText('原来的名称', { exact: true }));
  const title = screen.getByRole('textbox', { name: '任务名称' });
  const command = api.command; let release!: () => void; let saving = false;
  api.command = async input => {
    if (input.type === 'task.update' && input.patch.title && !saving) {
      saving = true; await new Promise<void>(resolve => { release = resolve; });
    }
    return command(input);
  };
  fireEvent.change(title, { target: { value: '正在保存的名称' } });
  title.focus(); fireEvent.keyDown(title, { key: 'Enter' });
  await waitFor(() => assert.equal(saving, true));
  fireEvent.change(title, { target: { value: '保存中继续输入的最后一个字' } });
  await act(async () => { await command({ type: 'task.update', id: engine.state.tasks[0].id, patch: { title: '后台同步的名称' } }); });
  assert.equal((title as HTMLTextAreaElement).value, '保存中继续输入的最后一个字');
  await act(async () => release());
  await waitFor(() => assert.equal(engine.state.tasks[0].values.title, '保存中继续输入的最后一个字'));
});

test('input-method Enter does not submit forms and input-method Escape does not close details', async () => {
  const { engine, user } = await mount();
  const composer = screen.getByRole('textbox', { name: '添加任务' });
  fireEvent.change(composer, { target: { value: '中文候选词' } });
  assert.equal(fireEvent.keyDown(composer, { key: 'Enter', isComposing: true, keyCode: 229 }), false);
  assert.equal(engine.state.tasks.length, 0);
  await user.click(screen.getByRole('button', { name: '添加' }));
  await user.click(screen.getByText('中文候选词', { exact: true }));
  fireEvent.keyDown(screen.getByRole('textbox', { name: '任务名称' }), { key: 'Escape', isComposing: true });
  assert.ok(screen.getByRole('textbox', { name: '任务名称' }));
  assert.equal(fireEvent.keyDown(screen.getByRole('textbox', { name: '添加步骤' }), { key: 'Enter', isComposing: true }), false);
  assert.equal(engine.state.steps.length, 0);
});

test('compact search submits to visible results and Ctrl F selects the current query', async () => {
  const { user, add } = await mount(); await add('窄屏搜索的任务'); await resize(420);
  await user.keyboard('{Control>}f{/Control}');
  await waitFor(() => assert.equal(document.activeElement, screen.getByRole('textbox', { name: '搜索任务' })));
  await user.type(screen.getByRole('textbox', { name: '搜索任务' }), '窄屏{Enter}');
  await waitFor(() => assert.equal(document.getElementById('list-navigation')!.hasAttribute('inert'), true));
  assert.ok(screen.getByText('窄屏搜索的任务', { exact: true }));
  await user.click(screen.getByRole('button', { name: '退出搜索' }));
  await screen.findByRole('heading', { name: '我的一天' });
});

test('steps can be renamed and a deletion can be undone without losing the name', async () => {
  const { engine, user, add } = await mount(); await add('检查步骤操作');
  await user.click(screen.getByText('检查步骤操作', { exact: true }));
  await user.type(screen.getByRole('textbox', { name: '添加步骤' }), '原步骤{Enter}');
  await user.click(await screen.findByRole('button', { name: '编辑步骤 原步骤' }));
  const input = screen.getByRole('textbox', { name: '步骤名称' });
  await user.clear(input); await user.type(input, '改名后的步骤{Enter}');
  await screen.findByRole('button', { name: '编辑步骤 改名后的步骤' });
  await waitFor(() => assert.equal(document.activeElement, screen.getByRole('button', { name: '编辑步骤 改名后的步骤' })));
  await user.click(screen.getByRole('button', { name: '删除步骤 改名后的步骤' }));
  await user.click(await screen.findByRole('button', { name: '撤销' }));
  await screen.findByRole('button', { name: '编辑步骤 改名后的步骤' });
  assert.equal(engine.state.steps[0].values.deleted, false);
  assert.equal(engine.state.steps[0].values.title, '改名后的步骤');
});

test('list deletion requires a deliberate confirmation and preserves its tasks', async () => {
  const { engine, user, add } = await mount();
  await user.click(screen.getAllByRole('button', { name: '新建清单' })[0]);
  await user.type(screen.getByLabelText('清单名称'), '有任务的清单');
  await user.click(screen.getByRole('button', { name: '保存清单' }));
  await screen.findByRole('heading', { name: '有任务的清单' }); await add('需要保留的任务');
  await user.click(screen.getByRole('button', { name: '编辑清单' }));
  await user.click(screen.getByRole('button', { name: '删除清单' }));
  assert.equal(engine.state.lists[0].values.deleted, false);
  await user.click(screen.getByRole('button', { name: '取消' }));
  assert.ok(screen.getByLabelText('清单名称'));
  await user.click(screen.getByRole('button', { name: '删除清单' }));
  await user.click(screen.getByRole('button', { name: '确认删除清单' }));
  await screen.findByRole('heading', { name: '任务' });
  assert.equal(engine.state.lists[0].values.deleted, true);
  assert.equal(engine.state.tasks[0].values.deleted, false);
  assert.equal(engine.state.tasks[0].values.listId, 'inbox');
});

test('note-gallery deletion presents its usable undo inside the active modal', async () => {
  const { engine, api, user } = await mount();
  await act(async () => { await api.command({ type: 'note.add', title: '可撤销的便签' }); });
  await user.click(screen.getByRole('button', { name: /^桌面便签/ }));
  const gallery = screen.getByRole('dialog', { name: '桌面便签' });
  await user.click(within(gallery).getByRole('button', { name: '删除便签 可撤销的便签' }));
  const undo = await within(gallery).findByRole('button', { name: '撤销' });
  await user.click(undo);
  await within(gallery).findByRole('button', { name: '打开便签 可撤销的便签' });
  assert.equal(engine.state.notes[0].values.deleted, false);
});
test('settings choose a local folder and persist the selected zoom without a cloud login', async () => {
  const { user } = await mount();
  await user.click(screen.getByRole('button', { name: '打开设置' }));
  assert.equal(screen.queryByLabelText('应用 Client ID'), null);
  await user.click(screen.getByRole('button', { name: '选择文件夹' }));
  await waitFor(() => assert.equal(screen.getByLabelText('当前数据文件夹').textContent, 'D:\\OneDrive\\GTodo'));
  await user.selectOptions(screen.getByRole('combobox', { name: '界面缩放比例' }), '150');
  await waitFor(() => assert.equal((screen.getByRole('combobox', { name: '界面缩放比例' }) as HTMLSelectElement).value, '150'));
  await user.click(screen.getByRole('button', { name: '恢复默认缩放' }));
  await waitFor(() => assert.equal((screen.getByRole('combobox', { name: '界面缩放比例' }) as HTMLSelectElement).value, '100'));
});
test('resizing switches details to a drawer without discarding an in-progress note', async () => {
  const { user, add } = await mount(); await add('检查窄窗口');
  await user.click(screen.getByText('检查窄窗口', { exact: true }));
  await user.type(screen.getByRole('textbox', { name: '备注' }), '正在编辑的内容');
  await resize(640);
  assert.ok(screen.getByRole('dialog', { name: '任务详情' }));
  assert.equal((screen.getByRole('textbox', { name: '备注' }) as HTMLTextAreaElement).value, '正在编辑的内容');
  assert.equal(document.querySelector('.app-shell')?.getAttribute('data-navigation'), 'sidebar');
  await resize(1320);
  assert.equal(screen.queryByRole('dialog', { name: '任务详情' }), null);
  assert.equal((screen.getByRole('textbox', { name: '备注' }) as HTMLTextAreaElement).value, '正在编辑的内容');
});

test('Outlook settings require explicit enable, show sync failures, and preserve target when stopped', async () => {
  const { api, user } = await mount(); let enables = 0; const configure = api.configureOutlook;
  api.configureOutlook = async input => { if (input.enabled) enables++; return configure(input); };
  await user.click(screen.getByRole('button', { name: '打开设置' }));
  await user.click(screen.getByRole('button', { name: '读取 Outlook 日历' }));
  await screen.findByRole('combobox', { name: 'Outlook 账户日历' }); assert.equal(enables, 0);
  await user.click(screen.getByRole('button', { name: '开启同步' }));
  await screen.findByRole('button', { name: '停止同步' }); assert.equal(enables, 1);
  api.syncOutlook = async () => { const next = await api.getState(); next.outlook = { ...next.outlook, phase: 'error', error: 'Outlook 日历不可写' }; return next; };
  await user.click(screen.getByRole('button', { name: '立即同步' }));
  await screen.findByText('Outlook 日历不可写');
  await user.click(screen.getByRole('button', { name: '停止同步' }));
  await screen.findByRole('button', { name: '恢复同步' });
  assert.ok(screen.getByText('测试账户 / 日历 / GTodo'));
});
test('compact navigation is accessible through its menu and search shortcut', async () => {
  const { user } = await mount(); await resize(420);
  const navigation = document.getElementById('list-navigation')!;
  assert.equal(navigation.hasAttribute('inert'), true);
  await user.click(screen.getByRole('button', { name: '展开清单导航' }));
  assert.equal(navigation.hasAttribute('inert'), false);
  await user.click(screen.getByRole('button', { name: '收起清单导航' }));
  await user.keyboard('{Control>}k{/Control}');
  await waitFor(() => assert.equal(document.activeElement, screen.getByRole('textbox', { name: '搜索任务' })));
  assert.equal(navigation.hasAttribute('inert'), false);
});
test('failed local save keeps the entered task text and surfaces the error', async () => {
  const { api, user } = await mount();
  api.command = async () => { throw new Error('磁盘空间不足'); };
  await user.type(screen.getByRole('textbox', { name: '添加任务' }), '尚未保存的任务');
  await user.click(screen.getByRole('button', { name: '添加' }));
  await screen.findByText('磁盘空间不足', { exact: true });
  assert.equal((screen.getByRole('textbox', { name: '添加任务' }) as HTMLInputElement).value, '尚未保存的任务');
});

test('desktop notes gallery creates and reopens notes using the native window bridge', async () => {
  const { engine, api, user } = await mount();
  const opened: string[] = []; api.noteWindow = async action => { if (action.type === 'open') opened.push(action.id); };
  await user.click(screen.getByRole('button', { name: '桌面便签' }));
  await screen.findByRole('dialog', { name: '桌面便签' });
  await user.click(screen.getByRole('button', { name: '新建便签' }));
  await screen.findByRole('button', { name: '打开便签 未命名便签' });
  assert.equal(engine.state.notes.length, 1);
  await user.click(screen.getByRole('button', { name: '打开便签 未命名便签' }));
  assert.deepEqual(opened, [engine.state.notes[0].id]);
});

test('task notes require confirmation to link, then both editors share changes and note deletion preserves the remark', async () => {
  const { engine, api, user, add } = await mount(); await add('会议准备');
  assert.equal(engine.state.notes.length, 0);
  await user.click(screen.getByText('会议准备', { exact: true }));
  await user.type(screen.getByRole('textbox', { name: '备注' }), '整理议题');
  await user.click(screen.getByRole('button', { name: '创建关联便签' }));
  await screen.findByRole('dialog', { name: '创建关联便签' });
  assert.equal(engine.state.notes.length, 0);
  await user.click(screen.getByRole('button', { name: '取消' }));
  assert.equal(engine.state.notes.length, 0);
  await user.click(screen.getByRole('button', { name: '创建关联便签' }));
  await user.click(screen.getByRole('button', { name: '确认创建' }));
  await waitFor(() => assert.equal(engine.state.notes.length, 1));
  assert.equal(engine.state.notes[0].values.title, '会议准备');
  assert.equal(engine.state.notes[0].values.content, '整理议题');
  const noteId = engine.state.notes[0].id;
  const opened: string[] = []; api.noteWindow = async action => { if (action.type === 'open') opened.push(action.id); };
  await user.click(screen.getByRole('button', { name: '打开关联便签' }));
  assert.deepEqual(opened, [noteId]); assert.equal(engine.state.notes.length, 1);
  const { default: StickyNoteWindow } = await import('../src/notes/StickyNoteWindow');
  render(React.createElement(StickyNoteWindow, { id: noteId }));
  await screen.findByRole('textbox', { name: '便签内容' });
  await user.type(screen.getByRole('textbox', { name: '便签内容' }), '，从便签补充'); await user.tab();
  await waitFor(() => assert.equal((screen.getByRole('textbox', { name: '备注' }) as HTMLTextAreaElement).value, '整理议题，从便签补充'));
  await user.type(screen.getByRole('textbox', { name: '备注' }), '，从任务补充'); await user.tab();
  await waitFor(() => assert.equal((screen.getByRole('textbox', { name: '便签内容' }) as HTMLTextAreaElement).value, '整理议题，从便签补充，从任务补充'));
  await user.click(screen.getByRole('button', { name: '便签编辑选项' }));
  await user.selectOptions(screen.getByRole('combobox', { name: '便签内容格式' }), 'markdown');
  await waitFor(() => assert.equal((screen.getByRole('combobox', { name: '备注格式' }) as HTMLSelectElement).value, 'markdown'));
  await act(async () => { await api.deleteNote(noteId); });
  await screen.findByRole('button', { name: '创建关联便签' });
  assert.equal(engine.state.tasks[0].values.deleted, false);
  assert.equal(engine.state.tasks[0].values.notes, '整理议题，从便签补充，从任务补充');
  assert.equal(screen.queryByText('关联备注', { exact: true }), null);
});

test('failed link creation keeps the confirmation and remark available for retry', async () => {
  const { engine, api, user, add } = await mount(); await add('创建失败后重试');
  await user.click(screen.getByText('创建失败后重试', { exact: true }));
  await user.type(screen.getByRole('textbox', { name: '备注' }), '尚未关联的内容');
  const createLinkedNote = api.createLinkedNote;
  api.createLinkedNote = async () => { throw new Error('关联保存失败'); };
  await user.click(screen.getByRole('button', { name: '创建关联便签' }));
  await user.click(screen.getByRole('button', { name: '确认创建' }));
  await screen.findByText('关联保存失败', { exact: true });
  assert.equal(engine.state.notes.length, 0);
  assert.equal(engine.state.tasks[0].values.notes, '尚未关联的内容');
  api.createLinkedNote = createLinkedNote;
  await user.click(screen.getByRole('button', { name: '确认创建' }));
  await screen.findByRole('button', { name: '打开关联便签' });
  assert.equal(engine.state.notes.length, 1);
  assert.equal(screen.queryByRole('dialog', { name: '创建关联便签' }), null);
});

test('note window flush acknowledges only after the final text is saved', async () => {
  const { engine, api, user } = await mount(); cleanup();
  engine.apply({ type: 'note.add' }); const note = engine.state.notes[0];
  let flush: ((requestId: string) => void) | undefined;
  const acknowledgements: { requestId: string; success: boolean; content: string }[] = [];
  api.onNoteFlush = listener => { flush = listener; return () => {}; };
  api.noteFlushed = async (requestId, success) => { acknowledgements.push({ requestId, success, content: engine.state.notes[0].values.content }); };
  const { NoteEditor } = await import('../src/notes/StickyNoteWindow');
  render(React.createElement(NoteEditor, { note, state: await api.getState(), api }));
  await user.type(screen.getByRole('textbox', { name: '便签内容' }), '输入后立即收起');
  await act(async () => { flush!('close-request'); });
  await waitFor(() => assert.deepEqual(acknowledgements, [{ requestId: 'close-request', success: true, content: '输入后立即收起' }]));
});

test('task notes opt into Markdown, preview headings, tables and highlighted code, and return to literal text', async () => {
  const { engine, user, add } = await mount(); await add('Markdown 任务');
  await user.click(screen.getByText('Markdown 任务', { exact: true }));
  assert.equal((screen.getByRole('combobox', { name: '备注格式' }) as HTMLSelectElement).value, 'text');
  await user.selectOptions(screen.getByRole('combobox', { name: '备注格式' }), 'markdown');
  const content = '# 示例标题\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst answer = 42;\n```\n\n<script>window.hacked = true</script>\n[危险链接](javascript:alert(1))';
  fireEvent.change(screen.getByRole('textbox', { name: '备注' }), { target: { value: content } });
  await user.click(screen.getByRole('button', { name: '预览备注' }));
  await screen.findByRole('heading', { name: '示例标题' });
  assert.ok(screen.getByRole('table')); assert.ok(document.querySelector('pre code.hljs'));
  assert.equal(document.querySelector('script'), null); assert.equal(document.querySelector('a[href^="javascript:"]'), null);
  assert.equal(engine.state.tasks[0].values.notesFormat, 'markdown');
  await user.selectOptions(screen.getByRole('combobox', { name: '备注格式' }), 'text');
  assert.equal((screen.getByRole('textbox', { name: '备注' }) as HTMLTextAreaElement).value, content);
  assert.equal(screen.queryByRole('button', { name: '预览备注' }), null);
});

test('image insertion uses a relative Markdown asset and preview opens only the document-scoped image URL', async () => {
  const { engine, api, user, add } = await mount(); await add('插图任务');
  await user.click(screen.getByText('插图任务', { exact: true }));
  await user.selectOptions(screen.getByRole('combobox', { name: '备注格式' }), 'markdown');
  const id = `${'b'.repeat(64)}.png`; const relative = `assets/${id}`;
  api.pickDocumentImage = async target => {
    assert.equal(target.id, engine.state.tasks[0].id);
    engine.apply({ type: 'task.update', id: target.id, patch: { notesAssets: { [relative]: id } } });
    return { path: relative, name: '图片.png' };
  };
  await user.click(screen.getByRole('button', { name: '插入图片到备注' }));
  await waitFor(() => assert.match(engine.state.tasks[0].values.notes, /!\[图片.png\]\(assets\//));
  await user.click(screen.getByRole('button', { name: '预览备注' }));
  const image = screen.getByRole('img', { name: '图片.png' });
  assert.match(image.getAttribute('src')!, new RegExp(`^gtodo://app/media/task/${engine.state.tasks[0].id}/`));
  let revealed = false;
  api.showDocumentFile = async target => { assert.equal(target.id, engine.state.tasks[0].id); revealed = true; };
  await user.click(screen.getByRole('button', { name: '打开备注文件位置' }));
  assert.equal(revealed, true);
});

test('a partial document image import keeps the successfully imported image visible', async () => {
  const { api, engine, user, add } = await mount(); await add('部分图片导入');
  await user.click(screen.getByText('部分图片导入', { exact: true }));
  await user.selectOptions(screen.getByRole('combobox', { name: '备注格式' }), 'markdown');
  let count = 0;
  api.insertDocumentImage = async () => { if (++count === 2) throw new Error('第二张图片无法读取'); return { path: `assets/${'e'.repeat(64)}.png`, name: '第一张.png' }; };
  const files = ['第一张.png', '第二张.png'].map(name => ({ name, type: 'image/png', size: 10, arrayBuffer: async () => new ArrayBuffer(10) }));
  fireEvent.paste(screen.getByRole('textbox', { name: '备注' }), { clipboardData: { files } });
  await screen.findByText('第二张图片无法读取');
  assert.match(engine.state.tasks[0].values.notes, /!\[第一张.png\]/);
});

test('a note flush waits for image insertion and saves the resulting Markdown before acknowledging', async () => {
  const { api, engine } = await mount(); cleanup();
  engine.apply({ type: 'note.add', title: '图片便签', content: '原正文', format: 'markdown' });
  let flush!: (id: string) => void; let acknowledged = false;
  api.onNoteFlush = callback => { flush = callback; return () => {}; };
  api.noteFlushed = async (_id, success) => { assert.equal(success, true); acknowledged = true; };
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  api.insertDocumentImage = async () => { await pending; return { path: `assets/${'f'.repeat(64)}.png`, name: '便签图片.png' }; };
  const { NoteEditor } = await import('../src/notes/StickyNoteWindow');
  render(React.createElement(NoteEditor, { note: engine.state.notes[0], state: await api.getState(), api }));
  fireEvent.paste(screen.getByRole('textbox', { name: '便签内容' }), { clipboardData: { files: [{ name: '便签图片.png', type: 'image/png', size: 10, arrayBuffer: async () => new ArrayBuffer(10) }] } });
  try {
    await act(async () => { flush('save-before-close'); await Promise.resolve(); });
    assert.equal(acknowledged, false, 'the note must not close before the imported image is written into its text');
  } finally {
    await act(async () => { release(); await pending; });
    await waitFor(() => assert.match(engine.state.notes[0].values.content, /!\[便签图片.png\]/));
  }
  await waitFor(() => assert.equal(acknowledged, true));
});

test('screenshots insert at the saved task-note selection and persist a document-scoped image', async () => {
  const { engine, api, user, add } = await mount(); await add('截图任务');
  await user.click(screen.getByText('截图任务', { exact: true }));
  await user.selectOptions(screen.getByRole('combobox', { name: '备注格式' }), 'markdown');
  const area = screen.getByRole('textbox', { name: '备注' }) as HTMLTextAreaElement;
  fireEvent.change(area, { target: { value: '前文\n后文' } }); area.setSelectionRange(3, 3); fireEvent.select(area);
  const id = `${'c'.repeat(64)}.png`; const relative = `assets/${id}`;
  api.captureDocumentImage = async target => {
    assert.equal(target.kind, 'task'); assert.equal(engine.state.tasks[0].values.notes, '前文\n后文');
    engine.apply({ type: 'task.update', id: target.id, patch: { notesAssets: { [relative]: id } } });
    return { path: relative, name: '截图示例' };
  };
  await user.click(screen.getByRole('button', { name: '截图插入备注' }));
  await waitFor(() => assert.equal(engine.state.tasks[0].values.notes, `前文\n![截图示例](${relative})\n后文`));
  await user.click(screen.getByRole('button', { name: '预览备注' }));
  assert.match((await screen.findByRole('img', { name: '截图示例' })).getAttribute('src')!, /gtodo:\/\/app\/media\/task\//);
});

test('plain-text screenshot conversion is explicit and cancellation or errors preserve the text', async () => {
  const { engine, api, user, add } = await mount(); await add('保留截图前的文字');
  await user.click(screen.getByText('保留截图前的文字', { exact: true }));
  fireEvent.change(screen.getByRole('textbox', { name: '备注' }), { target: { value: '保留草稿' } });
  let called = 0;
  api.captureDocumentImage = async () => { called++; throw new Error('截图未能启动'); };
  await user.click(screen.getByRole('button', { name: '截图插入备注' }));
  const prompt = screen.getByRole('group', { name: '截图格式确认' });
  await user.click(within(prompt).getByRole('button', { name: '取消' }));
  assert.equal(called, 0); assert.equal(engine.state.tasks[0].values.notesFormat, 'text');
  await user.click(screen.getByRole('button', { name: '截图插入备注' }));
  await user.click(screen.getByRole('button', { name: '转换并截图' }));
  await screen.findByText('截图未能启动'); assert.equal(engine.state.tasks[0].values.notes, '保留草稿');
  assert.equal(engine.state.tasks[0].values.notesFormat, 'markdown'); assert.equal(called, 1);
  api.captureDocumentImage = async () => null;
  await user.click(screen.getByRole('button', { name: '截图插入备注' }));
  await waitFor(() => assert.equal((screen.getByRole('button', { name: '截图插入备注' }) as HTMLButtonElement).disabled, false));
  assert.equal(engine.state.tasks[0].values.notes, '保留草稿'); assert.deepEqual(engine.state.tasks[0].values.notesAssets, {});
});

test('sticky-note screenshots stay in the collapsed toolbar and update an explicitly linked task', async () => {
  const { engine, api, user } = await mount(); cleanup();
  engine.apply({ type: 'task.add', title: '关联截图', listId: 'inbox' }); const task = engine.state.tasks[0];
  engine.apply({ type: 'task.update', id: task.id, patch: { notes: '便签正文', notesFormat: 'markdown' } });
  engine.apply({ type: 'task.link-note', id: task.id }); const note = engine.state.notes[0];
  const id = `${'d'.repeat(64)}.png`; const relative = `assets/${id}`;
  api.captureDocumentImage = async target => {
    assert.deepEqual(target, { kind: 'note', id: note.id });
    engine.apply({ type: 'note.update', id: note.id, patch: { assets: { [relative]: id } } });
    return { path: relative, name: '便签截图' };
  };
  const { NoteEditor } = await import('../src/notes/StickyNoteWindow');
  render(React.createElement(NoteEditor, { note, state: await api.getState(), api }));
  assert.equal(screen.queryByRole('button', { name: '截图插入便签内容' }), null);
  await user.click(screen.getByRole('button', { name: '便签编辑选项' }));
  await user.click(screen.getByRole('button', { name: '截图插入便签内容' }));
  await waitFor(() => assert.match(note.values.content, /!\[便签截图\]/));
  assert.equal(task.values.notes, note.values.content); assert.deepEqual(task.values.notesAssets, note.values.assets);
  assert.equal(screen.queryByRole('button', { name: '截图插入便签内容' }), null);
});

test('sticky notes choose Markdown independently and insert a real fenced code block', async () => {
  const { engine, api, user } = await mount(); cleanup();
  engine.apply({ type: 'note.add', content: '保留正文' });
  const { NoteEditor } = await import('../src/notes/StickyNoteWindow');
  render(React.createElement(NoteEditor, { note: engine.state.notes[0], state: await api.getState(), api }));
  assert.equal(screen.queryByRole('combobox', { name: '便签内容格式' }), null);
  assert.equal(screen.queryByRole('button', { name: '蓝色便签' }), null);
  await user.click(screen.getByRole('button', { name: '便签编辑选项' }));
  await user.click(screen.getByRole('button', { name: '蓝色便签' }));
  await user.selectOptions(screen.getByRole('combobox', { name: '便签内容格式' }), 'markdown');
  await user.click(screen.getByRole('button', { name: '插入代码块到便签内容' }));
  await waitFor(() => assert.match(engine.state.notes[0].values.content, /```text/));
  assert.equal(engine.state.notes[0].values.format, 'markdown');
  assert.equal(engine.state.notes[0].values.color, 'blue');
  await waitFor(() => assert.equal(screen.queryByRole('combobox', { name: '便签内容格式' }), null));
  await user.click(screen.getByRole('button', { name: '便签编辑选项' }));
  await user.click(screen.getByRole('button', { name: '预览便签内容' }));
  assert.ok(document.querySelector('pre code'));
  assert.match(screen.getByLabelText('便签内容预览').textContent!, /保留正文/);
});

test('settings stays in the title bar and the only timer launcher stays in the left navigation', async () => {
  await mount();
  assert.equal(screen.getAllByRole('button', { name: '打开设置' }).length, 1);
  assert.ok(screen.getByRole('button', { name: '打开设置' }).closest('.titlebar'));
  assert.equal(document.querySelector('.sidebar .settings-button'), null);
  assert.equal(screen.getAllByRole('button', { name: '打开番茄钟' }).length, 1);
  assert.ok(screen.getByRole('button', { name: '打开番茄钟' }).closest('.sidebar'));
  assert.equal(document.querySelector('.titlebar .pomodoro-launcher'), null);
});

test('pane resizing preserves the draft, remembers widths and uses drawers on a narrow window', async () => {
  const { user, api, add } = await mount(); await add('调整宽度');
  await user.click(screen.getByText('调整宽度', { exact: true }));
  await user.type(screen.getByRole('textbox', { name: '备注' }), '调整分栏时保留');
  const left = screen.getByRole('separator', { name: '调整清单栏宽度' });
  fireEvent.keyDown(left, { key: 'ArrowRight' });
  await waitFor(async () => assert.equal((await api.getState()).paneLayout.sidebar, 234));
  const right = screen.getByRole('separator', { name: '调整任务详情宽度' });
  fireEvent.keyDown(right, { key: 'ArrowLeft', shiftKey: true });
  await waitFor(async () => assert.equal((await api.getState()).paneLayout.details, 362));
  assert.equal((screen.getByRole('textbox', { name: '备注' }) as HTMLTextAreaElement).value, '调整分栏时保留');
  fireEvent.doubleClick(left);
  await waitFor(async () => assert.equal((await api.getState()).paneLayout.sidebar, 224));
  await resize(420);
  assert.equal(screen.queryByRole('separator'), null);
  assert.ok(screen.getByRole('dialog', { name: '任务详情' }));
  await resize(1320);
  assert.equal(screen.getByRole('separator', { name: '调整任务详情宽度' }).getAttribute('aria-valuenow'), '362');
});
