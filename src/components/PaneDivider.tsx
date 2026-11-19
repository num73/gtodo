import { useEffect, useRef } from 'react';

export default function PaneDivider({ label, controls, value, min, max, direction = 1, defaultValue, onChange, onCommit }: {
  label: string; controls: string; value: number; min: number; max: number; defaultValue: number; direction?: 1 | -1;
  onChange: (value: number) => void; onCommit: (value: number) => void;
}) {
  const drag = useRef<{ id: number; x: number; initial: number; value: number } | null>(null);
  const clamp = (next: number) => Math.round(Math.max(min, Math.min(max, next)));
  useEffect(() => () => { if (drag.current) document.body.classList.remove('resizing-panes'); }, []);
  function finish(cancel = false) {
    const current = drag.current; if (!current) return;
    drag.current = null; document.body.classList.remove('resizing-panes');
    const next = cancel ? current.initial : current.value;
    onChange(next); if (!cancel) onCommit(next);
  }
  return <div className="pane-divider" role="separator" aria-label={label} aria-orientation="vertical" aria-controls={controls}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)} tabIndex={0} title="拖动调整宽度，双击恢复"
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, initial: value, value };
      document.body.classList.add('resizing-panes');
    }}
    onPointerMove={event => {
      const current = drag.current; if (!current || current.id !== event.pointerId) return;
      current.value = clamp(current.initial + (event.clientX - current.x) * direction); onChange(current.value);
    }}
    onPointerUp={event => { if (drag.current?.id === event.pointerId) { finish(); event.currentTarget.releasePointerCapture(event.pointerId); } }}
    onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish()}
    onDoubleClick={() => { const next = clamp(defaultValue); onChange(next); onCommit(next); }}
    onKeyDown={event => {
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); finish(true); return; }
      const next = event.key === 'Home' ? defaultValue : event.key === 'End' ? max
        : event.key === 'ArrowLeft' ? value - direction * (event.shiftKey ? 40 : 10)
        : event.key === 'ArrowRight' ? value + direction * (event.shiftKey ? 40 : 10) : null;
      if (next === null) return;
      event.preventDefault(); const bounded = clamp(next); onChange(bounded); onCommit(bounded);
    }} />;
}
