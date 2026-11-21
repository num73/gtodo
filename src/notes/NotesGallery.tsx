import { useState } from 'react';
import { Plus, Pin, Trash2, ArrowUpRight, EyeOff, BookOpen, Link2, FileInput } from 'lucide-react';
import type { AppState, DesktopAPI } from '../shared/model';
import Modal from '../components/Modal';
import { isDesktopNote, isNotebookNote } from '../shared/notebook';

export default function NotesGallery({ state, api, close, update, toast }: {
  state: AppState; api: DesktopAPI; close: () => void; update: (state: AppState) => void; toast: (text: string, undo?: () => void) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const notes = state.workspace.notes.filter(isDesktopNote).sort((a, b) => b.values.createdAt.localeCompare(a.values.createdAt));
  async function execute(action: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await action(); } catch (error) { setError((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); } finally { setBusy(false); }
  }
  return <Modal title="桌面便签" close={close} wide busy={busy}>
    <div className="notes-gallery">
      <div className="notes-gallery-intro"><span>{notes.length} 张便签</span><button className="button primary" disabled={busy} onClick={() => void execute(async () => { await api.createNote(); update(await api.getState()); })}><Plus size={17} />新建便签</button></div>
      {notes.length === 0 ? <div className="notes-empty">暂无便签</div> : <div className="notes-grid">{notes.map(note => {
        const opened = state.noteWindows[note.id]?.open;
        const title = note.values.title || '未命名便签';
        const notebookAction = isNotebookNote(note) ? '打开关联笔记' : '加入笔记并关联';
        return <article key={note.id} className={`note-preview sticky-${note.values.color}`}>
          <button className="note-preview-body" aria-label={`打开便签 ${note.values.title || '未命名便签'}`} disabled={busy} onClick={() => void execute(() => api.noteWindow({ type: 'open', id: note.id }))}><h4>{note.values.title.trim() || '未命名便签'}</h4><p>{note.values.content || '无内容'}</p></button>
          <footer><span>{state.noteWindows[note.id]?.pinned && <Pin size={12} />}{opened ? '已贴到桌面' : '已收起'}</span>
            <div className="note-preview-actions" role="group" aria-label={`便签操作 ${title}`}>
              <button aria-label={`${notebookAction} ${title}`} title={notebookAction} disabled={busy} onClick={() => void execute(async () => { if (!isNotebookNote(note)) update(await api.command({ type: 'note.notebook', id: note.id, mode: 'link' })); await api.showNotebook(note.id); close(); })}>{isNotebookNote(note) ? <BookOpen size={16} /> : <Link2 size={16} />}</button>
              <button aria-label={`转为笔记 ${title}`} title="转为笔记" disabled={busy} onClick={() => void execute(async () => { update(await api.command({ type: 'note.notebook', id: note.id, mode: 'convert' })); await api.showNotebook(note.id); close(); })}><FileInput size={16} /></button>
              <button aria-label={`${opened ? '收起' : '显示'}便签 ${title}`} title={opened ? '收起便签' : '显示便签'} disabled={busy} onClick={() => void execute(() => api.noteWindow({ type: opened ? 'hide' : 'open', id: note.id }))}>{opened ? <EyeOff size={16} /> : <ArrowUpRight size={17} />}</button>
              <button aria-label={`删除便签 ${title}`} title="删除便签" disabled={busy} onClick={() => void execute(async () => { update(await api.deleteNote(note.id)); toast('便签已删除', () => { void execute(async () => { update(await api.command({ type: 'note.desktop', id: note.id })); toast('便签已恢复'); }); }); })}><Trash2 size={15} /></button>
            </div>
          </footer>
        </article>;
      })}</div>}
      <p className="notes-gallery-hint">收起不删除内容。{state.preferences.restoreNotes ? '未收起的便签会在下次启动时恢复。' : '已关闭启动时恢复便签，可在设置中开启。'}</p>
      {error && <div className="notes-gallery-error" role="alert">{error}</div>}
    </div>
  </Modal>;
}
