import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowUpRight, Check, GripHorizontal, MoveDiagonal2, StickyNote, Image as ImageIcon, CheckCircle2 } from 'lucide-react';
import { FieldDraft, registerMainDraft } from '../notes/draft';
import { boardCardTitle, boardSize, clampBoardLayout, resizeBoardLayout, type BoardCard as Card, type BoardLayout } from '../shared/board';
import type { AppState, Command, Workspace } from '../shared/model';
import { isComposing } from '../components/keyboard';
import BoardImage from './BoardImage';

type Props = { card: Card; workspace: Workspace; zoom: number; selected: boolean; revision: string | null;
  command: (command: Command) => Promise<AppState>; select: () => void; open: () => void; remove: () => void; report: (text: string) => void };
export default function BoardCard({ card, workspace, zoom, selected, revision, command, select, open, remove, report }: Props) {
  const bounds = boardSize(workspace);
  const commandRef = useRef(command); commandRef.current = command;
  const [draft] = useState(() => new FieldDraft({ layout: card.values.layout }, async patch => {
    const next = await commandRef.current({ type: 'board.card.update', id: card.id, patch });
    const saved = next.workspace.boardCards.find(item => item.id === card.id);
    if (!saved) throw new Error('卡片已被永久删除。');
    return { layout: saved.values.layout };
  }));
  const snapshot = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
  useEffect(() => draft.receive({ layout: card.values.layout }), [draft, card.values.layout]);
  useEffect(() => registerMainDraft(draft), [draft]);
  useEffect(() => () => { void draft.flush().catch(() => {}); draft.dispose(); }, [draft]);
  const [preview, setPreview] = useState<BoardLayout | null>(null);
  const gesture = useRef<{ x: number; y: number; layout: BoardLayout; resize: boolean; next: BoardLayout } | null>(null);
  const [completing, setCompleting] = useState(false);
  const layout = clampBoardLayout(preview ?? snapshot.values.layout, bounds);
  const content = card.values.content;
  const task = content.kind === 'task' ? workspace.tasks.find(item => item.id === content.sourceId && !item.values.deleted) : undefined;
  const note = content.kind === 'note' ? workspace.notes.find(item => item.id === content.sourceId && !item.values.deleted) : undefined;
  const missing = (content.kind === 'task' && !task) || (content.kind === 'note' && !note);
  const title = boardCardTitle(card, workspace);
  const Icon = content.kind === 'task' ? CheckCircle2 : content.kind === 'note' ? StickyNote : ImageIcon;
  const kindName = { task: '任务', note: '便签', text: '文字', image: '图片' }[content.kind];
  function start(event: PointerEvent<HTMLElement>, resize: boolean) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); select(); event.currentTarget.focus({ preventScroll: true });
    gesture.current = { x: event.clientX, y: event.clientY, layout, resize, next: layout };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLElement>) {
    const start = gesture.current; if (!start) return;
    const dx = (event.clientX - start.x) / zoom, dy = (event.clientY - start.y) / zoom;
    start.next = start.resize ? resizeBoardLayout(start.layout, start.layout.width + dx, start.layout.height + dy, bounds) : clampBoardLayout({ ...start.layout, x: start.layout.x + dx, y: start.layout.y + dy }, bounds);
    setPreview(start.next);
  }
  function end(event: PointerEvent<HTMLElement>, save: boolean) {
    if (!gesture.current) return;
    if (save) draft.change('layout', gesture.current.next);
    gesture.current = null; setPreview(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function keyboard(event: KeyboardEvent<HTMLElement>, resize = false) {
    if (isComposing(event.nativeEvent)) return;
    if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); gesture.current = null; setPreview(null); return; }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? 50 : 10;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    draft.change('layout', resize ? resizeBoardLayout(layout, layout.width + dx, layout.height + dy, bounds) : clampBoardLayout({ ...layout, x: layout.x + dx, y: layout.y + dy }, bounds));
  }
  return <article data-card-id={card.id} className={`board-card ${selected ? 'selected' : ''} ${preview ? 'moving' : ''} board-kind-${content.kind}`} tabIndex={0} aria-label={`${kindName}贴纸：${title}`} aria-describedby={`board-card-help-${card.id}`}
    style={{ left: layout.x, top: layout.y, width: layout.width, height: layout.height, zIndex: card.values.z, backgroundColor: card.values.color, color: card.values.textColor } as CSSProperties}
    onClick={event => { event.stopPropagation(); select(); }} onFocus={select} onKeyDown={event => {
      if (event.target !== event.currentTarget || isComposing(event.nativeEvent)) return;
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); remove(); }
      else if (event.key === 'Enter') { event.preventDefault(); open(); }
      else keyboard(event);
    }}>
    <span className="sr-only" id={`board-card-help-${card.id}`}>方向键移动，Shift 加方向键快速移动，Enter 打开，Delete 从看板移除。</span>
    {content.kind !== 'text' && <header className="board-card-header">
      <button className="board-drag-handle" aria-label={`移动${kindName}贴纸：${title}`} title="拖动移动；方向键微调，Shift 加速" onPointerDown={event => start(event, false)} onPointerMove={move} onPointerUp={event => end(event, true)} onPointerCancel={event => end(event, false)} onLostPointerCapture={event => end(event, false)} onKeyDown={event => keyboard(event)}><Icon size={14} /><span>{kindName}</span><GripHorizontal size={18} /></button>
      {!missing && content.kind !== 'image' && <button className="board-card-open icon-button" aria-label={`打开${kindName}：${title}`} title={`打开${kindName}`} onClick={open}><ArrowUpRight size={16} /></button>}
    </header>}
    {content.kind === 'image' ? <div className="board-card-image"><BoardImage id={content.assetId} name={content.name || '图片'} fit={card.values.imageFit} revision={revision} /></div>
      : content.kind === 'text' ? <div className="board-card-text" role="button" tabIndex={0} aria-label={`移动或编辑文字：${title}`} title="拖动移动，双击或按 Enter 编辑" style={{ fontSize: card.values.fontSize, textAlign: card.values.align }}
        onPointerDown={event => start(event, false)} onPointerMove={move} onPointerUp={event => end(event, true)} onPointerCancel={event => end(event, false)} onLostPointerCapture={event => end(event, false)} onDoubleClick={open}
        onKeyDown={event => { if (isComposing(event.nativeEvent)) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); open(); } else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); remove(); } else keyboard(event); }}>{content.text}</div>
      : missing ? <div className="board-missing"><strong>{title}</strong><p>可在回收站恢复原内容，或移除此贴纸。</p></div>
      : <div className="board-card-body" onDoubleClick={open}>
        <div className="board-source-heading">{task && <button className={`board-complete ${task.values.completed ? 'checked' : ''}`} disabled={completing} aria-label={task.values.completed ? `标记未完成：${title}` : `完成任务：${title}`} aria-pressed={task.values.completed} onDoubleClick={event => event.stopPropagation()} onClick={async event => {
          event.stopPropagation(); setCompleting(true);
          try { await command({ type: 'task.update', id: task.id, patch: { completed: !task.values.completed } }); } catch (error) { report(String(error)); } finally { setCompleting(false); }
        }}>{task.values.completed && <Check size={14} />}</button>}<h2 className={task?.values.completed ? 'done' : ''}>{title}</h2></div>
        <p className="board-source-preview">{task?.values.notes || note?.values.content || (task ? '点击右上角打开任务详情' : '点击右上角编辑便签')}</p>
        {task?.values.dueDate && <span className="board-card-date">截止 {task.values.dueDate}</span>}
      </div>}
    {snapshot.error && <div className="board-save-error" role="alert"><span>位置未保存</span><button onClick={() => void draft.flush().catch(() => {})}>重试</button></div>}
    {(snapshot.dirty || snapshot.saving) && !snapshot.error && <span className="board-saving" role="status">保存中…</span>}
    <button className="board-resize" aria-label={`调整${kindName}贴纸大小：${title}`} title="拖动调整大小；方向键微调" onPointerDown={event => start(event, true)} onPointerMove={move} onPointerUp={event => end(event, true)} onPointerCancel={event => end(event, false)} onLostPointerCapture={event => end(event, false)} onKeyDown={event => keyboard(event, true)}><MoveDiagonal2 size={16} /></button>
  </article>;
}
