import { useEffect, useState, type FormEvent } from 'react';
import { type PomodoroSettings as Settings } from '../shared/pomodoro';
import type { PomodoroController } from './usePomodoro';

export default function PomodoroSettings({ controller, onSaved }: { controller: PomodoroController; onSaved?: () => void }) {
  const { snapshot, busy, run } = controller;
  const [draft, setDraft] = useState<Settings | null>(snapshot?.settings ?? null);
  // Timer ticks publish new snapshots; only changed settings should replace a draft.
  useEffect(() => { if (snapshot) setDraft(snapshot.settings); }, [snapshot?.settings.focusMinutes, snapshot?.settings.shortBreakMinutes, snapshot?.settings.longBreakMinutes, snapshot?.settings.longBreakEvery]);
  if (!snapshot || !draft) return <p className="setting-description">正在读取番茄钟设置…</p>;
  const active = snapshot.session.status !== 'idle';
  const disabled = busy || snapshot.unavailable;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (draft && await run({ type: 'configure', settings: draft })) onSaved?.();
  }
  return <form className="pomodoro-settings" aria-label="番茄钟时长" onSubmit={save}>
    <fieldset disabled={disabled || active}>
      {([
        ['focusMinutes', '专注（分钟）', '专注分钟数', 1, 180],
        ['shortBreakMinutes', '短休息（分钟）', '短休息分钟数', 1, 60],
        ['longBreakMinutes', '长休息（分钟）', '长休息分钟数', 1, 60],
        ['longBreakEvery', '长休息间隔（次）', '长休息间隔次数', 2, 12],
      ] as const).map(([key, title, label, min, max]) => <label key={key}>{title}<input type="number" aria-label={label} min={min} max={max} step={1} required value={Number.isNaN(draft[key]) ? '' : draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.valueAsNumber })} /></label>)}
    </fieldset>
    {active ? <p className="setting-description">当前计时已开始，请在番茄钟中重置后修改时长。</p> : <button className="button secondary" disabled={disabled}>保存时长</button>}
  </form>;
}
