import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Sun, Star, CalendarDays, Layers, CheckCheck, List, Plus, Search, Settings as SettingsIcon, Menu, ChevronDown, ChevronRight, Check, X, Minus, Square, Lightbulb, SlidersHorizontal, Trash2, ArrowDownWideNarrow, Bell, Repeat2, ListChecks, StickyNote, AlertCircle, Timer } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { colors, localDate, zoomSteps, type AppState, type Command, type Task, type TaskList, type ZoomAction } from './shared/model';
import Settings from './components/Settings';
import TaskDetails from './components/TaskDetails';
import TaskContextMenu, { type TaskMenuAction } from './components/TaskContextMenu';
import { linkedNoteForTask } from './shared/note-links';
import Modal from './components/Modal';
import NotesGallery from './notes/NotesGallery';
import { flushMainDrafts } from './notes/draft';
import { useMediaQuery } from './useMediaQuery';
import { PomodoroLauncher } from './pomodoro/Pomodoro';
import { usePomodoro } from './pomodoro/usePomodoro';
import PaneDivider from './components/PaneDivider';
import { defaultPaneLayout, dividerWidth, fitPaneLayout, minimumTaskWidth, paneLimits, type PaneLayout } from './shared/layout';

type View = 'day' | 'important' | 'planned' | 'all' | 'completed' | 'inbox' | string;
const smartViews: { id: string; title: string; icon: LucideIcon; color: string }[] = [
  { id: 'day', title: '我的一天', icon: Sun, color: 'purple' },
  { id: 'important', title: '重要', icon: Star, color: 'rose' },
  { id: 'planned', title: '计划', icon: CalendarDays, color: 'green' },
  { id: 'all', title: '全部任务', icon: Layers, color: 'blue' },
  { id: 'completed', title: '已完成', icon: CheckCheck, color: 'slate' },
];
const colorNames = { purple: '紫色', blue: '蓝色', green: '绿色', rose: '粉色', orange: '橙色', slate: '灰色' };
type Toast = { text: string; undo?: () => void };
type TaskMenu = { id: string; x: number; y: number; trigger: HTMLElement | null };
function prettyDate(value: string) {
  const today = localDate();
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  if (value === today) return '今天';
  if (value === localDate(tomorrow)) return '明天';
  return new Date(`${value}T12:00:00`).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
}
export default function App() {
  const api = window.gtodo;
  useEffect(() => api?.onNoteFlush(requestId => {
    void flushMainDrafts().then(() => api.noteFlushed(requestId, true), () => api.noteFlushed(requestId, false)).catch(() => {});
  }), [api]);
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [view, setView] = useState<View>('day');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [taskMenu, setTaskMenu] = useState<TaskMenu | null>(null);
  const [settings, setSettings] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const pomodoro = usePomodoro(api);
  const [paneLayout, setPaneLayout] = useState<PaneLayout>(defaultPaneLayout);
  const paneLayoutRef = useRef(paneLayout); paneLayoutRef.current = paneLayout;
  const [bodyWidth, setBodyWidth] = useState(window.innerWidth);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const compactNavigation = useMediaQuery('(max-width: 760px)');
  const overlayDetails = useMediaQuery('(max-width: 1120px)');
  const [suggestions, setSuggestions] = useState(false);
  const [showCompleted, setShowCompleted] = useState(true);
  const [sort, setSort] = useState('created');
  const [newTitle, setNewTitle] = useState('');
  const [newDue, setNewDue] = useState('');
  const [adding, setAdding] = useState(false);
  const [listDialog, setListDialog] = useState<'new' | TaskList | null>(null);
  const [listName, setListName] = useState('');
  const [listColor, setListColor] = useState<typeof colors[number]>('purple');
  const [listBusy, setListBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [today, setToday] = useState(localDate());
  const searchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLInputElement>(null);
  const taskButtons = useRef(new Map<string, HTMLButtonElement>());
  const notify = useCallback((text: string, undo?: () => void) => setToast({ text, undo }), []);
  useEffect(() => {
    if (!api) { setLoadError('请打开 GTodo 桌面应用。浏览器预览无法访问本地数据文件夹。'); return; }
    let alive = true;
    const removeListener = api.onState(value => { if (alive) setState(value); });
    api.getState().then(value => { if (alive) setState(value); }).catch(error => { if (alive) setLoadError(String(error)); });
    return () => { alive = false; removeListener(); };
  }, [api]);
  useEffect(() => setSidebarOpen(false), [compactNavigation]);
  useEffect(() => {
    if (!state) return;
    setPaneLayout(state.paneLayout);
    const element = bodyRef.current;
    const measure = () => setBodyWidth(element?.clientWidth || window.innerWidth);
    measure(); window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (element) observer?.observe(element);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [!!state]);
  useEffect(() => { const timer = setInterval(() => setToday(localDate()), 30000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 6000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => setTaskMenu(null), [view, query, settings, notesOpen, listDialog, compactNavigation, overlayDetails, showCompleted]);
  useEffect(() => {
    if (taskMenu && !state?.workspace.tasks.some(task => task.id === taskMenu.id && !task.values.deleted)) setTaskMenu(null);
  }, [state?.workspace.tasks, taskMenu?.id]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (settings || listDialog || notesOpen) return;
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault(); void createDesktopNote(); return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setSelectedId(null);
        if (compactNavigation) setSidebarOpen(true);
        window.requestAnimationFrame(() => searchRef.current?.focus());
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'n') {
        event.preventDefault(); setSidebarOpen(false); setSelectedId(null);
        window.requestAnimationFrame(() => composerRef.current?.focus());
      }
      if (event.key === 'Escape') { setSelectedId(null); setSidebarOpen(false); setSuggestions(false); setQuery(''); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [settings, listDialog, notesOpen, compactNavigation]);
  function openPomodoro(task?: Task) {
    setSidebarOpen(false);
    void api!.openPomodoro(task?.id).catch(error => notify((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));
  }
  function changePane(key: keyof PaneLayout, value: number) {
    const next = { ...paneLayoutRef.current, [key]: value }; paneLayoutRef.current = next; setPaneLayout(next);
  }
  function savePane(key: keyof PaneLayout, value: number) {
    changePane(key, value);
    void api!.setPaneLayout(paneLayoutRef.current).catch(() => notify('分栏宽度未能保存，请重试。'));
  }
  async function createDesktopNote(input?: import('./shared/documents').CreateNoteInput) {
    try { await api!.createNote(input); setState(await api!.getState()); }
    catch (error) { notify((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
  }
  async function createLinkedDesktopNote(taskId: string) {
    try { await api!.createLinkedNote(taskId); }
    finally { setState(await api!.getState()); }
  }
  async function changeZoom(action: ZoomAction) {
    try { setState(await api!.setZoom(action)); } catch { notify('无法保存缩放设置，请重试。'); }
  }
  async function dispatch(command: Command): Promise<boolean> {
    try { setState(await api!.command(command)); return true; }
    catch (error) { notify((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); return false; }
  }
  const lists = useMemo(() => state?.workspace.lists.filter(list => !list.values.deleted).sort((a, b) => a.values.createdAt.localeCompare(b.values.createdAt)) ?? [], [state]);
  const tasks = state?.workspace.tasks.filter(task => !task.values.deleted) ?? [];
  function matches(task: Task, target: View) {
    const value = task.values;
    if (target === 'day') return value.myDay === today;
    if (target === 'important') return value.important;
    if (target === 'planned') return Boolean(value.dueDate);
    if (target === 'all') return true;
    if (target === 'completed') return value.completed;
    if (target === 'inbox') return value.listId === 'inbox' || !lists.some(list => list.id === value.listId);
    return value.listId === target;
  }
  const search = query.trim().toLocaleLowerCase();
  const filtered = tasks.filter(task => search ? `${task.values.title}\n${task.values.notes}`.toLocaleLowerCase().includes(search) : matches(task, view)).sort((a, b) => {
    if (sort === 'title') return a.values.title.localeCompare(b.values.title, 'zh-CN');
    if (sort === 'important') return Number(b.values.important) - Number(a.values.important) || b.values.createdAt.localeCompare(a.values.createdAt);
    if (sort === 'due' || (!search && view === 'planned' && sort === 'created')) return (a.values.dueDate ?? '9999').localeCompare(b.values.dueDate ?? '9999') || b.values.createdAt.localeCompare(a.values.createdAt);
    return b.values.createdAt.localeCompare(a.values.createdAt);
  });
  const pending = filtered.filter(task => !task.values.completed);
  const completed = filtered.filter(task => task.values.completed);
  const selected = tasks.find(task => task.id === selectedId);
  const menuTask = tasks.find(task => task.id === taskMenu?.id);
  const inlineDetails = !!selected && !overlayDetails;
  const fittedPanes = fitPaneLayout(paneLayout, bodyWidth, inlineDetails);
  const sidebarMax = Math.max(paneLimits.sidebar.min, Math.min(paneLimits.sidebar.max, bodyWidth - minimumTaskWidth - dividerWidth * (inlineDetails ? 2 : 1) - (inlineDetails ? fittedPanes.details : 0)));
  const detailsMax = Math.max(paneLimits.details.min, Math.min(paneLimits.details.max, bodyWidth - minimumTaskWidth - dividerWidth * 2 - fittedPanes.sidebar));
  const customList = lists.find(list => list.id === view);
  const meta = smartViews.find(item => item.id === view) ?? { title: customList?.values.name ?? '任务', icon: List, color: customList?.values.color ?? 'blue' };
  const HeadingIcon = search ? Search : meta.icon;
  const available = tasks.filter(task => !task.values.completed && task.values.myDay !== today).sort((a, b) => Number(b.values.important) - Number(a.values.important) || (a.values.dueDate ?? '9999').localeCompare(b.values.dueDate ?? '9999')).slice(0, 6);
  function navigate(target: string) { setView(target); setQuery(''); setSelectedId(null); setSuggestions(false); setSidebarOpen(false); }
  function openListDialog(list: 'new' | TaskList) { setListDialog(list); setListName(list === 'new' ? '' : list.values.name); setListColor(list === 'new' ? 'purple' : list.values.color); }
  async function saveList(event: FormEvent) {
    event.preventDefault(); if (!listName.trim() || !listDialog) return;
    setListBusy(true);
    const ok = await dispatch(listDialog === 'new' ? { type: 'list.add', name: listName.trim(), color: listColor } : { type: 'list.update', id: listDialog.id, patch: { name: listName.trim(), color: listColor } });
    setListBusy(false); if (ok) setListDialog(null);
  }
  async function addTask(event: FormEvent) {
    event.preventDefault(); if (!newTitle.trim() || adding) return;
    setAdding(true);
    const ok = await dispatch({ type: 'task.add', title: newTitle.trim(), listId: customList?.id ?? 'inbox', myDay: view === 'day' ? today : null, important: view === 'important', dueDate: newDue || (view === 'planned' ? today : null) });
    setAdding(false);
    if (ok) { setNewTitle(''); setNewDue(''); if (search) setQuery(''); if (view === 'completed') navigate('inbox'); composerRef.current?.focus(); }
  }
  async function removeTask(task: Task) {
    if (await dispatch({ type: 'task.update', id: task.id, patch: { deleted: true } })) {
      setSelectedId(current => current === task.id ? null : current); notify('任务已删除', () => { void dispatch({ type: 'task.update', id: task.id, patch: { deleted: false } }); setToast(null); });
    }
  }
  function closeTaskMenu(restoreFocus = false) {
    const trigger = taskMenu && (taskButtons.current.get(taskMenu.id) ?? taskMenu.trigger);
    if (restoreFocus) (trigger?.isConnected ? trigger : composerRef.current)?.focus({ preventScroll: true });
    setTaskMenu(null);
  }
  function taskMenuAction(action: TaskMenuAction) {
    const task = menuTask;
    closeTaskMenu(true);
    if (!task) return;
    switch (action) {
      case 'complete': void dispatch({ type: 'task.update', id: task.id, patch: { completed: !task.values.completed } }); break;
      case 'day': void dispatch({ type: 'task.update', id: task.id, patch: { myDay: task.values.myDay === today ? null : today } }); break;
      case 'important': void dispatch({ type: 'task.update', id: task.id, patch: { important: !task.values.important } }); break;
      case 'details': setSelectedId(task.id); setSuggestions(false); break;
      case 'focus': if (!task.values.completed) openPomodoro(task); break;
      case 'delete': void removeTask(task); break;
    }
  }
  function taskRow(task: Task) {
    const v = task.values;
    const steps = state!.workspace.steps.filter(step => step.values.taskId === task.id && !step.values.deleted);
    const list = lists.find(list => list.id === v.listId);
    return <div className={`task-row ${v.completed ? 'completed-task' : ''} ${selectedId === task.id ? 'selected' : ''}`} key={task.id}
      onContextMenu={event => {
        event.preventDefault(); event.stopPropagation();
        setTaskMenu({ id: task.id, x: event.clientX, y: event.clientY, trigger: event.currentTarget.querySelector<HTMLElement>('.task-body') });
      }} onKeyDown={event => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        event.preventDefault(); event.stopPropagation();
        const bounds = event.currentTarget.getBoundingClientRect();
        setTaskMenu({ id: task.id, x: bounds.left + 16, y: bounds.bottom, trigger: event.currentTarget.querySelector<HTMLElement>('.task-body') });
      }}>
      <button className={`task-check ${v.completed ? 'checked' : ''}`} aria-label={`${v.completed ? '取消完成' : '完成'} ${v.title}`} onClick={() => void dispatch({ type: 'task.update', id: task.id, patch: { completed: !v.completed } })}>{v.completed && <Check size={15} />}</button>
      <button className="task-body" ref={button => { if (button) taskButtons.current.set(task.id, button); else taskButtons.current.delete(task.id); }} onClick={() => { setSelectedId(task.id); setSuggestions(false); }}><span className="task-title">{v.title}</span><span className="task-meta"><span>{list?.values.name ?? '任务'}</span>{v.myDay === today && view !== 'day' && <span><Sun size={12} />我的一天</span>}{v.dueDate && <span className={!v.completed && v.dueDate < today ? 'overdue' : ''}><CalendarDays size={12} />{prettyDate(v.dueDate)}{!v.completed && v.dueDate < today ? ' · 已逾期' : ''}</span>}{steps.length > 0 && <span><ListChecks size={13} />{steps.filter(step => step.values.completed).length}/{steps.length}</span>}{v.notes && <StickyNote size={12} />}{v.reminder && <Bell size={12} />}{v.repeat !== 'none' && <Repeat2 size={12} />}</span></button>
      <button className={`icon-button star-button ${v.important ? 'starred' : ''}`} aria-label={`${v.important ? '取消重要' : '标为重要'} ${v.title}`} onClick={() => void dispatch({ type: 'task.update', id: task.id, patch: { important: !v.important } })}><Star size={20} fill={v.important ? 'currentColor' : 'none'} /></button>
    </div>;
  }
  if (!state) return <div className="loading-app"><h1>GTodo</h1><p>{loadError || '加载中…'}</p>{api && loadError && <button className="button secondary" onClick={() => window.location.reload()}>重试</button>}</div>;
  return <div className="app-shell" data-navigation={compactNavigation ? 'drawer' : 'sidebar'} data-details-layout={overlayDetails ? 'drawer' : 'columns'}>
    <header className="titlebar">
      <div className="titlebar-left"><button className="mobile-nav-toggle icon-button" aria-label={sidebarOpen ? '收起清单导航' : '展开清单导航'} aria-expanded={sidebarOpen} aria-controls="list-navigation" onClick={() => { setSidebarOpen(!sidebarOpen); setSelectedId(null); }}><Menu size={18} /></button><span className="mini-mark"><Check size={13} strokeWidth={3} /></span><span className="titlebar-brand-text">GTodo</span></div>
      <div className="titlebar-right"><div className="titlebar-zoom"><button aria-label="缩小显示" title="缩小 (Ctrl −)" disabled={state.zoom <= zoomSteps[0]} onClick={() => void changeZoom('out')}><Minus size={13} /></button><button className="zoom-percentage" aria-label={`当前缩放 ${state.zoom}%，点击恢复 100%`} title="恢复 100% (Ctrl 0)" onClick={() => void changeZoom('reset')}>{state.zoom}%</button><button aria-label="放大显示" title="放大 (Ctrl +)" disabled={state.zoom >= zoomSteps.at(-1)!} onClick={() => void changeZoom('in')}><Plus size={13} /></button></div><button className="titlebar-settings icon-button" aria-label="打开设置" title="设置" onClick={() => setSettings(true)}><SettingsIcon size={15} /></button><div className="window-buttons"><button aria-label="最小化" onClick={() => api!.windowControl('minimize')}><Minus size={15} /></button><button aria-label="最大化或还原" onClick={() => api!.windowControl('maximize')}><Square size={12} /></button><button className="window-close" aria-label="关闭窗口" onClick={() => api!.windowControl('close')}><X size={17} /></button></div></div>
    </header>
    <div className="app-body" ref={bodyRef} style={{ '--sidebar-width': `${fittedPanes.sidebar}px`, '--details-width': `${fittedPanes.details}px` } as CSSProperties}>
      {compactNavigation && sidebarOpen && <button className="navigation-backdrop" aria-label="关闭清单导航遮罩" onClick={() => setSidebarOpen(false)} />}
      <aside id="list-navigation" className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`} inert={(compactNavigation && !sidebarOpen) || (overlayDetails && !!selected)}>
        <div className="search-box"><Search size={17} /><input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} aria-label="搜索任务" placeholder="搜索任务" />{query ? <button className="icon-button" aria-label="清除搜索" onClick={() => setQuery('')}><X size={14} /></button> : <kbd>Ctrl K</kbd>}</div>
        <nav className="smart-nav" aria-label="智能清单">{smartViews.map(item => <button key={item.id} className={`nav-item ${!search && view === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)}><item.icon size={20} className={`nav-icon color-${item.color}`} /><span>{item.title}</span><span className="nav-count">{tasks.filter(task => matches(task, item.id) && (item.id === 'completed' || !task.values.completed)).length || ''}</span></button>)}</nav>
        <div className="list-heading"><span>清单</span><button className="icon-button" aria-label="新建清单" onClick={() => openListDialog('new')}><Plus size={17} /></button></div>
        <nav className="custom-nav" aria-label="我的清单"><button className={`nav-item ${!search && view === 'inbox' ? 'active' : ''}`} onClick={() => navigate('inbox')}><List size={20} className="color-blue" /><span>任务</span><span className="nav-count">{tasks.filter(task => matches(task, 'inbox') && !task.values.completed).length || ''}</span></button>{lists.map(list => <button key={list.id} className={`nav-item ${!search && view === list.id ? 'active' : ''}`} onClick={() => navigate(list.id)}><List size={20} className={`color-${list.values.color}`} /><span>{list.values.name}</span><span className="nav-count">{tasks.filter(task => task.values.listId === list.id && !task.values.completed).length || ''}</span></button>)}<button className="new-list" onClick={() => openListDialog('new')}><Plus size={19} />新建清单</button></nav>
        <div className="sidebar-bottom"><PomodoroLauncher state={pomodoro.snapshot} open={() => openPomodoro()} /><button className="desktop-notes-button" onClick={() => { setNotesOpen(true); setSidebarOpen(false); }} title="Ctrl Shift N 新建便签"><StickyNote size={18} /><span>桌面便签</span><small>{state.workspace.notes.filter(note => !note.values.deleted).length || ''}</small></button>{state.folder.error && <div className="folder-status error-text" title={state.folder.error}><AlertCircle size={17} /><span>数据文件夹异常</span></div>}</div>
      </aside>
      {!compactNavigation && <PaneDivider label="调整清单栏宽度" controls="list-navigation" value={fittedPanes.sidebar} min={paneLimits.sidebar.min} max={sidebarMax} defaultValue={defaultPaneLayout.sidebar} onChange={value => changePane('sidebar', value)} onCommit={value => savePane('sidebar', value)} />}
      <main className={`main-panel theme-${meta.color} ${selected && !overlayDetails ? 'with-details' : ''}`} inert={(overlayDetails && !!selected) || (compactNavigation && sidebarOpen)}>
        <div className="main-scroll">
          <header className="page-header"><div className="hero-row"><div><div className="page-heading"><HeadingIcon size={24} strokeWidth={1.7} /><h1>{search ? '搜索结果' : meta.title}</h1></div>{(search || view === 'day') && <p className="page-subtitle">{search ? `${filtered.length} 个结果` : new Date(`${today}T12:00:00`).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</p>}</div><div className="header-actions">{view === 'day' && !search && <button className={`soft-button ${suggestions ? 'pressed' : ''}`} onClick={() => { setSuggestions(!suggestions); setSelectedId(null); }}><Lightbulb size={17} /><span>建议</span></button>}{customList && !search && <button className="soft-button" onClick={() => openListDialog(customList)} aria-label="编辑清单"><SlidersHorizontal size={17} /></button>}</div></div>
          {view === 'day' && !search && filtered.length > 0 && <p className="day-progress">已完成 {completed.length} / {filtered.length}</p>}
          </header>
          {state.notice && <div className="notice"><AlertCircle size={17} />{state.notice}</div>}
          {state.folder.notice && <div className="notice" role="status"><AlertCircle size={17} />{state.folder.notice}</div>}
          {state.folder.error && <div className="notice folder-notice" role="status"><AlertCircle size={17} /><span>{state.folder.error}</span><button className="text-button" onClick={() => setSettings(true)}>设置</button></div>}
          {suggestions && <section className="suggestions-panel"><div className="section-label"><span>添加到我的一天</span><button className="icon-button" aria-label="关闭建议" onClick={() => setSuggestions(false)}><X size={17} /></button></div>{available.length ? available.map(task => <div className="suggestion-row" key={task.id}><span>{task.values.title}{task.values.dueDate && <small>{prettyDate(task.values.dueDate)}</small>}</span><button className="text-button" onClick={() => void dispatch({ type: 'task.update', id: task.id, patch: { myDay: today } })}><Plus size={17} />添加</button></div>) : <p>暂无可添加的任务</p>}</section>}
          <div className="task-toolbar"><div><span>{view === 'completed' && !search ? '完成记录' : '待办事项'}</span><span className="pill">{view === 'completed' && !search ? completed.length : pending.length}</span></div><label className="sort-control"><ArrowDownWideNarrow size={16} /><select aria-label="任务排序" value={sort} onChange={event => setSort(event.target.value)}><option value="created">添加时间</option><option value="due">截止日期</option><option value="important">重要程度</option><option value="title">任务名称</option></select><ChevronDown size={12} /></label></div>
          <div className="task-list">{pending.map(taskRow)}</div>
          {filtered.length === 0 && <div className="empty-state"><h2>{search ? '未找到任务' : view === 'completed' ? '暂无已完成任务' : '暂无任务'}</h2>{!search && (view === 'important' || view === 'planned') && <p>{view === 'important' ? '已加星标的任务会显示在这里。' : '已设截止日期的任务会显示在这里。'}</p>}</div>}
          {completed.length > 0 && <section className="completed-section"><button className="completed-heading" onClick={() => setShowCompleted(!showCompleted)}>{showCompleted ? <ChevronDown size={15} /> : <ChevronRight size={15} />}已完成<span>{completed.length}</span></button>{showCompleted && <div className="task-list">{completed.map(taskRow)}</div>}</section>}
        </div>
        <div className="composer-wrap"><form className="composer" onSubmit={addTask}><Plus size={20} /><input ref={composerRef} aria-label="添加任务" placeholder="添加任务" title="Ctrl N 输入，Enter 添加" value={newTitle} maxLength={500} onChange={event => setNewTitle(event.target.value)} disabled={adding} /><label className={`quick-date ${newDue ? 'has-date' : ''}`} title="设置截止日期"><CalendarDays size={18} /><input type="date" aria-label="新任务截止日期" value={newDue} onChange={event => setNewDue(event.target.value)} /></label><button type="submit" className="add-task-button" disabled={!newTitle.trim() || adding}>{adding ? '添加中' : '添加'}</button></form></div>
      </main>
      {selected && overlayDetails && <button className="details-backdrop" aria-label="关闭任务详情遮罩" onClick={() => setSelectedId(null)} />}
      {inlineDetails && <PaneDivider label="调整任务详情宽度" controls="task-details" value={fittedPanes.details} min={paneLimits.details.min} max={detailsMax} defaultValue={defaultPaneLayout.details} direction={-1} onChange={value => changePane('details', value)} onCommit={value => savePane('details', value)} />}
      {selected && <TaskDetails key={selected.id} task={selected} lists={lists} steps={state.workspace.steps.filter(step => step.values.taskId === selected.id && !step.values.deleted)} dispatch={dispatch} close={() => setSelectedId(null)} remove={task => void removeTask(task)} overlay={overlayDetails} createLinkedNote={createLinkedDesktopNote} linkedNoteId={linkedNoteForTask(state.workspace, selected)?.id} focusTask={openPomodoro} />}
    </div>
    {settings && <Settings state={state} api={api!} close={() => setSettings(false)} update={setState} toast={notify} />}
    {notesOpen && <NotesGallery state={state} api={api!} close={() => setNotesOpen(false)} update={setState} toast={notify} />}
    {listDialog && <Modal title={listDialog === 'new' ? '新建清单' : '编辑清单'} close={() => setListDialog(null)} busy={listBusy}><form className="list-form" onSubmit={saveList}><label>清单名称<input autoFocus required maxLength={500} placeholder="例如：工作计划、生活小事" value={listName} onChange={event => setListName(event.target.value)} /></label><label>清单颜色</label><div className="color-picker">{colors.map(color => <button key={color} type="button" className={`color-swatch bg-${color} ${listColor === color ? 'chosen' : ''}`} aria-label={colorNames[color]} aria-pressed={listColor === color} onClick={() => setListColor(color)}>{listColor === color && <Check size={17} />}</button>)}</div>{listDialog !== 'new' && <div className="delete-list-note"><p>删除清单后，其中的任务会移入“任务”。</p><button type="button" className="text-button danger-text" disabled={listBusy} onClick={async () => { setListBusy(true); const ok = await dispatch({ type: 'list.update', id: listDialog.id, patch: { deleted: true } }); setListBusy(false); if (ok) { setListDialog(null); navigate('inbox'); notify('清单已删除，任务已保留'); } }}><Trash2 size={15} />删除清单</button></div>}<div className="form-footer"><button type="button" className="button secondary" disabled={listBusy} onClick={() => setListDialog(null)}>取消</button><button className="button primary" disabled={!listName.trim() || listBusy}>{listBusy ? '正在保存…' : '保存清单'}</button></div></form></Modal>}
    {taskMenu && menuTask && <TaskContextMenu key={taskMenu.id} x={taskMenu.x} y={taskMenu.y} task={menuTask} today={today} close={closeTaskMenu} action={taskMenuAction} />}
    {toast && <div className="toast" role="status"><Check size={17} /><span>{toast.text}</span>{toast.undo && <button onClick={toast.undo}>撤销</button>}<button aria-label="关闭提示" onClick={() => setToast(null)}><X size={15} /></button></div>}
  </div>;
}
