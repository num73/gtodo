import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { Camera, Code, Eye, FolderOpen, ImagePlus, Pencil, FileCode2, Type, Search, Maximize2, Minimize2, Table2, Link2, History } from 'lucide-react';
import { MAX_IMAGE_BYTES, type AssetMap, type DocumentTarget } from '../shared/documents';
import { isComposing } from './keyboard';
import { registerMainDraft } from '../notes/draft';
import type { LiveEditorHandle } from './LiveMarkdownEditor';
import Modal from './Modal';
import { markdownEdit, markdownFormats, type MarkdownFormat } from './markdown-actions';

type EditingMode = 'live' | 'source';
const DocumentHistory = lazy(() => import('./DocumentHistory'));
const modeKey = 'gtodo-markdown-editing-mode';
function preferredMode(): EditingMode { try { return window.localStorage.getItem(modeKey) === 'source' ? 'source' : 'live'; } catch { return 'live'; } }
export default function DocumentEditor({ target, label, value, assets, onChange, onSave, disabled = false, sticky = false, toolbarTarget, collapsedToolbar = false, onToolbarAction }: {
  target: DocumentTarget; label: string; value: string; assets: AssetMap;
  onChange: (value: string) => void; onSave: () => Promise<void>;
  disabled?: boolean; sticky?: boolean; toolbarTarget?: HTMLElement | null; collapsedToolbar?: boolean; onToolbarAction?: () => void;
}) {
  const editor = useRef<HTMLTextAreaElement>(null), live = useRef<LiveEditorHandle>(null);
  const latest = useRef(value); latest.current = value;
  const selection = useRef({ start: value.length, end: value.length });
  const [mode, setMode] = useState<EditingMode>(preferredMode);
  const [preview, setPreview] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expanded, setExpanded] = useState(false), [formatsOpen, setFormatsOpen] = useState(false), [linkURL, setLinkURL] = useState('https://');
  const [searchRequested, setSearchRequested] = useState(false);
  const [Live, setLive] = useState<typeof import('./LiveMarkdownEditor').default | null>(null);
  const [Preview, setPreviewComponent] = useState<typeof import('./MarkdownPreview').default | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef<Promise<unknown> | null>(null), focusRequested = useRef(false);
  const active = useRef(true), currentTarget = useRef(''); currentTarget.current = `${target.kind}:${target.id}`;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => registerMainDraft({ flush: async () => { await pending.current; } }), []);
  useEffect(() => {
    if (mode !== 'live' || Live) return;
    let alive = true;
    import('./LiveMarkdownEditor').then(module => { if (alive) setLive(() => module.default); }).catch(() => {
      if (alive) { setError('实时编辑器加载失败，已切换到源码，可继续编辑。'); setMode('source'); }
    });
    return () => { alive = false; };
  }, [mode, Live]);
  useEffect(() => {
    if (!focusRequested.current || preview || (mode === 'live' && !Live)) return;
    focusRequested.current = false;
    const frame = window.requestAnimationFrame(() => focusEditor(selection.current.start, selection.current.end));
    return () => window.cancelAnimationFrame(frame);
  }, [mode, Live, preview]);
  const api = window.gtodo;
  useEffect(() => {
    if (!searchRequested || !Live || mode !== 'live' || preview) return;
    const frame = window.requestAnimationFrame(() => { live.current?.openSearch(); setSearchRequested(false); });
    return () => window.cancelAnimationFrame(frame);
  }, [searchRequested, Live, mode, preview]);
  function find() { remember(); setMode('live'); setPreview(false); setSearchRequested(true); onToolbarAction?.(); }
  async function execute(action: () => Promise<unknown>, closeToolbar = false) {
    if (pending.current) return;
    setBusy(true); setError('');
    const operation = Promise.resolve().then(action); pending.current = operation;
    try { await operation; if (closeToolbar) onToolbarAction?.(); }
    catch (error) { if (active.current) setError((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    finally { pending.current = null; if (active.current) setBusy(false); }
  }
  function remember() {
    if (preview) return;
    if (mode === 'live' && live.current) selection.current = live.current.getSelection();
    else if (editor.current) selection.current = { start: editor.current.selectionStart, end: editor.current.selectionEnd };
  }
  function focusEditor(start: number, end = start) {
    if (mode === 'live' && live.current) { live.current.setSelection(start, end); live.current.focus(); }
    else { editor.current?.focus(); editor.current?.setSelectionRange(start, end); }
  }
  function change(next: string) { latest.current = next; onChange(next); }
  function insert(text: string, original = latest.current, selected = selection.current) {
    const current = latest.current;
    const start = original === current ? Math.min(selected.start, current.length) : current.length;
    const end = original === current ? Math.min(selected.end, current.length) : current.length;
    const next = current.slice(0, start) + text + current.slice(end);
    if (next.length > 100000) throw new Error('内容不能超过 100000 个字符。');
    selection.current = { start: start + text.length, end: start + text.length };
    if (mode === 'live' && live.current) live.current.replaceRange(start, end, text);
    else change(next);
    setPreview(false);
    window.requestAnimationFrame(() => focusEditor(start + text.length));
  }
  function imageMarkdown(image: { path: string; name: string }) { return `![${image.name.replace(/[\[\]\\\r\n]/g, '')}](${encodeURI(image.path)})\n`; }
  async function importFiles(files: File[]) {
    const before = latest.current, selected = { ...selection.current }, inserted: string[] = [];
    let failure: unknown;
    for (const file of files) {
      try {
        if (file.size > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 10 MB。');
        const image = await api!.insertDocumentImage({ target, name: file.name.slice(0, 200), bytes: new Uint8Array(await file.arrayBuffer()) });
        inserted.push(imageMarkdown(image));
      } catch (error) { failure = error; break; }
    }
    if (inserted.length) { insert(inserted.join('\n'), before, selected); await onSave(); }
    if (failure) throw failure;
  }
  const openLink = (url: string) => { void execute(() => api!.openLink(url)); };
  function format(kind: MarkdownFormat) {
    const edit = markdownEdit(latest.current, selection.current.start, selection.current.end, kind);
    void execute(async () => { insert(edit.text, latest.current, { start: edit.from, end: edit.to }); setFormatsOpen(false); window.requestAnimationFrame(() => focusEditor(edit.selectFrom, edit.selectTo)); await onSave(); }, true);
  }
  const toolbar = <div className="document-toolbar">
    <span className="document-format-label">Markdown</span>
    <button type="button" aria-label="正文历史版本" title="查看和还原正文历史版本" disabled={disabled || busy} onClick={() => void execute(async () => { await onSave(); setHistoryOpen(true); }, true)}><History size={15} /><span>历史</span></button>
    <button type="button" aria-label={`设置${label}格式`} title="标题、强调、列表、链接与表格" disabled={disabled || busy} onMouseDown={event => event.preventDefault()} onClick={() => { remember(); setFormatsOpen(true); }}><Type size={15} /><span>格式</span></button>
    <button type="button" aria-label={`${mode === 'live' ? '源码编辑' : '实时编辑'}${label}`} title={mode === 'live' ? '查看和编辑 Markdown 源码' : '在排版中实时编辑'} aria-pressed={mode === 'source'} disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => {
      remember(); const next = mode === 'live' ? 'source' : 'live'; focusRequested.current = true; setMode(next); setPreview(false);
      try { window.localStorage.setItem(modeKey, next); } catch { /* Editing works even without local preferences. */ }
      onToolbarAction?.();
    }}>{mode === 'live' ? <FileCode2 size={15} /> : <Pencil size={15} />}<span>{mode === 'live' ? '源码' : '实时'}</span></button>
    <button type="button" aria-label={`${preview ? '编辑' : '预览'}${label}`} title={preview ? '返回编辑' : '只读预览'} aria-pressed={preview} disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => {
      remember(); void execute(async () => {
        await onSave();
        if (!preview && !Preview) { const module = await import('./MarkdownPreview'); setPreviewComponent(() => module.default); }
        if (preview) focusRequested.current = true;
        setPreview(!preview);
      }, true);
    }}>{preview ? <Pencil size={15} /> : <Eye size={15} />}<span>{preview ? '编辑' : '预览'}</span></button>
    <button type="button" aria-label={`截图插入${label}`} title="框选截图" disabled={disabled || busy} onMouseDown={event => event.preventDefault()} onClick={() => {
      remember(); const identity = currentTarget.current, before = latest.current, selected = { ...selection.current };
      void execute(async () => { await onSave(); const image = await api!.captureDocumentImage(target); if (image && active.current && currentTarget.current === identity) { insert(imageMarkdown(image), before, selected); await onSave(); } }, true);
    }}><Camera size={16} /></button>
    <button type="button" aria-label={`插入图片到${label}`} title="插入图片，也可粘贴或拖入" disabled={disabled || busy} onMouseDown={event => event.preventDefault()} onClick={() => {
      remember(); const before = latest.current, selected = { ...selection.current };
      void execute(async () => { await onSave(); const image = await api!.pickDocumentImage(target); if (image) { insert(imageMarkdown(image), before, selected); await onSave(); } }, true);
    }}><ImagePlus size={16} /></button>
    <button type="button" aria-label={`插入代码块到${label}`} title="插入代码块" disabled={disabled || busy} onMouseDown={event => event.preventDefault()} onClick={() => void execute(async () => {
      remember(); const selected = latest.current.slice(selection.current.start, selection.current.end);
      insert(`\n\`\`\`text\n${selected}\n\`\`\`\n`); await onSave();
    }, true)}><Code size={16} /></button>
    <button type="button" className="document-location" aria-label={`打开${label}文件位置`} title="打开文件位置" disabled={disabled || busy} onClick={() => void execute(async () => { await onSave(); await api!.showDocumentFile(target); }, true)}><FolderOpen size={16} /></button>
    <button type="button" aria-label={`查找替换${label}`} title="查找与替换 (Ctrl+F / Ctrl+H)" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={find}><Search size={15} /></button>
    <button type="button" aria-label={`${expanded ? '收起' : '展开'}${label}编辑器`} title={expanded ? '收起编辑器 (Esc)' : '展开编辑器'} aria-expanded={expanded} onMouseDown={event => event.preventDefault()} onClick={() => { remember(); setExpanded(!expanded); onToolbarAction?.(); }}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
  </div>;
  return <div className={`document-editor ${sticky ? 'document-editor-sticky' : ''} ${expanded ? 'document-expanded' : ''}`} data-format="markdown" data-mode={preview ? 'preview' : mode} onKeyDown={event => {
    if (isComposing(event.nativeEvent)) return;
    if (event.ctrlKey && ['f', 'h'].includes(event.key.toLowerCase())) { event.stopPropagation(); if (!event.defaultPrevented) { event.preventDefault(); find(); } }
    if (event.key === 'Escape' && !event.defaultPrevented) {
      if (preview) { event.stopPropagation(); focusRequested.current = true; setPreview(false); }
      else if (expanded) { event.stopPropagation(); setExpanded(false); }
    }
  }}>
    {collapsedToolbar && !expanded ? (toolbarTarget ? createPortal(toolbar, toolbarTarget) : null) : toolbar}
    {Live && <div className="document-live-wrap" hidden={mode !== 'live' || preview}><Live ref={live} target={target} label={label} value={value} assets={assets} disabled={disabled}
      initialSelection={selection.current} onSelection={selected => { if (mode === 'live' && !preview) selection.current = selected; }} onChange={change}
      onBlur={() => { void onSave().catch(() => {}); }} onSave={() => void execute(onSave)} onError={setError} openLink={openLink}
      onFiles={files => { if (!busy) void execute(() => importFiles(files)); }} /></div>}
    {mode === 'live' && !Live && !preview && <p className="document-loading" role="status">正在加载编辑器…</p>}
    <textarea ref={editor} hidden={mode !== 'source' || preview} className="document-source" aria-label={label} placeholder="输入 Markdown 内容" maxLength={100000} value={value} disabled={disabled} rows={6} spellCheck={false}
      onChange={event => { change(event.target.value); remember(); }} onSelect={remember} onBlur={() => { remember(); void onSave().catch(() => {}); }}
      onKeyDown={event => { if (event.ctrlKey && event.key.toLowerCase() === 's') { event.preventDefault(); void execute(onSave); } }}
      onPaste={event => { const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); if (!busy) { remember(); void execute(() => importFiles(files)); } } }}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
      onDrop={event => { const files = Array.from(event.dataTransfer.files); if (files.length) { event.preventDefault(); if (!busy) { remember(); void execute(() => importFiles(files)); } } }} />
    {preview && Preview && <Preview value={value} label={label} target={target} assets={assets} openLink={openLink} />}
    {error && <div className="document-error" role="alert">{error}</div>}
    {historyOpen && <Suspense fallback={null}><DocumentHistory target={target} close={() => setHistoryOpen(false)} /></Suspense>}
    {formatsOpen && <Modal title="Markdown 格式" close={() => setFormatsOpen(false)} busy={busy}>
      <div className="markdown-format-grid">{markdownFormats.map(item => <button type="button" key={item.id} className="button secondary" disabled={busy} onClick={() => format(item.id)}>{item.label}</button>)}
        <button className="button secondary" disabled={busy} onClick={() => void execute(async () => { insert('\n| 标题一 | 标题二 |\n| --- | --- |\n| 内容 | 内容 |\n'); setFormatsOpen(false); await onSave(); }, true)}><Table2 size={15} />插入表格</button>
      </div>
      <form className="markdown-link-form" onSubmit={event => { event.preventDefault(); void execute(async () => { const text = latest.current.slice(selection.current.start, selection.current.end) || '链接文字'; insert(`[${text.replace(/[\[\]\\\n]/g, '')}](${linkURL.trim().replaceAll(')', '%29')})`); setFormatsOpen(false); await onSave(); }, true); }}>
        <label>网页链接<input type="url" aria-label="Markdown 链接地址" value={linkURL} onChange={event => setLinkURL(event.target.value)} required disabled={busy} /></label><button className="button primary" disabled={busy}><Link2 size={15} />插入链接</button>
      </form>
      {error && <p className="inline-error" role="alert">{error}</p>}
    </Modal>}
  </div>;
}
