import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { X, Star, Sun, CalendarDays, Bell, Repeat2, List, Trash2, Plus, Check, StickyNote, Timer, Link2 } from 'lucide-react';
import { localDate, type Command, type Step, type Task, type TaskList, type TaskValues } from '../shared/model';
import type { DocumentFormat } from '../shared/documents';
import { FieldDraft, flushMainDrafts, registerMainDraft } from '../notes/draft';
import DocumentEditor from './DocumentEditor';
import Modal from './Modal';
import { isComposing } from './keyboard';
import TaskStep from './TaskStep';

export default function TaskDetails({ task, lists, steps, dispatch, close, remove, overlay = false, createLinkedNote, linkedNoteId, focusTask, toast }: { task: Task; lists: TaskList[]; steps: Step[]; dispatch: (command: Command) => Promise<boolean>; close: () => void; remove: (task: Task) => void; overlay?: boolean; createLinkedNote?: (taskId: string) => Promise<void>; linkedNoteId?: string; focusTask?: (task: Task) => void; toast: (text: string, undo?: () => void) => void }) {
  const v = task.values;
  const [noteDraft] = useState(() => new FieldDraft<{ title: string; content: string; format: DocumentFormat }>({ title: v.title, content: v.notes, format: v.notesFormat }, async patch => {
    const taskPatch: Partial<TaskValues> = {};
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw new Error('任务名称不能为空。');
      taskPatch.title = patch.title.trim();
    }
    if (patch.content !== undefined) taskPatch.notes = patch.content;
    if (patch.format !== undefined) taskPatch.notesFormat = patch.format;
    if (!await dispatch({ type: 'task.update', id: task.id, patch: taskPatch })) throw new Error('任务修改未能保存，请重试。');
    const saved = (await window.gtodo!.getState()).workspace.tasks.find(item => item.id === task.id);
    if (!saved) throw new Error('无法读取备注的保存结果，请重试。');
    return { title: saved.values.title, content: saved.values.notes, format: saved.values.notesFormat };
  }));
  const noteSnapshot = useSyncExternalStore(noteDraft.subscribe, noteDraft.getSnapshot);
  const notes = noteSnapshot.values.content;
  const [newStep, setNewStep] = useState('');
  const [stepAdding, setStepAdding] = useState(false);
  const stepInput = useRef<HTMLInputElement>(null);
  const [linking, setLinking] = useState(false);
  const [confirmLink, setConfirmLink] = useState(false);
  const [linkError, setLinkError] = useState('');
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!overlay) return;
    const previous = document.activeElement as HTMLElement;
    if (!panel.current?.contains(previous)) closeButton.current?.focus();
    return () => { if (!panel.current?.isConnected && previous?.isConnected) previous.focus(); };
  }, [overlay]);
  useEffect(() => noteDraft.receive({ title: v.title, content: v.notes, format: v.notesFormat }), [noteDraft, v.title, v.notes, v.notesFormat]);
  useEffect(() => registerMainDraft(noteDraft), [noteDraft]);
  useEffect(() => () => { void noteDraft.flush().catch(() => {}); noteDraft.dispose(); }, [noteDraft]);
  const update = (patch: Partial<TaskValues>) => dispatch({ type: 'task.update', id: task.id, patch });
  async function openLinkedNote(create: boolean) {
    setLinking(true); setLinkError('');
    try {
      await noteDraft.flush();
      if (create) { await createLinkedNote!(task.id); setConfirmLink(false); }
      else if (linkedNoteId) await window.gtodo!.noteWindow({ type: 'open', id: linkedNoteId });
    } catch (error) { setLinkError((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    finally { setLinking(false); }
  }
  async function addStep(event: FormEvent) {
    event.preventDefault(); if (!newStep.trim() || stepAdding) return;
    setStepAdding(true);
    if (await dispatch({ type: 'step.add', taskId: task.id, title: newStep.trim() })) setNewStep('');
    setStepAdding(false);
    window.requestAnimationFrame(() => stepInput.current?.focus());
  }
  const reminderLocal = v.reminder ? `${localDate(new Date(v.reminder))}T${String(new Date(v.reminder).getHours()).padStart(2, '0')}:${String(new Date(v.reminder).getMinutes()).padStart(2, '0')}` : '';
  return <aside id="task-details" ref={panel} className={`details ${overlay ? 'details-overlay' : ''}`} aria-label="任务详情" role={overlay ? 'dialog' : undefined} aria-modal={overlay || undefined} onKeyDown={event => {
    if (isComposing(event.nativeEvent)) { if (event.key === 'Enter') event.preventDefault(); event.stopPropagation(); return; }
    if (confirmLink) { event.stopPropagation(); return; }
    if (event.ctrlKey && event.key.toLowerCase() === 's') { event.preventDefault(); void flushMainDrafts().catch(() => {}); }
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
    if (!overlay || event.key !== 'Tab') return;
    const focusable = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]') ?? [])];
    const first = focusable[0]; const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <div className="details-top"><span>任务详情</span><button ref={closeButton} className="icon-button" aria-label="关闭任务详情" onClick={close}><X size={18} /></button></div>
    <div className="details-scroll">
      <div className="detail-card title-card"><div className="detail-title-row"><button className={`task-check ${v.completed ? 'checked' : ''}`} aria-label={v.completed ? '标记为未完成' : '完成任务'} onClick={() => void update({ completed: !v.completed })}>{v.completed && <Check size={15} />}</button><textarea aria-label="任务名称" rows={2} maxLength={500} value={noteSnapshot.values.title} onChange={event => noteDraft.change('title', event.target.value)} onBlur={() => void noteDraft.flush().catch(() => {})} onKeyDown={event => { if (event.key === 'Enter' && !isComposing(event.nativeEvent)) { event.preventDefault(); void noteDraft.flush().catch(() => {}); } }} /><button className={`icon-button star-button ${v.important ? 'starred' : ''}`} aria-label={v.important ? '取消重要标记' : '标为重要'} onClick={() => void update({ important: !v.important })}><Star size={20} fill={v.important ? 'currentColor' : 'none'} /></button></div>
      {noteSnapshot.error && <div className="document-error" role="alert">{noteSnapshot.error}<button className="text-button" onClick={() => void noteDraft.flush().catch(() => {})}>重试保存</button></div>}
      {steps.map(step => <TaskStep key={step.id} step={step} dispatch={dispatch} toast={toast} />)}
      <form className="step-form" onSubmit={addStep}><Plus size={17} /><input ref={stepInput} aria-label="添加步骤" placeholder="添加步骤" disabled={stepAdding} value={newStep} maxLength={500} onChange={event => setNewStep(event.target.value)} /><button className="text-button" disabled={!newStep.trim() || stepAdding}>{stepAdding ? '添加中' : '添加'}</button></form></div>
      <button className={`detail-card day-toggle ${v.myDay === localDate() ? 'is-active' : ''}`} aria-pressed={v.myDay === localDate()} onClick={() => void update({ myDay: v.myDay === localDate() ? null : localDate() })}><Sun size={19} /><span>{v.myDay === localDate() ? '移出“我的一天”' : '添加到“我的一天”'}</span>{v.myDay === localDate() && <Check size={16} />}</button>
      {focusTask && !v.completed && <button className="detail-card focus-task-button" onClick={() => focusTask(task)}><Timer size={18} />专注此任务</button>}
      <div className="detail-card details-fields">
        <label><span><CalendarDays size={18} />截止日期</span><input aria-label="截止日期" type="date" value={v.dueDate ?? ''} onChange={event => void update({ dueDate: event.target.value || null })} /></label>
        <label><span><Bell size={18} />提醒我</span><input aria-label="提醒时间" type="datetime-local" value={reminderLocal} onChange={event => { const date = event.target.value ? new Date(event.target.value) : null; if (!date || !isNaN(date.valueOf())) void update({ reminder: date?.toISOString() ?? null }); }} /></label>
        <label><span><Repeat2 size={18} />重复</span><select aria-label="重复频率" value={v.repeat} onChange={event => void update({ repeat: event.target.value as TaskValues['repeat'] })}><option value="none">不重复</option><option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option></select></label>
        <label><span><List size={18} />所在清单</span><select aria-label="所在清单" value={lists.some(list => list.id === v.listId) ? v.listId : 'inbox'} onChange={event => void update({ listId: event.target.value })}><option value="inbox">任务</option>{lists.map(list => <option key={list.id} value={list.id}>{list.values.name}</option>)}</select></label>
      </div>
      {v.repeat !== 'none' && <p className="detail-hint">完成后创建下一次任务。</p>}
      {v.reminder && <p className="detail-hint">提醒需保持应用运行。</p>}
      <div className="detail-card note-card"><label><StickyNote size={17} />备注</label>
        <DocumentEditor target={{ kind: 'task', id: task.id }} label="备注" value={notes} format={noteSnapshot.values.format} assets={v.notesAssets} onChange={value => noteDraft.change('content', value)}
          onFormatChange={async format => { noteDraft.change('format', format); await noteDraft.flush(); }} onSave={() => noteDraft.flush()} />
        <div className={`document-save-status ${noteSnapshot.error ? 'is-error' : ''}`} role="status">{noteSnapshot.error || (noteSnapshot.dirty || noteSnapshot.saving ? '正在保存…' : '已保存')}{noteSnapshot.error && <button onClick={() => void noteDraft.flush().catch(() => {})}>重试</button>}</div>
      </div>
      {createLinkedNote && <button className="detail-card linked-note-button" disabled={linking} onClick={() => {
        if (linkedNoteId) void openLinkedNote(false); else { setLinkError(''); setConfirmLink(true); }
      }}>{linkedNoteId ? <Link2 size={18} /> : <StickyNote size={18} />}{linking ? '正在打开…' : linkedNoteId ? '打开关联便签' : '创建关联便签'}</button>}
      {linkError && !confirmLink && <p className="document-error" role="alert">{linkError}</p>}
    </div>
    <footer className="details-footer"><span>创建于 {new Date(v.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}</span><button className="icon-button danger-text" aria-label="删除任务" onClick={() => remove(task)}><Trash2 size={18} /></button></footer>
    {confirmLink && <Modal title="创建关联便签" close={() => setConfirmLink(false)} busy={linking}>
      <div className="linked-note-confirm"><p>备注与便签的内容、格式和图片双向同步。删除任意一方会解除关联，另一方保留内容。</p>
        {linkError && <p className="document-error" role="alert">{linkError}</p>}
        <div className="form-footer"><button className="button secondary" disabled={linking} onClick={() => setConfirmLink(false)}>取消</button><button className="button primary" disabled={linking} onClick={() => void openLinkedNote(true)}>{linking ? '正在创建…' : '确认创建'}</button></div>
      </div>
    </Modal>}
  </aside>;
}
