import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BookOpen, FilePlus2, FolderPlus, Folder, FileText, Search, ArrowLeft, StickyNote, Trash2, Pencil, Link2 } from 'lucide-react';
import type { AppState, DesktopAPI, Note, NoteFolder } from '../shared/model';
import { folderParent, isDesktopNote, isNotebookNote, noteFolder } from '../shared/notebook';
import { FieldDraft, flushMainDrafts, registerMainDraft } from '../notes/draft';
import DocumentEditor from '../components/DocumentEditor';
import Modal from '../components/Modal';
import ContextMenu from '../components/ContextMenu';

type Props = { state: AppState; api: DesktopAPI; update: (state: AppState) => void; toast: (text: string, undo?: () => void) => void; requestedId?: string; requestNonce?: string };
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
export default function Notebook({ state, api, update, toast, requestedId, requestNonce }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(requestedId ?? null);
  const [folder, setFolder] = useState<string | null>('all');
  const [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [folderDialog, setFolderDialog] = useState<{ item?: NoteFolder; parentId: string | null; confirmDelete?: boolean } | null>(null);
  const [deleting, setDeleting] = useState<Note | null>(null), [picking, setPicking] = useState(false);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ kind: 'note' | 'folder'; id: string; x: number; y: number; trigger: HTMLElement } | null>(null);
  const [editing, setEditing] = useState<{ note: Note; mode: 'rename' | 'move' } | null>(null);
  useEffect(() => { if (requestedId) { setSelectedId(requestedId); setFolder('all'); setQuery(''); } }, [requestedId, requestNonce]);
  const folders = state.workspace.noteFolders.filter(item => !item.values.deleted).sort((a, b) => a.values.name.localeCompare(b.values.name, 'zh-CN'));
  const notes = state.workspace.notes.filter(isNotebookNote);
  const deletingNote = deleting && (notes.find(note => note.id === deleting.id) ?? deleting);
  const menuNote = menu?.kind === 'note' ? notes.find(item => item.id === menu.id) : undefined;
  const menuFolder = menu?.kind === 'folder' ? folders.find(item => item.id === menu.id) : undefined;
  useEffect(() => { if (menu && (busy || (!menuNote && !menuFolder))) setMenu(null); }, [busy, menu, menuNote, menuFolder]);
  function context(kind: 'note' | 'folder', id: string) {
    return {
      onContextMenu: (event: React.MouseEvent<HTMLElement>) => { event.preventDefault(); if (!busy) setMenu({ kind, id, x: event.clientX, y: event.clientY, trigger: event.currentTarget }); },
      onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
        if (event.nativeEvent.isComposing || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) return;
        event.preventDefault(); if (busy) return; const box = event.currentTarget.getBoundingClientRect();
        setMenu({ kind, id, x: box.left + 12, y: box.bottom, trigger: event.currentTarget });
      },
    };
  }
  const selected = state.workspace.notes.find(item => item.id === selectedId);
  const visible = notes.filter(note => (folder === 'all' || noteFolder(state.workspace, note) === (folders.some(item => item.id === folder) ? folder : null)) && `${note.values.title}\n${note.values.content}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => Math.max(b.clocks.content.tick, b.clocks.title.tick) - Math.max(a.clocks.content.tick, a.clocks.title.tick));
  async function execute(action: () => Promise<unknown>) {
    if (busy) return; setBusy(true); setError('');
    try { await flushMainDrafts(); await action(); } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  async function command(command: Parameters<DesktopAPI['command']>[0]) { const next = await api.command(command); update(next); return next; }
  function confirmDelete(note: Note) { setError(''); setDeleting(note); }
  function cancelDelete() { setDeleting(null); setError(''); }
  function tree(): React.ReactNode {
    const children = new Map<string | null, NoteFolder[]>();
    for (const item of folders) { const parent = folderParent(state.workspace, item.id); children.set(parent, [...children.get(parent) ?? [], item]); }
    const rows: { item: NoteFolder; depth: number }[] = [], stack = (children.get(null) ?? []).map(item => ({ item, depth: 0 })).reverse();
    while (stack.length) { const row = stack.pop()!; rows.push(row); for (const item of [...children.get(row.item.id) ?? []].reverse()) stack.push({ item, depth: row.depth + 1 }); }
    return rows.map(({ item, depth }) => <div key={item.id}>
      <div className={`notebook-folder-row ${folder === item.id ? 'selected' : ''}`} style={{ paddingLeft: Math.min(depth, 8) * 12 }}>
        <button {...context('folder', item.id)} disabled={busy} onClick={() => void execute(async () => { setFolder(item.id); setSelectedId(null); })}><Folder size={15} /><span>{item.values.name}</span></button>
        <button className="icon-button" aria-label={`管理目录 ${item.values.name}`} disabled={busy} onClick={() => setFolderDialog({ item, parentId: item.values.parentId })}><Pencil size={13} /></button>
      </div></div>);
  }
  return <section className="notebook" aria-label="笔记" data-editing={!!selected}>
    <header className="notebook-header"><h1><BookOpen size={23} />笔记</h1><div>
      <button className="button primary" disabled={busy} onClick={() => void execute(async () => {
        const next = await command({ type: 'notebook.add', folderId: folder === 'all' ? null : folder });
        const ids = new Set(state.workspace.notes.map(item => item.id)); setSelectedId(next.workspace.notes.find(item => !ids.has(item.id))!.id); setQuery('');
      })}><FilePlus2 size={16} />新建笔记</button>
      <button className="button secondary" disabled={busy} onClick={() => setFolderDialog({ parentId: folder === 'all' ? null : folder })}><FolderPlus size={16} />新建目录</button>
      <button className="button secondary" disabled={busy} onClick={() => setPicking(true)}><Link2 size={16} />从便签添加</button>
    </div></header>
    {error && <div className="notebook-error" role="alert">{error}</div>}
    <div className="notebook-body"><aside className="notebook-browser" aria-label="笔记目录与列表">
      <label className="notebook-search"><Search size={16} /><input aria-label="搜索笔记" placeholder="搜索笔记" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <nav className="notebook-folders" aria-label="笔记目录">
        <button className={`notebook-folder-choice ${folder === 'all' ? 'selected' : ''}`} onClick={() => void execute(async () => { setFolder('all'); setSelectedId(null); })}><BookOpen size={15} />全部笔记<span>{notes.length}</span></button>
        <button className={`notebook-folder-choice ${folder === null ? 'selected' : ''}`} onClick={() => void execute(async () => { setFolder(null); setSelectedId(null); })}><Folder size={15} />根目录</button>{tree()}
      </nav>
      <div className="notebook-note-list">{visible.map(note => <button key={note.id} {...context('note', note.id)} className={`notebook-note ${selectedId === note.id ? 'selected' : ''}`} disabled={busy} onClick={() => void execute(async () => setSelectedId(note.id))}>
        <strong><FileText size={14} />{note.values.title || '未命名笔记'}</strong><span>{note.values.content.slice(0, 100) || '开始记录…'}</span>{isDesktopNote(note) && <small><Link2 size={11} />关联便签</small>}
      </button>)}{!visible.length && <p className="notebook-empty-list">{query ? '没有匹配的笔记' : '此目录还没有笔记'}</p>}</div>
    </aside>
      {selected ? <NotebookEditor key={selected.id} note={selected} state={state} api={api} update={update} busy={busy} back={() => void execute(async () => setSelectedId(null))}
        move={folderId => void execute(async () => { await command({ type: 'notebook.move', id: selected.id, folderId }); })}
        desktop={() => void execute(async () => { await command({ type: 'note.desktop', id: selected.id }); await api.noteWindow({ type: 'open', id: selected.id }); })}
        remove={() => confirmDelete(selected)} restore={() => void execute(async () => { await command({ type: 'note.notebook', id: selected.id, mode: 'link' }); })} />
        : <div className="notebook-empty"><BookOpen size={36} /><h2>留一处地方，整理想法</h2><p>选择或新建一篇笔记，用目录分类。</p></div>}
    </div>
    {menu && (menuNote || menuFolder) && <ContextMenu x={menu.x} y={menu.y} label={menuNote ? '笔记操作' : '目录操作'} close={restore => { if (restore) menu.trigger.focus({ preventScroll: true }); setMenu(null); }} items={menuNote ? [
      { label: '打开笔记', icon: <BookOpen size={16} />, action: () => void execute(async () => setSelectedId(menuNote.id)) },
      { label: '重命名', icon: <Pencil size={16} />, action: () => void execute(async () => setEditing({ note: menuNote, mode: 'rename' })) },
      { label: '移动到目录', icon: <Folder size={16} />, action: () => void execute(async () => setEditing({ note: menuNote, mode: 'move' })) },
      { label: isDesktopNote(menuNote) ? '打开关联便签' : '关联便签', icon: <StickyNote size={16} />, action: () => void execute(async () => { await command({ type: 'note.desktop', id: menuNote.id }); await api.noteWindow({ type: 'open', id: menuNote.id }); }) },
      { label: '删除笔记', icon: <Trash2 size={16} />, danger: true, divider: true, action: () => confirmDelete(menuNote) },
    ] : [
      { label: '新建笔记', icon: <FilePlus2 size={16} />, action: () => void execute(async () => { const next = await command({ type: 'notebook.add', folderId: menuFolder!.id }); setFolder(menuFolder!.id); setQuery(''); setSelectedId(next.workspace.notes.find(item => !state.workspace.notes.some(old => old.id === item.id))!.id); }) },
      { label: '新建子目录', icon: <FolderPlus size={16} />, action: () => setFolderDialog({ parentId: menuFolder!.id }) },
      { label: '重命名或移动目录', icon: <Pencil size={16} />, action: () => setFolderDialog({ item: menuFolder, parentId: menuFolder!.values.parentId }) },
      { label: '删除目录', icon: <Trash2 size={16} />, danger: true, divider: true, action: () => setFolderDialog({ item: menuFolder, parentId: menuFolder!.values.parentId, confirmDelete: true }) },
    ]} />}
    {editing && <NoteOperation key={`${editing.note.id}:${editing.mode}`} note={state.workspace.notes.find(item => item.id === editing.note.id) ?? editing.note} mode={editing.mode} folders={folders} busy={busy} error={error} close={() => { setEditing(null); setError(''); }} save={value => void execute(async () => {
      await command(editing.mode === 'rename' ? { type: 'note.update', id: editing.note.id, patch: { title: value } } : { type: 'notebook.move', id: editing.note.id, folderId: value || null });
      if (editing.mode === 'move') { setFolder(value || null); setQuery(''); setSelectedId(editing.note.id); } setEditing(null);
    })} />}
    {folderDialog && <FolderEditor item={folderDialog.item} parentId={folderDialog.parentId} confirmDelete={folderDialog.confirmDelete} folders={folders} busy={busy} error={error} close={() => { setFolderDialog(null); setError(''); }}
      save={(name, parentId) => void execute(async () => {
        const next = await command(folderDialog.item ? { type: 'noteFolder.update', id: folderDialog.item.id, patch: { name, parentId } } : { type: 'noteFolder.add', name, parentId });
        if (!folderDialog.item) setFolder(next.workspace.noteFolders.find(item => !state.workspace.noteFolders.some(prior => prior.id === item.id))!.id);
        setFolderDialog(null);
      })} remove={folderDialog.item ? () => void execute(async () => {
        const item = folderDialog.item!; await command({ type: 'noteFolder.update', id: item.id, patch: { deleted: true } }); setFolder(null); setFolderDialog(null);
        toast('目录已删除，笔记和子目录保留在根目录', () => void execute(async () => { await command({ type: 'noteFolder.update', id: item.id, patch: { deleted: false } }); }));
      }) : undefined} />}
    {deletingNote && <Modal title="删除笔记" close={cancelDelete} busy={busy} initialFocus={cancelDeleteRef}>
      <div className="notebook-delete-confirmation">
        <p className="notebook-delete-name">确定删除“<strong>{deletingNote.values.title.trim() || '未命名笔记'}</strong>”吗？</p>
        <p className="notebook-delete-description">{isDesktopNote(deletingNote)
          ? '此操作仅从笔记中移除，关联的桌面便签及正文会保留。'
          : <>笔记将移入回收站，可在此处还原：<br />设置 → 数据与同步 → 回收站</>}</p>
        {error && <p role="alert" className="inline-error">{error}</p>}
        <div className="form-footer">
          <button ref={cancelDeleteRef} className="button secondary" disabled={busy} onClick={cancelDelete}>取消</button>
          <button className="button danger-button" disabled={busy} onClick={() => void execute(async () => {
            const note = deletingNote; await command({ type: 'notebook.remove', id: note.id }); setDeleting(null); setSelectedId(current => current === note.id ? null : current);
            toast(isDesktopNote(note) ? '笔记入口已移除，关联便签保留' : '笔记已移入回收站', () => void execute(async () => { await command({ type: 'note.notebook', id: note.id, mode: 'link' }); }));
          })}>{busy ? '正在删除…' : '删除笔记'}</button>
        </div>
      </div>
    </Modal>}
    {picking && <Modal title="从便签添加笔记" close={() => setPicking(false)} busy={busy}><p className="setting-description">添加后两边共用正文，之后的修改会同步。</p><div className="notebook-picker">{state.workspace.notes.filter(note => isDesktopNote(note) && !isNotebookNote(note)).map(note => <button className="notebook-note" key={note.id} disabled={busy} onClick={() => void execute(async () => { await command({ type: 'note.notebook', id: note.id, mode: 'link', folderId: folder === 'all' ? null : folder }); setSelectedId(note.id); setPicking(false); })}><strong>{note.values.title || '未命名便签'}</strong><span>{note.values.content.slice(0, 100)}</span></button>)}{!state.workspace.notes.some(note => isDesktopNote(note) && !isNotebookNote(note)) && <p>没有尚未加入笔记的便签。</p>}</div>{error && <p className="inline-error" role="alert">{error}</p>}</Modal>}
  </section>;
}

function NotebookEditor({ note, state, api, update, busy, back, move, desktop, remove, restore }: Omit<Props, 'toast'> & { note: Note; busy: boolean; back: () => void; move: (id: string | null) => void; desktop: () => void; remove: () => void; restore: () => void }) {
  const latest = useRef({ api, update }); latest.current = { api, update };
  const [draft] = useState(() => new FieldDraft({ title: note.values.title, content: note.values.content }, async patch => {
    const next = await latest.current.api.command({ type: 'note.update', id: note.id, patch }); latest.current.update(next);
    const saved = next.workspace.notes.find(item => item.id === note.id); if (!saved) throw new Error('笔记未能保存，请重试。');
    return { title: saved.values.title, content: saved.values.content };
  }));
  const snapshot = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
  useEffect(() => draft.receive({ title: note.values.title, content: note.values.content }), [draft, note.values.title, note.values.content]);
  useEffect(() => registerMainDraft(draft), [draft]);
  useEffect(() => () => { void draft.flush().catch(() => {}); draft.dispose(); }, [draft]);
  const disabled = !isNotebookNote(note);
  return <article className="notebook-editor" aria-label="编辑笔记">
    <div className="notebook-editor-actions"><button className="button secondary notebook-back" onClick={back} disabled={busy}><ArrowLeft size={15} />笔记列表</button>
      <label>目录<select aria-label="笔记所在目录" value={noteFolder(state.workspace, note) ?? ''} disabled={busy || disabled} onChange={event => move(event.target.value || null)}><option value="">根目录</option>{state.workspace.noteFolders.filter(item => !item.values.deleted).map(item => <option key={item.id} value={item.id}>{item.values.name}</option>)}</select></label>
      <button className="button secondary" disabled={busy || disabled} onClick={desktop}><StickyNote size={15} />{isDesktopNote(note) ? '打开关联便签' : '关联便签'}</button><button className="icon-button" aria-label="删除当前笔记" disabled={busy || disabled} onClick={remove}><Trash2 size={16} /></button>
    </div>
    {disabled && <p className="notebook-removed">此笔记入口已移除。<button className="text-button" disabled={busy} onClick={restore}>恢复笔记</button></p>}
    <input className="notebook-title" aria-label="笔记标题" placeholder="未命名笔记" maxLength={200} value={snapshot.values.title} disabled={disabled} onChange={event => draft.change('title', event.target.value)} onBlur={() => void draft.flush().catch(() => {})} />
    <DocumentEditor target={{ kind: 'note', id: note.id }} label="笔记内容" value={snapshot.values.content} assets={note.values.assets} disabled={disabled} onChange={value => draft.change('content', value)} onSave={() => draft.flush()} />
    <footer className="notebook-save" role="status">{snapshot.error || (snapshot.dirty || snapshot.saving ? '正在保存…' : '已保存')}{snapshot.error && <button onClick={() => void draft.flush().catch(() => {})}>重试保存</button>}</footer>
  </article>;
}
function FolderEditor({ item, parentId, confirmDelete, folders, busy, error, close, save, remove }: { item?: NoteFolder; parentId: string | null; confirmDelete?: boolean; folders: NoteFolder[]; busy: boolean; error: string; close: () => void; save: (name: string, parentId: string | null) => void; remove?: () => void }) {
  const [name, setName] = useState(item?.values.name ?? ''), [parent, setParent] = useState(parentId ?? ''), [confirm, setConfirm] = useState(!!confirmDelete);
  return <Modal title={item ? '管理笔记目录' : '新建笔记目录'} close={close} busy={busy}><form className="board-form" onSubmit={event => { event.preventDefault(); save(name.trim(), parent || null); }}>
    <label>目录名称<input autoFocus required maxLength={100} aria-label="目录名称" value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
    <label>上级目录<select aria-label="上级目录" value={parent} disabled={busy} onChange={event => setParent(event.target.value)}><option value="">根目录</option>{folders.filter(folder => folder.id !== item?.id).map(folder => <option key={folder.id} value={folder.id}>{folder.values.name}</option>)}</select></label>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {confirm && <p className="setting-description">只删除目录，里面的笔记和子目录会保留在根目录。<button type="button" className="text-button danger-text" disabled={busy} onClick={remove}>确认删除目录</button></p>}
    <div className="form-footer">{remove && <button type="button" className="text-button danger-text" disabled={busy} onClick={() => setConfirm(true)}>删除目录</button>}<button type="button" className="button secondary" onClick={close} disabled={busy}>取消</button><button className="button primary" disabled={busy || !name.trim()}>保存目录</button></div>
  </form></Modal>;
}

function NoteOperation({ note, mode, folders, busy, error, close, save }: { note: Note; mode: 'rename' | 'move'; folders: NoteFolder[]; busy: boolean; error: string; close: () => void; save: (value: string) => void }) {
  const [value, setValue] = useState(mode === 'rename' ? note.values.title : note.values.folderId ?? '');
  return <Modal title={mode === 'rename' ? '重命名笔记' : '移动笔记'} close={close} busy={busy}><form className="board-form" onSubmit={event => { event.preventDefault(); save(mode === 'rename' ? value.trim() : value); }}>
    {mode === 'rename' ? <label>笔记名称<input autoFocus required maxLength={200} value={value} onChange={event => setValue(event.target.value)} disabled={busy} /></label> : <label>目标目录<select autoFocus value={value} onChange={event => setValue(event.target.value)} disabled={busy}><option value="">根目录</option>{folders.map(item => <option key={item.id} value={item.id}>{item.values.name}</option>)}</select></label>}
    {error && <p className="inline-error" role="alert">{error}</p>}<div className="form-footer"><button type="button" className="button secondary" disabled={busy} onClick={close}>取消</button><button className="button primary" disabled={busy || mode === 'rename' && !value.trim()}>保存</button></div>
  </form></Modal>;
}
