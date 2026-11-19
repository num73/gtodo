import test, { afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { JSDOM } from 'jsdom';
import { WorkspaceEngine } from '../src/shared/engine';
import { nextZoom, type AppState, type DesktopAPI } from '../src/shared/model';
import { emptyOutlookStatus } from '../src/shared/outlook';
import { PomodoroTimer } from '../electron/pomodoro';
import type { PomodoroSnapshot } from '../src/shared/pomodoro';

// Renderer behavior is tested in an isolated DOM, without controlling the user's preview window.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLDialogElement: dom.window.HTMLDialogElement, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
let viewportWidth = 1320;
const mediaListeners = new Set<() => void>();
dom.window.matchMedia = (query: string) => ({
  media: query, get matches() { return viewportWidth <= Number(query.match(/max-width:\s*(\d+)px/)?.[1] ?? 0); },
  addEventListener: (_event: string, listener: () => void) => mediaListeners.add(listener),
  removeEventListener: (_event: string, listener: () => void) => mediaListeners.delete(listener),
}) as unknown as MediaQueryList;
const { render, screen, cleanup, waitFor, fireEvent, act } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');
const { default: App } = await import('../src/App');
afterEach(() => { cleanup(); viewportWidth = 1320; });
after(() => dom.window.close());
async function resize(width: number) { await act(async () => { viewportWidth = width; for (const listener of mediaListeners) listener(); }); }

async function mount() {
  const engine = new WorkspaceEngine('ui-test-device');
  let dataPath = 'isolated-test-profile'; let zoom = 100; let outlook = emptyOutlookStatus();
  let onPomodoro: ((state: PomodoroSnapshot) => void) | undefined;
  const timer = new PomodoroTimer({ directory: 'unused-memory-only', write: async () => {}, task: id => {
    const task = engine.state.tasks.find(task => task.id === id && !task.values.completed && !task.values.deleted);
    return task ? { id: task.id, title: task.values.title } : null;
  }, changed: value => onPomodoro?.(value) });
  const snapshot = (): AppState => ({ workspace: structuredClone(engine.state), deviceId: engine.deviceId, dataPath, notice: null, folder: { error: null, lastRead: null }, zoom, version: '1.5.0', noteWindows: {}, outlook });
  const api: DesktopAPI = {
    getPomodoro: async () => timer.snapshot(), pomodoroCommand: command => timer.command(command),
    onPomodoro: callback => { onPomodoro = callback; return () => { onPomodoro = undefined; }; }, onOpenPomodoro: () => () => {},
    getState: async () => snapshot(),
    command: async value => { engine.apply(value); return snapshot(); },
    onState: () => () => {}, refreshFolder: async () => snapshot(),
    chooseDataFolder: async () => { dataPath = 'D:\\OneDrive\\GTodo'; return snapshot(); }, openDataFolder: async () => {},
    setZoom: async action => { zoom = nextZoom(zoom, action); return snapshot(); },
    exportBackup: async () => true, importBackup: async () => snapshot(),
    listOutlookCalendars: async () => [{ id: 'a'.repeat(64), name: '测试账户 / 日历' }],
    configureOutlook: async input => { outlook = { ...outlook, enabled: input.enabled, phase: input.enabled ? 'idle' : 'off', targetName: '测试账户 / 日历 / GTodo' }; return snapshot(); },
    syncOutlook: async () => { outlook.lastSyncedAt = new Date().toISOString(); return snapshot(); },
    windowControl: () => {},
    createNote: async input => { engine.apply({ type: 'note.add', ...input }); return engine.state.notes.at(-1)!.id; },
    noteWindow: async () => {}, deleteNote: async id => { engine.apply({ type: 'note.update', id, patch: { deleted: true } }); return snapshot(); },
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
  return { engine, api, user, add, timer };
}
test('Pomodoro starts from a task, persists across closing its panel and prevents task completion', async () => {
  const { user, add, engine, timer } = await mount(); await add('专注写作');
  await user.click(screen.getByText('专注写作', { exact: true }));
  await user.click(screen.getByRole('button', { name: '专注此任务' }));
  await screen.findByRole('dialog', { name: '番茄钟' });
  assert.equal((screen.getByRole('combobox', { name: '番茄钟关联任务' }) as HTMLSelectElement).value, engine.state.tasks[0].id);
  await user.click(screen.getByRole('button', { name: '开始专注' }));
  await screen.findByRole('button', { name: '暂停' });
  assert.equal((screen.getByRole('combobox', { name: '番茄钟关联任务' }) as HTMLSelectElement).disabled, true);
  await user.click(screen.getByRole('button', { name: '关闭对话框' }));
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
  await user.click(await screen.findByRole('button', { name: '生活清单' }));
  await add('买一本新书');
  assert.equal(engine.state.lists[0].values.color, 'green');
  assert.equal(engine.state.tasks[0].values.listId, engine.state.lists[0].id);
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
  assert.equal(document.querySelector('.app-shell')?.getAttribute('data-navigation'), 'drawer');
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

test('copying task details creates an independent desktop note with its content', async () => {
  const { engine, user, add } = await mount(); await add('会议准备');
  await user.click(screen.getByText('会议准备', { exact: true }));
  await user.type(screen.getByRole('textbox', { name: '备注' }), '整理议题');
  await user.click(screen.getByRole('button', { name: '复制为桌面便签' }));
  await waitFor(() => assert.equal(engine.state.notes.length, 1));
  assert.equal(engine.state.notes[0].values.title, '会议准备');
  assert.match(engine.state.notes[0].values.content, /整理议题/);
  assert.equal(engine.state.tasks.length, 1);
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
