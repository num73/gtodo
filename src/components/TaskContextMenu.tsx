import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2 } from 'lucide-react';

export default function TaskContextMenu({ x, y, close, remove }: {
  x: number; y: number; close: (restoreFocus?: boolean) => void; remove: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close); closeRef.current = close;
  const [position, setPosition] = useState({ x, y });
  useLayoutEffect(() => {
    const bounds = menu.current!.getBoundingClientRect();
    setPosition({ x: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)), y: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)) });
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [x, y]);
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
      if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) event.preventDefault();
    }}>
    <button role="menuitem" className="danger-text" onClick={remove}><Trash2 size={16} />删除任务</button>
  </div>, document.body);
}
