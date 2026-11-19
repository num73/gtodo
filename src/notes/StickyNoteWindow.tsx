import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowUpRight, Check, Ellipsis, Link2, LoaderCircle, Pin, PinOff, Plus, RotateCcw, StickyNote, Trash2, X } from 'lucide-react';
import { noteColors, type AppState, type DesktopAPI, type Note } from '../shared/model';
import { NoteDraft } from './draft';
import DocumentEditor from '../components/DocumentEditor';
import { linkedTaskForNote } from '../shared/note-links';

export const noteColorNames = { yellow: '黄色', purple: '紫色', blue: '蓝色', green: '绿色', rose: '粉色' };
export default function StickyNoteWindow({ id }: { id: string }) {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState('');
  const api = window.gtodo;
  useEffect(() => {
    if (!api) { setError('请在 GTodo 桌面应用中打开便签。'); return; }
    let active = true;
    const remove = api.onState(value => { if (active) setState(value); });
    api.getState().then(value => { if (active) setState(value); }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; remove(); };
  }, [api]);
  const note = state?.workspace.notes.find(note => note.id === id);
  if (!note || !state || !api) return <div className="sticky-loading"><StickyNote size={26} /><p>{error || '正在打开便签…'}</p></div>;
  return <NoteEditor key={id} note={note} state={state} api={api} />;
}

export function NoteEditor({ note, state, api }: { note: Note; state: AppState; api: DesktopAPI }) {
  const [draft] = useState(() => new NoteDraft(note.values, async patch => {
    const next = await api.command({ type: 'note.update', id: note.id, patch });
    const saved = next.workspace.notes.find(item => item.id === note.id);
    if (!saved) throw new Error('便签未能保存，请重试。');
    return saved.values;
  }));
  const snapshot = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const toolsButton = useRef<HTMLButtonElement>(null);
  const pinned = state.noteWindows[note.id]?.pinned ?? false;
  const linkedTask = linkedTaskForNote(state.workspace, note);
  useEffect(() => { draft.receive(note.values); }, [draft, note.values]);
  useEffect(() => () => draft.dispose(), [draft]);
  useEffect(() => {
    if (!toolsOpen) { setConfirmDelete(false); return; }
    toolsRef.current?.querySelector<HTMLElement>('button, select')?.focus();
    const dismiss = (event: PointerEvent) => { if (!toolsRef.current?.contains(event.target as Node) && !toolsButton.current?.contains(event.target as Node)) setToolsOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [toolsOpen]);
  useEffect(() => api.onNoteFlush(requestId => {
    void draft.flush().then(() => api.noteFlushed(requestId, true), () => api.noteFlushed(requestId, false)).catch(() => {});
  }), [api, draft]);
  async function execute(action: () => Promise<unknown>, flush = false) {
    setBusy(true); setError('');
    try { if (flush) await draft.flush(); await action(); }
    catch (error) { setError((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    finally { setBusy(false); }
  }
  return <main className={`sticky-sheet sticky-${snapshot.values.color}`} aria-label="桌面便签" onKeyDown={event => {
    if (event.ctrlKey && event.key.toLowerCase() === 's') { event.preventDefault(); void execute(() => draft.flush()); }
    if (event.key === 'Escape') { setConfirmDelete(false); setToolsOpen(false); toolsButton.current?.focus(); }
  }}>
    <header className="sticky-dragbar" title="拖动以移动便签">
      <span className="sticky-window-label" title="拖动此处移动便签"><StickyNote size={14} /></span>
      <div className="sticky-window-controls">
        <button ref={toolsButton} aria-label="便签编辑选项" title="编辑选项" aria-expanded={toolsOpen} aria-controls="sticky-edit-options" onClick={() => setToolsOpen(!toolsOpen)}><Ellipsis size={18} /></button>
        <button aria-label={pinned ? '取消便签置顶' : '便签置顶'} aria-pressed={pinned} title={pinned ? '取消置顶' : '始终显示在其他窗口上方'} disabled={busy} className={pinned ? 'is-pinned' : ''} onClick={() => void execute(() => api.noteWindow({ type: 'pin', id: note.id, pinned: !pinned }))}>{pinned ? <PinOff size={16} /> : <Pin size={16} />}</button>
        <button aria-label="收起便签" title="收起便签，内容保留" disabled={busy} onClick={() => void execute(() => api.noteWindow({ type: 'hide', id: note.id }))}><X size={19} /></button>
      </div>
    </header>
    {toolsOpen && <div id="sticky-edit-options" ref={toolsRef} className="sticky-tools-popover" role="dialog" aria-label="便签编辑选项">
      <div className="sticky-palette" aria-label="便签颜色">{noteColors.map(color => <button key={color} aria-label={`${noteColorNames[color]}便签`} title={noteColorNames[color]} aria-pressed={snapshot.values.color === color} className={`sticky-color sticky-${color}`} disabled={note.values.deleted} onClick={() => draft.change('color', color)}>{snapshot.values.color === color && <Check size={12} />}</button>)}</div>
      <div ref={setToolbarTarget} />
      <div className="sticky-menu-actions">
        <button disabled={busy} onClick={() => void execute(async () => { await api.createNote(); setToolsOpen(false); })}><Plus size={15} />新建便签</button>
        <button onClick={() => void execute(async () => { await api.showMain(); setToolsOpen(false); })}><ArrowUpRight size={15} />打开 GTodo</button>
        <button disabled={busy || note.values.deleted} onClick={() => setConfirmDelete(true)}><Trash2 size={15} />删除便签</button>
      </div>
      {confirmDelete && <div className="sticky-delete-confirm"><span>{linkedTask ? '删除便签并解除关联？任务备注将保留。' : '删除这张便签？'}</span><button disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button><button className="danger-text" disabled={busy} onClick={() => void execute(() => api.deleteNote(note.id))}>删除</button></div>}
    </div>}
    {note.values.deleted && <div className="sticky-message" role="status"><span>这张便签已被删除，当前文字仍保留。</span><button onClick={() => void execute(() => api.command({ type: 'note.update', id: note.id, patch: { deleted: false } }))}>恢复便签</button></div>}
    <input className="sticky-title" aria-label="便签标题" placeholder="便签标题" maxLength={200} value={snapshot.values.title} disabled={note.values.deleted} onChange={event => draft.change('title', event.target.value)} onBlur={() => void draft.flush().catch(() => {})} />
    <DocumentEditor target={{ kind: 'note', id: note.id }} label="便签内容" value={snapshot.values.content} format={snapshot.values.format} assets={note.values.assets} sticky disabled={note.values.deleted}
      collapsedToolbar toolbarTarget={toolsOpen ? toolbarTarget : null} onToolbarAction={() => setToolsOpen(false)}
      onChange={value => draft.change('content', value)} onFormatChange={async format => { draft.change('format', format); await draft.flush(); }} onSave={() => draft.flush()} />
    {(error || snapshot.error) && <div className="sticky-message sticky-error" role="alert"><span>{error || snapshot.error}</span><button disabled={busy} onClick={() => void execute(() => draft.flush())}><RotateCcw size={13} />重试保存</button></div>}
    {state.folder.error && <div className="sticky-folder-warning">已保存在本机；数据文件夹暂不可用。</div>}
    {state.folder.notice && <div className="sticky-folder-warning">{state.folder.notice}</div>}
    <footer className="sticky-footer"><span className="sticky-save-status" role="status">{snapshot.saving ? <LoaderCircle size={12} className="spin" /> : <Check size={12} />}{snapshot.error ? '保存失败，内容仍保留' : snapshot.dirty ? '正在保存…' : '已保存'}</span>{linkedTask && <span className="sticky-link-status" title={`关联任务：${linkedTask.values.title}`}><Link2 size={12} />关联备注</span>}</footer>
  </main>;
}
