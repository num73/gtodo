import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Check, Circle, X } from 'lucide-react';
import type { Command, Step } from '../shared/model';
import { FieldDraft, registerMainDraft } from '../notes/draft';
import { isComposing } from './keyboard';

export default function TaskStep({ step, dispatch, toast }: {
  step: Step; dispatch: (command: Command) => Promise<boolean>; toast: (text: string, undo?: () => void) => void;
}) {
  const [editing, setEditing] = useState(false);
  const titleButton = useRef<HTMLButtonElement>(null);
  const [draft] = useState(() => new FieldDraft({ title: step.values.title }, async patch => {
    const title = patch.title!.trim();
    if (!title) throw new Error('步骤名称不能为空。');
    if (!await dispatch({ type: 'step.update', id: step.id, patch: { title } })) throw new Error('步骤未能保存，请重试。');
    return { title };
  }));
  const snapshot = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
  useEffect(() => draft.receive({ title: step.values.title }), [draft, step.values.title]);
  useEffect(() => registerMainDraft(draft), [draft]);
  useEffect(() => () => draft.dispose(), [draft]);
  async function finish(restoreFocus = false) {
    try {
      await draft.flush(); setEditing(false);
      if (restoreFocus) window.requestAnimationFrame(() => titleButton.current?.focus());
    } catch {}
  }
  async function remove() {
    try { await draft.flush(); } catch { return; }
    if (await dispatch({ type: 'step.update', id: step.id, patch: { deleted: true } })) toast('步骤已删除', () => {
      void dispatch({ type: 'step.update', id: step.id, patch: { deleted: false } }).then(ok => { if (ok) toast('步骤已恢复'); });
    });
  }
  return <div>
    <div className="step-row">
      <button className={`step-check ${step.values.completed ? 'checked' : ''}`} aria-label={`${step.values.completed ? '取消完成' : '完成步骤'} ${step.values.title}`} onClick={() => void dispatch({ type: 'step.update', id: step.id, patch: { completed: !step.values.completed } })}>{step.values.completed ? <Check size={13} /> : <Circle size={16} />}</button>
      {editing ? <input autoFocus className="step-title-input" aria-label="步骤名称" maxLength={500} value={snapshot.values.title} onChange={event => draft.change('title', event.target.value)} onBlur={() => void finish()} onKeyDown={event => {
        if (isComposing(event.nativeEvent)) return;
        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void finish(true); }
        if (event.key === 'Escape') { event.stopPropagation(); draft.change('title', step.values.title); void finish(true); }
      }} /> : <button ref={titleButton} className={`step-title ${step.values.completed ? 'strikethrough' : ''}`} aria-label={`编辑步骤 ${step.values.title}`} title="点击编辑步骤" onClick={() => setEditing(true)}>{snapshot.values.title}</button>}
      <button className="icon-button" aria-label={`删除步骤 ${step.values.title}`} onClick={() => void remove()}><X size={14} /></button>
    </div>
    {snapshot.error && <p className="document-error" role="alert">{snapshot.error}<button className="text-button" onClick={() => void finish()}>重试</button></p>}
  </div>;
}
