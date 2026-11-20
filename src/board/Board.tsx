import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { LayoutDashboard, CheckCircle2, StickyNote, Type, Image as ImageIcon, Wallpaper, Plus, Minus, Maximize, Maximize2, Minimize2, Check, ArrowUpToLine, ArrowDownToLine, X, Palette, ArrowUpRight, Search } from 'lucide-react';
import type { AppState, Command, DesktopAPI } from '../shared/model';
import { BOARD_SIZE, boardCardTitle, clampBoardLayout, defaultBoard, defaultCardStyle, type BoardCard as Card, type BoardCardValues, type BoardContent, type BoardImageInput, type BoardLayout, type BoardValues } from '../shared/board';
import { MAX_IMAGE_BYTES } from '../shared/documents';
import { flushMainDrafts, registerMainDraft } from '../notes/draft';
import Modal from '../components/Modal';
import BoardCard from './BoardCard';
import BoardImage from './BoardImage';

type Props = { state: AppState; api: DesktopAPI; update: (state: AppState) => void; toast: (text: string, undo?: () => void) => void; openTask: (id: string) => void; headingRef: RefObject<HTMLHeadingElement | null> };
type Dialog = { kind: 'pick'; source: 'task' | 'note' } | { kind: 'source'; source: 'task' | 'note' } | { kind: 'edit'; card?: Card } | { kind: 'background' };
type CardStyle = Pick<BoardCardValues, 'color' | 'textColor' | 'fontSize' | 'align' | 'imageFit'>;
const textBackgrounds = [
  { name: '浅黄', color: '#fff3bf' }, { name: '浅粉', color: '#ffe3e3' },
  { name: '浅蓝', color: '#dbeafe' }, { name: '薄荷绿', color: '#d3f9d8' },
  { name: '淡紫', color: '#e5dbff' }, { name: '杏橙', color: '#ffe8cc' },
  { name: '浅灰', color: '#e9ecef' }, { name: '白色', color: '#ffffff' },
];
const viewKey = 'gtodo-board-view';
function savedView(): { zoom: number; x: number; y: number } {
  try {
    const value = JSON.parse(localStorage.getItem(viewKey) ?? '{}');
    return { zoom: Number.isFinite(value.zoom) ? Math.max(0.1, Math.min(2, value.zoom)) : 1, x: Number.isFinite(value.x) ? Math.max(0, Math.min(12000, value.x)) : 0, y: Number.isFinite(value.y) ? Math.max(0, Math.min(12000, value.y)) : 0 };
  } catch { return { zoom: 1, x: 0, y: 0 }; }
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export default function Board({ state, api, update, toast, openTask, headingRef }: Props) {
  const [initial] = useState(savedView);
  const [zoom, setZoom] = useState(initial.zoom);
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const viewport = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenBusy, setFullscreenBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false); const busyRef = useRef(false);
  const imageImport = useRef<Promise<void> | null>(null);
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const cards = state.workspace.boardCards.filter(item => !item.values.deleted);
  const selected = cards.find(item => item.id === selectedId);
  const background = state.workspace.boards[0]?.values ?? defaultBoard;
  const saveView = () => {
    try { localStorage.setItem(viewKey, JSON.stringify({ zoom: zoomRef.current, x: viewport.current?.scrollLeft ?? 0, y: viewport.current?.scrollTop ?? 0 })); } catch { /* View preferences must not block editing. */ }
  };
  useLayoutEffect(() => { if (viewport.current) { viewport.current.scrollLeft = initial.x; viewport.current.scrollTop = initial.y; } }, [initial]);
  useEffect(() => saveView(), [zoom]);
  useEffect(() => {
    const change = () => setFullscreen(document.fullscreenElement === panel.current);
    document.addEventListener('fullscreenchange', change); change();
    return () => document.removeEventListener('fullscreenchange', change);
  }, []);
  useEffect(() => registerMainDraft({ flush: async () => { await imageImport.current; } }), []);
  useEffect(() => { if (!cards.some(item => item.id === selectedId)) setSelectedId(null); }, [state.workspace.boardCards, selectedId]);
  async function command(value: Command) { const next = await api.command(value); update(next); return next; }
  async function execute(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await action(); } catch (error) { toast(message(error)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  function importImages(action: () => Promise<void>) {
    return execute(async () => {
      const operation = action(); imageImport.current = operation;
      try { await operation; } finally { imageImport.current = null; }
    });
  }
  async function toggleFullscreen() {
    if (fullscreenBusy) return;
    setFullscreenBusy(true);
    try {
      if (document.fullscreenElement === panel.current) await document.exitFullscreen();
      else await panel.current?.requestFullscreen();
    } catch { toast('无法切换看板全屏，请重试。'); }
    finally { setFullscreenBusy(false); }
  }
  function placement(offset = 0, size = { width: 280, height: 220 }): BoardLayout {
    const area = viewport.current;
    const x = (area?.scrollLeft ?? 0) / zoom + 32 + offset * 28, y = (area?.scrollTop ?? 0) / zoom + 32 + offset * 28;
    // Stagger a new card if its origin would hide an existing card completely.
    let attempt = 0;
    while (attempt < 15 && cards.some(item => Math.abs(item.values.layout.x - x - attempt * 28) < 20 && Math.abs(item.values.layout.y - y - attempt * 28) < 20)) attempt++;
    return clampBoardLayout({ x: x + attempt * 28, y: y + attempt * 28, ...size });
  }
  function reveal(id: string) {
    setSelectedId(id);
    window.requestAnimationFrame(() => {
      const card = viewport.current?.querySelector<HTMLElement>(`[data-card-id="${id}"]`);
      card?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); card?.focus({ preventScroll: true });
    });
  }
  function added(next: AppState, previous = state.workspace.boardCards) {
    const ids = new Set(previous.map(item => item.id));
    const card = next.workspace.boardCards.find(item => !ids.has(item.id));
    if (card) reveal(card.id);
  }
  function open(card: Card) {
    const content = card.values.content;
    if ((content.kind === 'task' && !state.workspace.tasks.some(item => item.id === content.sourceId && !item.values.deleted)) || (content.kind === 'note' && !state.workspace.notes.some(item => item.id === content.sourceId && !item.values.deleted))) { toast('原内容已删除，可在回收站恢复。'); return; }
    if (content.kind === 'task' || content.kind === 'note') void execute(async () => {
      if (document.fullscreenElement === panel.current) await document.exitFullscreen();
      if (content.kind === 'task') openTask(content.sourceId);
      else await api.noteWindow({ type: 'open', id: content.sourceId });
    });
    else setDialog({ kind: 'edit', card });
  }
  async function remove(card: Card) {
    await flushMainDrafts();
    await command({ type: 'board.card.update', id: card.id, patch: { deleted: true } });
    setSelectedId(null); viewport.current?.focus({ preventScroll: true });
    toast('贴纸已从看板移除，原任务和便签保留', () => void execute(async () => { await command({ type: 'board.card.update', id: card.id, patch: { deleted: false } }); reveal(card.id); }));
  }
  async function pickImage(destination: BoardImageInput['destination']) {
    const next = await api.pickBoardImage({ destination, layout: destination === 'card' ? placement(0, { width: 360, height: 260 }) : undefined });
    if (next) { update(next.state); if (destination === 'card') added(next.state); }
  }
  async function insertFiles(files: File[], origin?: { x: number; y: number }) {
    if (!files.length) return;
    if (files.length > 12) throw new Error('一次最多添加 12 张图片，请分批拖入。');
    let current = state; let count = 0; const errors: string[] = [];
    for (const [index, file] of files.entries()) {
      try {
        if (!/^image\/(png|jpeg|gif|webp)$/i.test(file.type) && !/\.(png|jpe?g|gif|webp)$/i.test(file.name)) throw new Error('请选择 PNG、JPEG、GIF 或 WebP 图片。');
        if (file.size > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 10 MB。');
        const layout = origin ? clampBoardLayout({ x: origin.x + index * 28, y: origin.y + index * 28, width: 360, height: 260 }) : placement(index, { width: 360, height: 260 });
        const next = await api.insertBoardImage({ destination: 'card', layout, name: file.name.slice(0, 200), bytes: new Uint8Array(await file.arrayBuffer()) });
        update(next); added(next, current.workspace.boardCards); current = next; count++;
      } catch (error) { errors.push(`${file.name}：${message(error)}`); }
    }
    if (errors.length) toast(`${count ? `已添加 ${count} 张图片。` : ''}${errors[0]}`);
  }
  function changeZoom(value: number) {
    const next = Math.max(0.1, Math.min(2, value)), area = viewport.current;
    const x = area ? (area.scrollLeft + area.clientWidth / 2) / zoom : 0, y = area ? (area.scrollTop + area.clientHeight / 2) / zoom : 0;
    setZoom(next);
    window.requestAnimationFrame(() => { if (area) { area.scrollLeft = x * next - area.clientWidth / 2; area.scrollTop = y * next - area.clientHeight / 2; saveView(); } });
  }
  function fit() {
    const area = viewport.current; if (!area) return;
    if (!cards.length) { setZoom(1); area.scrollLeft = 0; area.scrollTop = 0; return; }
    const left = Math.min(...cards.map(item => item.values.layout.x)), top = Math.min(...cards.map(item => item.values.layout.y));
    const right = Math.max(...cards.map(item => item.values.layout.x + item.values.layout.width)), bottom = Math.max(...cards.map(item => item.values.layout.y + item.values.layout.height));
    const next = Math.max(0.1, Math.min(1, (area.clientWidth - 64) / (right - left), (area.clientHeight - 64) / (bottom - top)));
    setZoom(next);
    window.requestAnimationFrame(() => { area.scrollLeft = Math.max(0, left * next - 32); area.scrollTop = Math.max(0, top * next - 32); saveView(); });
  }
  async function layer(front: boolean) {
    if (!selected) return;
    await command({ type: 'board.card.layer', id: selected.id, front });
  }
  return <section ref={panel} className="board-panel" aria-label="自由看板" onPaste={event => { if (dialog || busy || ['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement).tagName)) return; const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); void importImages(() => insertFiles(files)); } }}>
    <header className="board-header"><div className="board-heading"><LayoutDashboard size={23} /><h1 ref={headingRef} tabIndex={-1}>我的看板</h1><span>{cards.length} 张贴纸</span><button className="button secondary board-fullscreen-button" aria-label={fullscreen ? '退出看板全屏' : '全屏看板'} title={fullscreen ? '退出全屏 (Esc)' : '全屏看板'} aria-pressed={fullscreen} disabled={fullscreenBusy} onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}<span>{fullscreen ? '退出全屏' : '全屏'}</span></button></div>
      <div className="board-toolbar" aria-label="添加看板内容">
        <button className="button secondary" title="贴上任务" disabled={busy} onClick={() => setDialog({ kind: 'pick', source: 'task' })}><CheckCircle2 size={16} />任务</button>
        <button className="button secondary" title="贴上便签" disabled={busy} onClick={() => setDialog({ kind: 'pick', source: 'note' })}><StickyNote size={16} />便签</button>
        <button className="button secondary" title="添加文字 / 标语" disabled={busy} onClick={() => setDialog({ kind: 'edit' })}><Type size={16} />文字 / 标语</button>
        <button className="button secondary" title="添加图片" disabled={busy} onClick={() => void importImages(() => pickImage('card'))}><ImageIcon size={16} />图片</button>
        <button className="button secondary board-background-button" title="自定义背景" disabled={busy} onClick={() => setDialog({ kind: 'background' })}><Wallpaper size={16} />背景</button>
      </div>
    </header>
    <div className="board-selection-bar">
      {selected ? <><span className="board-selection-title" title={boardCardTitle(selected, state.workspace)}>{boardCardTitle(selected, state.workspace)}</span>
        <button className="icon-button" aria-label="打开选中贴纸" title="打开 / 编辑" disabled={busy} onClick={() => open(selected)}><ArrowUpRight size={17} /></button>
        <button className="icon-button" aria-label="贴纸样式" title="贴纸样式" disabled={busy} onClick={() => setDialog({ kind: 'edit', card: selected })}><Palette size={17} /></button>
        <button className="icon-button" aria-label="置于顶层" title="置于顶层" disabled={busy} onClick={() => void execute(() => layer(true))}><ArrowUpToLine size={17} /></button>
        <button className="icon-button" aria-label="置于底层" title="置于底层" disabled={busy} onClick={() => void execute(() => layer(false))}><ArrowDownToLine size={17} /></button>
        <button className="icon-button" aria-label="从看板移除" title="从看板移除（可撤销）" disabled={busy} onClick={() => void execute(() => remove(selected))}><X size={17} /></button></>
        : <span className="board-help">文字直接拖动、双击编辑 · 其他贴纸拖动顶部 · 空白处拖动浏览</span>}
      {busy && <span className="board-busy" role="status">处理中…</span>}
    </div>
    {state.folder.error && <div className="board-folder-warning" role="status">{state.folder.error}</div>}
    <div className={`board-frame ${dropping ? 'file-over' : ''}`} style={{ backgroundColor: background.backgroundColor }}
      onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; setDropping(true); } }}
      onDragLeave={event => { if (event.dataTransfer.types.includes('Files') && --dragDepth.current <= 0) { dragDepth.current = 0; setDropping(false); } }}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy'; } }}
      onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDropping(false); const rect = event.currentTarget.getBoundingClientRect(); const origin = { x: (event.clientX - rect.left + (viewport.current?.scrollLeft ?? 0)) / zoom, y: (event.clientY - rect.top + (viewport.current?.scrollTop ?? 0)) / zoom }; void importImages(() => insertFiles([...event.dataTransfer.files], origin)); }}>
      {background.backgroundId && <div className="board-wallpaper"><BoardImage id={background.backgroundId} name="背景图片" fit={background.backgroundFit} revision={state.folder.lastRead} /><div className="board-wallpaper-dim" style={{ opacity: background.backgroundDim }} /></div>}
      <div ref={viewport} className="board-viewport" tabIndex={0} aria-label="看板画布" onScroll={saveView}
        onPointerDown={event => {
          if (event.button !== 0 || (event.target as HTMLElement).closest('.board-card')) return;
          event.preventDefault(); setSelectedId(null); event.currentTarget.focus({ preventScroll: true });
          pan.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop }; event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={event => { if (pan.current) { event.currentTarget.scrollLeft = pan.current.left + pan.current.x - event.clientX; event.currentTarget.scrollTop = pan.current.top + pan.current.y - event.clientY; } }}
        onPointerUp={event => { if (!pan.current) return; pan.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { pan.current = null; }} onLostPointerCapture={() => { pan.current = null; }}>
        <div className="board-canvas-extent" style={{ width: BOARD_SIZE * zoom, height: BOARD_SIZE * zoom }}><div className="board-canvas" style={{ width: BOARD_SIZE, height: BOARD_SIZE, transform: `scale(${zoom})` }}>
          {cards.map(card => <BoardCard key={card.id} card={card} workspace={state.workspace} zoom={zoom} selected={card.id === selectedId} revision={state.folder.lastRead} command={command} select={() => setSelectedId(card.id)} open={() => open(card)} remove={() => void execute(() => remove(card))} report={toast} />)}
        </div></div>
      </div>
      {!cards.length && <div className="board-empty"><LayoutDashboard size={36} strokeWidth={1.4} /><h2>把想做的、想记的，贴在这里</h2><p>从上方添加任务、便签和标语<br />图片也可以直接拖入或粘贴</p><button className="button primary" disabled={busy} onClick={() => setDialog({ kind: 'edit' })}><Plus size={16} />贴上第一句话</button></div>}
      {dropping && <div className="board-drop-hint">松开鼠标，添加图片</div>}
    </div>
    <footer className="board-footer"><span>支持拖入或粘贴图片</span><div className="board-zoom"><button className="icon-button" aria-label="缩小看板" disabled={zoom <= 0.1} onClick={() => changeZoom(Math.round((zoom - 0.1) * 100) / 100)}><Minus size={15} /></button><button className="board-zoom-value" title="看板缩放，点击恢复 100%" aria-label="重置看板缩放" onClick={() => changeZoom(1)}>{Math.round(zoom * 100)}%</button><button className="icon-button" aria-label="放大看板" disabled={zoom >= 2} onClick={() => changeZoom(Math.round((zoom + 0.1) * 100) / 100)}><Plus size={15} /></button><button className="text-button" onClick={fit}><Maximize size={14} />查看全部</button></div></footer>
    {dialog?.kind === 'pick' && <SourcePicker source={dialog.source} state={state} busy={busy} close={() => setDialog(null)} create={() => setDialog({ kind: 'source', source: dialog.source })} pin={id => void execute(async () => {
      const existing = cards.find(card => (card.values.content.kind === dialog.source) && 'sourceId' in card.values.content && card.values.content.sourceId === id);
      if (existing) { setDialog(null); reveal(existing.id); return; }
      const next = await command({ type: 'board.card.add', content: { kind: dialog.source, sourceId: id }, layout: placement() }); setDialog(null); added(next);
    })} />}
    {dialog?.kind === 'source' && <SourceEditor source={dialog.source} busy={busy} close={() => setDialog({ kind: 'pick', source: dialog.source })} save={(title, content) => void execute(async () => { const next = await command({ type: 'board.source.add', kind: dialog.source, title, content, layout: placement() }); setDialog(null); added(next); })} />}
    {dialog?.kind === 'edit' && <CardEditor card={dialog.card} busy={busy} close={() => setDialog(null)} save={(content, style) => void execute(async () => {
      if (dialog.card) {
        const original = dialog.card.values;
        const patch = Object.fromEntries(Object.entries(style).filter(([key, value]) => value !== original[key as keyof typeof style])) as Partial<CardStyle>;
        await command({ type: 'board.card.update', id: dialog.card.id, patch: { ...patch, ...(content?.kind === 'text' && original.content.kind === 'text' && content.text !== original.content.text ? { content } : {}) } });
      } else { const next = await command({ type: 'board.card.add', content: content!, style, layout: placement(0, { width: 320, height: 220 }) }); added(next); }
      setDialog(null);
    })} />}
    {dialog?.kind === 'background' && <BackgroundEditor background={background} busy={busy} close={() => setDialog(null)} pick={choose => void execute(async () => { const result = await api.pickBoardImage({ destination: 'background' }); if (result) choose(result.assetId); })} save={patch => void execute(async () => { await command({ type: 'board.update', patch }); setDialog(null); })} />}
  </section>;
}

function SourcePicker({ source, state, busy, close, create, pin }: { source: 'task' | 'note'; state: AppState; busy: boolean; close: () => void; create: () => void; pin: (id: string) => void }) {
  const [query, setQuery] = useState(''); const [limit, setLimit] = useState(60);
  const label = source === 'task' ? '任务' : '便签';
  const all = (source === 'task' ? state.workspace.tasks : state.workspace.notes).filter(item => !item.values.deleted);
  const pinned = new Set(state.workspace.boardCards.filter(card => !card.values.deleted && card.values.content.kind === source).map(card => 'sourceId' in card.values.content ? card.values.content.sourceId : ''));
  const filtered = all.filter(item => `${item.values.title}\n${'notes' in item.values ? item.values.notes : item.values.content}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort((a, b) => Number(pinned.has(a.id)) - Number(pinned.has(b.id)) || b.values.createdAt.localeCompare(a.values.createdAt));
  return <Modal title={`贴上${label}`} close={close} busy={busy}>
    <div className="board-picker"><div className="board-picker-top"><label className="board-picker-search"><Search size={16} /><input autoFocus value={query} onChange={event => { setQuery(event.target.value); setLimit(60); }} aria-label={`搜索${label}`} placeholder={`搜索${label}`} /></label><button className="button secondary" disabled={busy} onClick={create}><Plus size={15} />新建{label}</button></div>
      <p className="board-dialog-hint">贴上后会显示原{label}的最新内容。</p>
      <div className="board-source-list">{filtered.slice(0, limit).map(item => <button key={item.id} disabled={busy} className="board-source-option" onClick={() => pin(item.id)}><span><strong>{item.values.title || '无标题便签'}</strong><small>{'completed' in item.values && item.values.completed ? '已完成 · ' : ''}{('notes' in item.values ? item.values.notes : item.values.content).slice(0, 100) || `点击贴到看板`}</small></span><span className="board-source-action">{pinned.has(item.id) ? '定位贴纸' : '贴到看板'}</span></button>)}
        {!filtered.length && <p className="board-picker-empty">{query ? `没有匹配的${label}` : `还没有${label}，可以先新建一个。`}</p>}
        {filtered.length > limit && <button className="text-button" onClick={() => setLimit(value => value + 60)}>显示更多</button>}
      </div>
    </div>
  </Modal>;
}
function SourceEditor({ source, busy, close, save }: { source: 'task' | 'note'; busy: boolean; close: () => void; save: (title: string, content: string) => void }) {
  const [title, setTitle] = useState(''), [content, setContent] = useState('');
  return <Modal title={`新建${source === 'task' ? '任务' : '便签'}并贴到看板`} close={close} busy={busy}><form className="board-form" onSubmit={event => { event.preventDefault(); save(title.trim(), content); }}>
    <label>{source === 'task' ? '任务名称' : '便签标题（选填）'}<input autoFocus required={source === 'task'} maxLength={200} value={title} onChange={event => setTitle(event.target.value)} disabled={busy} /></label>
    {source === 'note' && <label>便签内容<textarea rows={6} maxLength={100000} value={content} onChange={event => setContent(event.target.value)} disabled={busy} /></label>}
    <p className="board-dialog-hint">{source === 'task' ? '同时保存到“任务”清单。' : '同时保存到“桌面便签”，可随时打开编辑。'}</p>
    <div className="form-footer"><button type="button" className="button secondary" disabled={busy} onClick={close}>返回</button><button className="button primary" disabled={busy || !(title.trim() || (source === 'note' && content.trim()))}>创建并贴上</button></div>
  </form></Modal>;
}
function CardEditor({ card, busy, close, save }: { card?: Card; busy: boolean; close: () => void; save: (content: BoardContent | undefined, style: CardStyle) => void }) {
  const textCard = !card || card.values.content.kind === 'text';
  const [text, setText] = useState(card?.values.content.kind === 'text' ? card.values.content.text : '');
  const [style, setStyle] = useState<CardStyle>(() => card ? { color: card.values.color, textColor: card.values.textColor, fontSize: card.values.fontSize, align: card.values.align as CardStyle['align'], imageFit: card.values.imageFit as CardStyle['imageFit'] } : { ...defaultCardStyle });
  return <Modal title={!card ? '添加文字 / 标语' : textCard ? '编辑文字 / 标语' : '贴纸样式'} close={close} busy={busy}><form className="board-form" onSubmit={event => { event.preventDefault(); if (textCard && !text.trim()) return; save(textCard ? { kind: 'text', text: text.trim() } : undefined, style); }}>
    {textCard && <label>文字内容<textarea autoFocus required maxLength={10000} rows={5} placeholder="写一句鼓励自己的话，或记下灵感…" value={text} disabled={busy} onChange={event => setText(event.target.value)} /></label>}
    {textCard && <fieldset className="board-color-presets"><legend>背景预设</legend><div className="board-color-options">{textBackgrounds.map(option => <button key={option.color} type="button" aria-label={`${option.name}背景`} aria-pressed={style.color.toLowerCase() === option.color} disabled={busy} onClick={() => setStyle(value => ({ ...value, color: option.color }))}><span className="board-color-swatch" style={{ backgroundColor: option.color }}>{style.color.toLowerCase() === option.color && <Check size={16} />}</span><span>{option.name}</span></button>)}</div></fieldset>}
    <div className="board-form-row"><label>{textCard ? '自定义背景' : '贴纸颜色'}<input type="color" value={style.color} disabled={busy} onChange={event => setStyle(value => ({ ...value, color: event.target.value }))} /></label><label>文字颜色<input type="color" value={style.textColor} disabled={busy} onChange={event => setStyle(value => ({ ...value, textColor: event.target.value }))} /></label></div>
    {textCard && <div className="board-form-row"><label>字号<input type="number" min={14} max={96} required value={style.fontSize} disabled={busy} onChange={event => setStyle(value => ({ ...value, fontSize: Number(event.target.value) }))} /></label><label>文字对齐<select value={style.align} disabled={busy} onChange={event => setStyle(value => ({ ...value, align: event.target.value as CardStyle['align'] }))}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label></div>}
    {card?.values.content.kind === 'image' && <label>图片显示<select value={style.imageFit} disabled={busy} onChange={event => setStyle(value => ({ ...value, imageFit: event.target.value as CardStyle['imageFit'] }))}><option value="contain">完整显示</option><option value="cover">填满卡片（可能裁切）</option></select></label>}
    <div className="form-footer"><button type="button" className="button secondary" disabled={busy} onClick={close}>取消</button><button className="button primary" disabled={busy || (textCard && !text.trim())}>{busy ? '保存中…' : card ? '保存修改' : '贴到看板'}</button></div>
  </form></Modal>;
}
function BackgroundEditor({ background, busy, close, pick, save }: { background: BoardValues; busy: boolean; close: () => void; pick: (choose: (id: string) => void) => void; save: (patch: Partial<BoardValues>) => void }) {
  const [initial] = useState(background);
  const [style, setStyle] = useState(initial);
  return <Modal title="看板背景" close={close} busy={busy}><form className="board-form" onSubmit={event => { event.preventDefault(); save(Object.fromEntries(Object.entries(style).filter(([key, value]) => value !== initial[key as keyof BoardValues]))); }}>
    <p className="board-dialog-hint">选择自己喜欢的图片。支持 PNG、JPEG、GIF、WebP，单张不超过 10 MB。</p>
    <div className="board-form-row"><button type="button" className="button secondary" disabled={busy} onClick={() => pick(id => setStyle(value => ({ ...value, backgroundId: id })))}><ImageIcon size={16} />{style.backgroundId ? '更换背景图片' : '选择背景图片'}</button>{style.backgroundId && <button type="button" className="text-button" disabled={busy} onClick={() => setStyle(value => ({ ...value, backgroundId: null }))}>移除图片</button>}</div>
    {style.backgroundId && <div className="board-background-preview" style={{ backgroundColor: style.backgroundColor }}><BoardImage id={style.backgroundId} name="背景预览" fit={style.backgroundFit} revision={null} /><div style={{ opacity: style.backgroundDim }} /></div>}
    <label>背景颜色<input type="color" value={style.backgroundColor} disabled={busy} onChange={event => setStyle(value => ({ ...value, backgroundColor: event.target.value }))} /></label>
    {style.backgroundId && <><label>背景显示<select value={style.backgroundFit} disabled={busy} onChange={event => setStyle(value => ({ ...value, backgroundFit: event.target.value as BoardValues['backgroundFit'] }))}><option value="cover">铺满看板（可能裁切）</option><option value="contain">完整显示</option></select></label><label>背景调暗 {Math.round(style.backgroundDim * 100)}%<input type="range" min={0} max={0.8} step={0.05} value={style.backgroundDim} disabled={busy} onChange={event => setStyle(value => ({ ...value, backgroundDim: Number(event.target.value) }))} /></label></>}
    <div className="form-footer"><button type="button" className="button secondary" disabled={busy} onClick={close}>取消</button><button className="button primary" disabled={busy}>应用背景</button></div>
  </form></Modal>;
}
