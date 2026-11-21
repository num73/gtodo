import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export default function ContextMenu({ x, y, label, items, close }: {
  x: number; y: number; label: string; items: { label: string; icon: ReactNode; action: () => void; danger?: boolean; divider?: boolean }[];
  close: (restoreFocus?: boolean) => void;
}) {
  const menu = useRef<HTMLDivElement>(null), latest = useRef(close); latest.current = close;
  const [position, setPosition] = useState({ x, y });
  useLayoutEffect(() => {
    const bounds = menu.current!.getBoundingClientRect();
    setPosition({ x: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)), y: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)) });
    menu.current?.querySelector('button')?.focus({ preventScroll: true });
  }, [x, y]);
  useEffect(() => {
    const outside = (event: Event) => { if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) latest.current(); };
    const dismiss = () => latest.current();
    document.addEventListener('pointerdown', outside, true); document.addEventListener('contextmenu', outside, true);
    window.addEventListener('scroll', outside, true); window.addEventListener('resize', dismiss); window.addEventListener('blur', dismiss);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('contextmenu', outside, true); window.removeEventListener('scroll', outside, true); window.removeEventListener('resize', dismiss); window.removeEventListener('blur', dismiss); };
  }, []);
  return createPortal(<div ref={menu} className="task-context-menu" role="menu" aria-label={label} style={{ left: position.x, top: position.y }} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    if (event.isPropagationStopped() || event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(true); }
    if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (index + 1) % buttons.length : index < 0 ? buttons.length - 1 : (index + buttons.length - 1) % buttons.length;
      buttons[next]?.focus();
    }
  }}>{items.map(item => <div key={item.label}>{item.divider && <div role="separator" className="task-menu-divider" />}<button type="button" role="menuitem" className={item.danger ? 'danger-text' : undefined} onClick={() => { close(); item.action(); }}>{item.icon}{item.label}</button></div>)}</div>, document.body);
}
