import { useEffect, useState } from 'react';
import { ArrowUpRight, Pin, PinOff, Timer, X } from 'lucide-react';
import type { AppState } from '../shared/model';
import Pomodoro from './Pomodoro';
import { usePomodoro } from './usePomodoro';

export default function PomodoroWindow() {
  const api = window.gtodo;
  const controller = usePomodoro(api);
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!api) return;
    let active = true;
    const off = api.onState(value => { if (active) setState(value); });
    api.getState().then(value => { if (active) setState(value); }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; off(); };
  }, [api]);
  async function execute(action: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await action(); setState(await api!.getState()); }
    catch (error) { setError((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    finally { setBusy(false); }
  }
  const pinned = state?.pomodoroWindow.pinned ?? false;
  return <main className="pomodoro-window" aria-label="番茄钟窗口">
    <header className="pomodoro-dragbar" title="拖动以移动番茄钟">
      <span><Timer size={15} />番茄钟</span>
      <div className="pomodoro-window-controls">
        <button aria-label="打开 GTodo 主窗口" title="打开 GTodo" onClick={() => void execute(() => api!.showMain())}><ArrowUpRight size={16} /></button>
        <button aria-label={pinned ? '取消番茄钟置顶' : '番茄钟置顶'} title={pinned ? '取消置顶' : '置顶'} aria-pressed={pinned} disabled={busy} onClick={() => void execute(() => api!.pomodoroWindow({ type: 'pin', pinned: !pinned }))}>{pinned ? <PinOff size={16} /> : <Pin size={16} />}</button>
        <button aria-label="收起番茄钟" title="收起，计时继续" disabled={busy || controller.busy} onClick={() => void execute(() => api!.pomodoroWindow({ type: 'hide' }))}><X size={18} /></button>
      </div>
    </header>
    <Pomodoro controller={controller} tasks={state?.workspace.tasks ?? []} />
    {error && <p className="inline-error" role="alert">{error}</p>}
  </main>;
}
