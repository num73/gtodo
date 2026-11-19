import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopAPI } from '../shared/model';
import { remainingTime, type PomodoroCommand, type PomodoroSession, type PomodoroSnapshot } from '../shared/pomodoro';

export function usePomodoro(api: DesktopAPI | undefined) {
  const [snapshot, setSnapshot] = useState<PomodoroSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    const off = api.onPomodoro(value => { if (alive) setSnapshot(value); });
    api.getPomodoro().then(value => { if (alive) setSnapshot(value); }).catch(() => { if (alive) setError('无法读取番茄钟，请重启应用。'); });
    return () => { alive = false; off(); };
  }, [api]);
  const run = useCallback(async (command: PomodoroCommand) => {
    if (!api || pending.current) return false;
    pending.current = true; setBusy(true); setError('');
    try { setSnapshot(await api.pomodoroCommand(command)); return true; }
    catch (error) { setError((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); return false; }
    finally { pending.current = false; setBusy(false); }
  }, [api]);
  return { snapshot, error, busy, run };
}
export type PomodoroController = ReturnType<typeof usePomodoro>;

export function useCountdown(session: PomodoroSession | undefined) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (session?.status !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [session?.status, session?.endsAt]);
  return session ? remainingTime(session, now) : 0;
}
