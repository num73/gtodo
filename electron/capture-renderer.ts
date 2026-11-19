import type { CaptureAPI } from '../src/shared/screen-capture';
declare global { interface Window { screenCapture: CaptureAPI } }
const api = window.screenCapture;
const background = document.querySelector<HTMLImageElement>('#screen')!;
const selection = document.querySelector<HTMLDivElement>('#selection')!;
const dimensions = document.querySelector<HTMLDivElement>('#dimensions')!;
const message = document.querySelector<HTMLSpanElement>('#message')!;
let start: { x: number; y: number } | null = null;
let selecting = false;
let busy = false;
let size = { width: 0, height: 0 };
const point = (event: PointerEvent) => ({ x: Math.max(0, Math.min(innerWidth, event.clientX)), y: Math.max(0, Math.min(innerHeight, event.clientY)) });
function rectangle(event: PointerEvent) {
  const end = point(event);
  return { x: Math.min(start!.x, end.x), y: Math.min(start!.y, end.y), width: Math.abs(start!.x - end.x), height: Math.abs(start!.y - end.y) };
}
function reset() { start = null; selecting = false; selection.hidden = true; dimensions.hidden = true; }
function report(error: unknown) { message.textContent = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
document.querySelector('#cancel')!.addEventListener('click', () => { void api.cancel(); });
document.addEventListener('contextmenu', event => { event.preventDefault(); void api.cancel(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); void api.cancel(); } });
document.addEventListener('pointerdown', event => {
  if (event.button !== 0 || busy || (event.target as HTMLElement).closest('#hint')) return;
  start = point(event); selecting = true; selection.hidden = false;
  Object.assign(selection.style, { left: `${start.x}px`, top: `${start.y}px`, width: '0', height: '0' });
  document.documentElement.setPointerCapture(event.pointerId);
});
document.addEventListener('pointermove', event => {
  if (!selecting || !start) return;
  const rect = rectangle(event);
  Object.assign(selection.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  dimensions.hidden = false;
  dimensions.textContent = `${Math.round(rect.width / innerWidth * size.width)} × ${Math.round(rect.height / innerHeight * size.height)}`;
  Object.assign(dimensions.style, { left: `${Math.max(4, Math.min(rect.x, innerWidth - 160))}px`, top: `${rect.y > 30 ? rect.y - 28 : Math.min(innerHeight - 28, rect.y + rect.height + 5)}px` });
});
document.addEventListener('pointerup', event => {
  if (event.button !== 0 || !selecting || !start || busy) return;
  const rect = rectangle(event); selecting = false;
  if (document.documentElement.hasPointerCapture(event.pointerId)) document.documentElement.releasePointerCapture(event.pointerId);
  if (rect.width < 3 || rect.height < 3) { reset(); return; }
  busy = true;
  void api.select({ x: rect.x / innerWidth, y: rect.y / innerHeight, width: rect.width / innerWidth, height: rect.height / innerHeight })
    .catch(error => { report(error); busy = false; reset(); });
});
document.addEventListener('pointercancel', reset);
void (async () => {
  const preview = await api.getPreview(); size = preview;
  background.src = preview.image; await background.decode();
  await api.ready();
})().catch(() => { void api.cancel(); });
