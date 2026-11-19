import { useEffect, useRef, useState, type FormEvent } from 'react';
import { X, Star, Sun, CalendarDays, Bell, Repeat2, List, Trash2, Plus, Check, Circle, StickyNote, Timer } from 'lucide-react';
import { localDate, type Command, type Step, type Task, type TaskList, type TaskValues } from '../shared/model';

export default function TaskDetails({ task, lists, steps, dispatch, close, remove, overlay = false, createNote, focusTask }: { task: Task; lists: TaskList[]; steps: Step[]; dispatch: (command: Command) => Promise<boolean>; close: () => void; remove: (task: Task) => void; overlay?: boolean; createNote?: (input: { title: string; content: string }) => Promise<void>; focusTask?: (task: Task) => void }) {
  const v = task.values;
  const [title, setTitle] = useState(v.title);
  const [notes, setNotes] = useState(v.notes);
  const [newStep, setNewStep] = useState('');
  const [copying, setCopying] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!overlay) return;
    const previous = document.activeElement as HTMLElement;
    if (!panel.current?.contains(previous)) closeButton.current?.focus();
    return () => { if (!panel.current?.isConnected && previous?.isConnected) previous.focus(); };
  }, [overlay]);
  useEffect(() => setTitle(v.title), [task.id, v.title]);
  useEffect(() => setNotes(v.notes), [task.id, v.notes]);
  const update = (patch: Partial<TaskValues>) => dispatch({ type: 'task.update', id: task.id, patch });
  async function addStep(event: FormEvent) { event.preventDefault(); if (newStep.trim() && await dispatch({ type: 'step.add', taskId: task.id, title: newStep.trim() })) setNewStep(''); }
  const reminderLocal = v.reminder ? `${localDate(new Date(v.reminder))}T${String(new Date(v.reminder).getHours()).padStart(2, '0')}:${String(new Date(v.reminder).getMinutes()).padStart(2, '0')}` : '';
  return <aside ref={panel} className={`details ${overlay ? 'details-overlay' : ''}`} aria-label="任务详情" role={overlay ? 'dialog' : undefined} aria-modal={overlay || undefined} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
    if (!overlay || event.key !== 'Tab') return;
    const focusable = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, select') ?? [])];
    const first = focusable[0]; const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <div className="details-top"><span>任务详情</span><button ref={closeButton} className="icon-button" aria-label="关闭任务详情" onClick={close}><X size={18} /></button></div>
    <div className="details-scroll">
      <div className="detail-card title-card"><div className="detail-title-row"><button className={`task-check ${v.completed ? 'checked' : ''}`} aria-label={v.completed ? '标记为未完成' : '完成任务'} onClick={() => void update({ completed: !v.completed })}>{v.completed && <Check size={15} />}</button><textarea aria-label="任务名称" rows={2} maxLength={500} value={title} onChange={event => setTitle(event.target.value)} onBlur={() => { if (title.trim()) void update({ title: title.trim() }); else setTitle(v.title); }} /><button className={`icon-button star-button ${v.important ? 'starred' : ''}`} aria-label={v.important ? '取消重要标记' : '标为重要'} onClick={() => void update({ important: !v.important })}><Star size={20} fill={v.important ? 'currentColor' : 'none'} /></button></div>
      {steps.map(step => <div className="step-row" key={step.id}><button className={`step-check ${step.values.completed ? 'checked' : ''}`} aria-label={`${step.values.completed ? '取消完成' : '完成步骤'} ${step.values.title}`} onClick={() => void dispatch({ type: 'step.update', id: step.id, patch: { completed: !step.values.completed } })}>{step.values.completed ? <Check size={13} /> : <Circle size={16} />}</button><span className={step.values.completed ? 'strikethrough' : ''}>{step.values.title}</span><button className="icon-button" aria-label={`删除步骤 ${step.values.title}`} onClick={() => void dispatch({ type: 'step.update', id: step.id, patch: { deleted: true } })}><X size={14} /></button></div>)}
      <form className="step-form" onSubmit={addStep}><Plus size={17} /><input aria-label="添加步骤" placeholder="添加步骤" value={newStep} maxLength={500} onChange={event => setNewStep(event.target.value)} /><button className="text-button" disabled={!newStep.trim()}>添加</button></form></div>
      <button className={`detail-card day-toggle ${v.myDay === localDate() ? 'is-active' : ''}`} onClick={() => void update({ myDay: v.myDay === localDate() ? null : localDate() })}><Sun size={19} /><span>{v.myDay === localDate() ? '已添加到“我的一天”' : '添加到“我的一天”'}</span>{v.myDay === localDate() && <Check size={16} />}</button>
      {focusTask && !v.completed && <button className="detail-card focus-task-button" onClick={() => focusTask(task)}><Timer size={18} />专注此任务</button>}
      <div className="detail-card details-fields">
        <label><span><CalendarDays size={18} />截止日期</span><input aria-label="截止日期" type="date" value={v.dueDate ?? ''} onChange={event => void update({ dueDate: event.target.value || null })} /></label>
        <label><span><Bell size={18} />提醒我</span><input aria-label="提醒时间" type="datetime-local" value={reminderLocal} onChange={event => { const date = event.target.value ? new Date(event.target.value) : null; if (!date || !isNaN(date.valueOf())) void update({ reminder: date?.toISOString() ?? null }); }} /></label>
        <label><span><Repeat2 size={18} />重复</span><select aria-label="重复频率" value={v.repeat} onChange={event => void update({ repeat: event.target.value as TaskValues['repeat'] })}><option value="none">不重复</option><option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option></select></label>
        <label><span><List size={18} />所在清单</span><select aria-label="所在清单" value={lists.some(list => list.id === v.listId) ? v.listId : 'inbox'} onChange={event => void update({ listId: event.target.value })}><option value="inbox">任务</option>{lists.map(list => <option key={list.id} value={list.id}>{list.values.name}</option>)}</select></label>
      </div>
      {v.repeat !== 'none' && <p className="detail-hint">完成后创建下一次任务。</p>}
      {v.reminder && <p className="detail-hint">提醒需保持应用运行。</p>}
      <div className="detail-card note-card"><label htmlFor="notes"><StickyNote size={17} />备注</label><textarea id="notes" placeholder="添加备注" maxLength={100000} value={notes} rows={6} onChange={event => setNotes(event.target.value)} onBlur={() => { if (notes !== v.notes) void update({ notes }); }} /></div>
      {createNote && <button className="detail-card copy-to-note" disabled={copying} onClick={async () => {
        setCopying(true);
        try { await createNote({ title: (title.trim() || v.title).slice(0, 200), content: [v.dueDate ? `截止日期：${v.dueDate}` : '', steps.map(step => `${step.values.completed ? '☑' : '☐'} ${step.values.title}`).join('\n'), notes].filter(Boolean).join('\n\n').slice(0, 100000) }); }
        finally { setCopying(false); }
      }}><StickyNote size={18} />{copying ? '正在创建…' : '复制为桌面便签'}</button>}
    </div>
    <footer className="details-footer"><span>创建于 {new Date(v.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}</span><button className="icon-button danger-text" aria-label="删除任务" onClick={() => remove(task)}><Trash2 size={18} /></button></footer>
  </aside>;
}
