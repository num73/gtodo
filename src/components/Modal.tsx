import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export default function Modal({ title, children, close, wide = false, busy = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement;
    ref.current?.showModal();
    return () => { ref.current?.close(); previouslyFocused?.focus(); };
  }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) closeRef.current(); }} onClick={event => { if (event.target === ref.current && !busy) closeRef.current(); }}>
    <div className="modal-inner">
      <header className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="关闭对话框" disabled={busy} onClick={close}><X size={20} /></button></header>
      {children}
    </div>
  </dialog>;
}
