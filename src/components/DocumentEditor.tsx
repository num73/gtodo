import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Code, Eye, FolderOpen, ImagePlus, Pencil } from 'lucide-react';
import { MAX_IMAGE_BYTES, type AssetMap, type DocumentFormat, type DocumentTarget } from '../shared/documents';
export default function DocumentEditor({ target, label, value, format, assets, onChange, onFormatChange, onSave, disabled = false, sticky = false, toolbarTarget, collapsedToolbar = false, onToolbarAction }: {
  target: DocumentTarget; label: string; value: string; format: DocumentFormat; assets: AssetMap;
  onChange: (value: string) => void; onFormatChange: (format: DocumentFormat) => Promise<void>; onSave: () => Promise<void>;
  disabled?: boolean; sticky?: boolean;
  toolbarTarget?: HTMLElement | null; collapsedToolbar?: boolean; onToolbarAction?: () => void;
}) {
  const editor = useRef<HTMLTextAreaElement>(null);
  const latest = useRef({ value, format }); latest.current = { value, format };
  const selection = useRef({ start: value.length, end: value.length });
  const [preview, setPreview] = useState(false);
  const [Preview, setPreviewComponent] = useState<typeof import('./MarkdownPreview').default | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const api = window.gtodo;
  async function execute(action: () => Promise<unknown>, closeToolbar = false) {
    setBusy(true); setError('');
    try { await action(); if (closeToolbar) onToolbarAction?.(); } catch (error) { setError((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    finally { setBusy(false); }
  }
  function remember() { if (editor.current) selection.current = { start: editor.current.selectionStart, end: editor.current.selectionEnd }; }
  function insert(text: string, original = latest.current.value, selected = selection.current) {
    if (latest.current.format !== 'markdown') return;
    const current = latest.current.value;
    const start = original === current ? Math.min(selected.start, current.length) : current.length;
    const end = original === current ? Math.min(selected.end, current.length) : current.length;
    const next = current.slice(0, start) + text + current.slice(end);
    if (next.length > 100000) throw new Error('内容不能超过 100000 个字符。');
    latest.current.value = next; onChange(next); setPreview(false);
    window.requestAnimationFrame(() => { editor.current?.focus(); editor.current?.setSelectionRange(start + text.length, start + text.length); remember(); });
  }
  function imageMarkdown(image: { path: string; name: string }) {
    return `![${image.name.replace(/[\[\]\\\r\n]/g, '')}](${encodeURI(image.path)})\n`;
  }
  async function importFiles(files: File[]) {
    const before = latest.current.value; const selected = { ...selection.current };
    const inserted: string[] = [];
    for (const file of files) {
      if (file.size > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 10 MB。');
      const image = await api!.insertDocumentImage({ target, name: file.name.slice(0, 200), bytes: new Uint8Array(await file.arrayBuffer()) });
      inserted.push(imageMarkdown(image));
    }
    insert(inserted.join('\n'), before, selected); await onSave();
  }
  const toolbar = <div className="document-toolbar">
      <select aria-label={`${label}格式`} value={format} disabled={disabled || busy} onChange={event => {
        const mode = event.target.value as DocumentFormat;
        void execute(async () => { await onFormatChange(mode); if (mode === 'text') setPreview(false); });
      }}><option value="text">纯文本</option><option value="markdown">Markdown</option></select>
      {format === 'markdown' && <>
        <button type="button" aria-label={`${preview ? '编辑' : '预览'}${label}`} title={preview ? '编辑' : '预览'} aria-pressed={preview} disabled={busy} onClick={() => {
          remember();
          void execute(async () => {
            await onSave();
            if (!preview && !Preview) { const module = await import('./MarkdownPreview'); setPreviewComponent(() => module.default); }
            setPreview(!preview);
          }, true);
        }}>{preview ? <Pencil size={15} /> : <Eye size={15} />}<span>{preview ? '编辑' : '预览'}</span></button>
        <button type="button" aria-label={`插入图片到${label}`} title="插入图片，也可粘贴或拖入" disabled={disabled || busy} onMouseDown={event => event.preventDefault()} onClick={() => {
          const before = latest.current.value; const selected = { ...selection.current };
          void execute(async () => { await onSave(); const image = await api!.pickDocumentImage(target); if (image) { insert(imageMarkdown(image), before, selected); await onSave(); } }, true);
        }}><ImagePlus size={16} /></button>
        <button type="button" aria-label={`插入代码块到${label}`} title="插入代码块" disabled={disabled || busy} onMouseDown={event => event.preventDefault()} onClick={() => void execute(async () => {
          const selected = latest.current.value.slice(selection.current.start, selection.current.end);
          insert(`\n\`\`\`text\n${selected}\n\`\`\`\n`); await onSave();
        }, true)}><Code size={16} /></button>
      </>}
      <button type="button" className="document-location" aria-label={`打开${label}文件位置`} title="打开文件位置" disabled={disabled || busy} onClick={() => void execute(async () => { await onSave(); await api!.showDocumentFile(target); }, true)}><FolderOpen size={16} /></button>
    </div>;
  return <div className={`document-editor ${sticky ? 'document-editor-sticky' : ''}`} data-format={format}>
    {collapsedToolbar ? (toolbarTarget ? createPortal(toolbar, toolbarTarget) : null) : toolbar}
    {preview && format === 'markdown' && Preview ? <Preview value={value} label={label} target={target} assets={assets} openLink={url => { void execute(() => api!.openLink(url)); }} /> : <textarea ref={editor} className="document-source" aria-label={label} placeholder={label === '备注' ? '添加备注' : '输入内容'} maxLength={100000} value={value} disabled={disabled} rows={6} spellCheck={false}
      onChange={event => { latest.current.value = event.target.value; onChange(event.target.value); remember(); }} onSelect={remember}
      onBlur={() => { remember(); void onSave().catch(() => {}); }}
      onKeyDown={event => { if (event.ctrlKey && event.key.toLowerCase() === 's') { event.preventDefault(); void execute(onSave); } }}
      onPaste={event => { if (format !== 'markdown' || busy) return; const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); remember(); void execute(() => importFiles(files)); } }}
      onDragOver={event => { if (format === 'markdown' && event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
      onDrop={event => { if (format !== 'markdown' || busy) return; const files = Array.from(event.dataTransfer.files); if (files.length) { event.preventDefault(); remember(); void execute(() => importFiles(files)); } }} />}
    {error && <div className="document-error" role="alert">{error}</div>}
  </div>;
}
