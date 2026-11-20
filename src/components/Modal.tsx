import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { isComposing } from './keyboard';

export default function Modal({ title, children, close, wide = false, busy = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement;
    ref.current?.showModal();
    return () => { ref.current?.close(); previouslyFocused?.focus(); };
  }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} aria-label={title}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); if (isComposing(event.nativeEvent)) event.preventDefault(); }
      if (event.key === 'Enter' && isComposing(event.nativeEvent)) event.preventDefault();
    }}
    onCancel={event => { event.preventDefault(); if (!busy) closeRef.current(); }}
    onPointerDown={event => { backdropPress.current = event.target === ref.current; }}
    onClick={event => { if (event.target === ref.current && backdropPress.current && !busy) closeRef.current(); backdropPress.current = false; }}>
    <div className="modal-inner">
      <header className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="关闭对话框" disabled={busy} onClick={close}><X size={20} /></button></header>
      {children}
    </div>
  </dialog>;
}
