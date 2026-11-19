import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Circle, List, Star, Sun, Timer, Trash2 } from 'lucide-react';
import type { Task } from '../shared/model';

export type TaskMenuAction = 'complete' | 'day' | 'important' | 'details' | 'focus' | 'delete';

export default function TaskContextMenu({ x, y, task, today, close, action }: {
  x: number; y: number; task: Task; today: string;
  close: (restoreFocus?: boolean) => void; action: (action: TaskMenuAction) => void;
}) {
  const value = task.values;
  const menu = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close); closeRef.current = close;
  const [position, setPosition] = useState({ x, y });
  useLayoutEffect(() => {
    const bounds = menu.current!.getBoundingClientRect();
    setPosition({ x: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)), y: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)) });
    if (!menu.current?.contains(document.activeElement)) menu.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [x, y, value.completed]);
  useEffect(() => {
    const outside = (event: Event) => { if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) closeRef.current(); };
    const dismiss = () => closeRef.current();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('contextmenu', outside, true);
    window.addEventListener('scroll', outside, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('contextmenu', outside, true);
      window.removeEventListener('scroll', outside, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, []);
  return createPortal(<div ref={menu} className="task-context-menu" role="menu" aria-label="任务操作" style={{ left: position.x, top: position.y }}
    onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      if (event.key === 'Tab') close(true);
      if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const items = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)'));
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : event.key === 'ArrowDown' ? (current + 1) % items.length : current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
        items[next]?.focus();
      }
    }}>
    <button type="button" role="menuitem" onClick={() => action('complete')}>
      {value.completed ? <Circle size={16} /> : <Check size={16} />}{value.completed ? '标记为未完成' : '标记为已完成'}
    </button>
    <button type="button" role="menuitem" onClick={() => action('day')}><Sun size={16} />{value.myDay === today ? '从我的一天移除' : '添加到我的一天'}</button>
    <button type="button" role="menuitem" onClick={() => action('important')}><Star size={16} fill={value.important ? 'currentColor' : 'none'} />{value.important ? '取消重要标记' : '标记为重要'}</button>
    <div className="task-menu-divider" role="separator" />
    <button type="button" role="menuitem" onClick={() => action('details')}><List size={16} />打开任务详情</button>
    {!value.completed && <button type="button" role="menuitem" onClick={() => action('focus')}><Timer size={16} />专注此任务</button>}
    <div className="task-menu-divider" role="separator" />
    <button type="button" role="menuitem" className="danger-text" onClick={() => action('delete')}><Trash2 size={16} />删除任务</button>
  </div>, document.body);
}
