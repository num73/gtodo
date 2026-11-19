import test, { afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { JSDOM } from 'jsdom';
import { WorkspaceEngine } from '../src/shared/engine';
import { nextZoom, type AppState, type DesktopAPI } from '../src/shared/model';
import { emptyOutlookStatus } from '../src/shared/outlook';
import { PomodoroTimer } from '../electron/pomodoro';
import type { PomodoroSnapshot } from '../src/shared/pomodoro';
import { defaultPaneLayout, type PaneLayout } from '../src/shared/layout';

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
const { default: PomodoroWindow } = await import('../src/pomodoro/PomodoroWindow');
afterEach(() => { cleanup(); viewportWidth = 1320; });
after(() => dom.window.close());
async function resize(width: number) { await act(async () => { viewportWidth = width; for (const listener of mediaListeners) listener(); }); }

async function mount() {
  const engine = new WorkspaceEngine('ui-test-device');
  let dataPath = 'isolated-test-profile'; let zoom = 100; let outlook = emptyOutlookStatus();
  const timerListeners = new Set<(state: PomodoroSnapshot) => void>();
  const stateListeners = new Set<(state: AppState) => void>();
  let timerView: ReturnType<typeof render> | null = null;
  let paneLayout: PaneLayout = { ...defaultPaneLayout };
  const pomodoroWindow = { open: false, pinned: false };
  const timer = new PomodoroTimer({ directory: 'unused-memory-only', write: async () => {}, task: id => {
    const task = engine.state.tasks.find(task => task.id === id && !task.values.completed && !task.values.deleted);
    return task ? { id: task.id, title: task.values.title } : null;
  }, changed: value => { for (const listener of timerListeners) listener(value); } });
  const snapshot = (): AppState => ({ workspace: structuredClone(engine.state), deviceId: engine.deviceId, dataPath, notice: null, folder: { error: null, lastRead: null }, zoom, version: '0.1.1', paneLayout: { ...paneLayout }, pomodoroWindow: { ...pomodoroWindow }, noteWindows: {}, outlook });
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
    listOutlookCalendars: async () => [{ id: 'a'.repeat(64), name: '测试账户 / 日历' }],
    configureOutlook: async input => { outlook = { ...outlook, enabled: input.enabled, phase: input.enabled ? 'idle' : 'off', targetName: '测试账户 / 日历 / GTodo' }; return snapshot(); },
    syncOutlook: async () => { outlook.lastSyncedAt = new Date().toISOString(); return snapshot(); },
    windowControl: () => {},
    createNote: async input => { engine.apply({ type: 'note.add', ...input }); return engine.state.notes.at(-1)!.id; },
    createLinkedNote: async id => { engine.apply({ type: 'task.link-note', id }); publish(); return engine.state.tasks.find(task => task.id === id)!.values.noteLink!.noteId; },
    pickDocumentImage: async () => null, insertDocumentImage: async () => ({ path: `assets/${'a'.repeat(64)}.png`, name: '图片.png' }), showDocumentFile: async () => {}, openLink: async () => {},
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
  return { engine, api, user, add, timer };
}
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
  await resize(640);
  assert.equal(screen.queryByRole('separator'), null);
  assert.ok(screen.getByRole('dialog', { name: '任务详情' }));
  await resize(1320);
  assert.equal(screen.getByRole('separator', { name: '调整任务详情宽度' }).getAttribute('aria-valuenow'), '362');
});
