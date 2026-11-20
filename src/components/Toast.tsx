import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info, X } from 'lucide-react';

export type ToastMessage = { text: string; undo?: () => void };

export default function Toast({ message, close }: { message: ToastMessage; close: () => void }) {
  const [host, setHost] = useState<Element>(document.body);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const element = useRef<HTMLDivElement>(null);
  const [bottom, setBottom] = useState(84);
  useLayoutEffect(() => {
    // A modal makes the rest of the document inert. Its feedback must live inside it.
    const update = () => setHost([...document.querySelectorAll('dialog[open]')].at(-1) ?? document.body);
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    setHovered(element.current?.matches(':hover') ?? false);
    setFocused(element.current?.contains(document.activeElement) ?? false);
  }, [host, message]);
  useLayoutEffect(() => {
    if (host !== document.body) return;
    const composer = document.querySelector('.composer-wrap');
    const measure = () => setBottom(composer ? window.innerHeight - composer.getBoundingClientRect().top + 8 : 24);
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (composer) observer?.observe(composer);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [host]);
  useEffect(() => {
    if (hovered || focused) return;
    const timer = setTimeout(close, message.undo ? 10000 : 6000);
    return () => clearTimeout(timer);
  }, [message, close, hovered, focused]);
  return createPortal(<div ref={element} className="toast" role="status" style={host === document.body ? { bottom } : undefined} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <Info size={17} /><span>{message.text}</span>{message.undo && <button onClick={message.undo}>撤销</button>}
    <button aria-label="关闭提示" onClick={close}><X size={15} /></button>
  </div>, host);
}
