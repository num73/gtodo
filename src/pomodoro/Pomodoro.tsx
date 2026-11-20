import { useEffect, useState, type FormEvent } from 'react';
import { Timer, Pause, Play, RotateCcw } from 'lucide-react';
import type { Task } from '../shared/model';
import { formatCountdown, phaseLabels, pomodoroPhases, type PomodoroSettings, type PomodoroSnapshot } from '../shared/pomodoro';
import { useCountdown, type PomodoroController } from './usePomodoro';

export function PomodoroLauncher({ state, open }: { state: PomodoroSnapshot | null; open: () => void }) {
  const remaining = useCountdown(state?.session);
  const active = state?.session.status !== 'idle' && !!state;
  return <button className={`desktop-notes-button pomodoro-launcher ${active ? 'is-active' : ''}`} aria-label="打开番茄钟" title={active ? `${phaseLabels[state.session.phase]} · ${formatCountdown(remaining)}${state.session.status === 'paused' ? ' · 已暂停' : ''}` : '番茄钟'} onClick={open}>
    {state?.session.status === 'paused' ? <Pause size={18} /> : <Timer size={18} />}<span>番茄钟</span>{active && <small>{formatCountdown(remaining)}</small>}
  </button>;
}

export default function Pomodoro({ controller, tasks }: { controller: PomodoroController; tasks: Task[] }) {
  const { snapshot, busy, error, run } = controller;
  const remaining = useCountdown(snapshot?.session);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<PomodoroSettings | null>(snapshot?.settings ?? null);
  useEffect(() => { if (snapshot) setDraft(snapshot.settings); }, [snapshot?.settings]);
  const session = snapshot?.session;
  const active = session?.status !== 'idle';
  const disabled = busy || snapshot?.unavailable;
  const pendingTasks = tasks.filter(task => !task.values.completed && !task.values.deleted);
  async function saveSettings(event: FormEvent) {
    event.preventDefault(); if (draft && await run({ type: 'configure', settings: draft })) setSettingsOpen(false);
  }
  return <section className="pomodoro-content" aria-label="番茄钟计时">
    {snapshot && session && <div className="pomodoro-body">
      <div className="pomodoro-timer">
        <div className="pomodoro-modes" role="group" aria-label="计时模式">{pomodoroPhases.map(phase => <button key={phase} aria-pressed={session.phase === phase} disabled={disabled || active} onClick={() => void run({ type: 'select', phase })}>{phaseLabels[phase]}</button>)}</div>
        <div className="pomodoro-clock">
          <p className="pomodoro-status" role="status">{session.status === 'paused' ? '已暂停' : session.status === 'running' ? `${phaseLabels[session.phase]}中` : snapshot.lastCompleted ? `${phaseLabels[snapshot.lastCompleted.phase]}已完成` : `准备${phaseLabels[session.phase]}`}</p>
          <div className="pomodoro-time" role="timer" aria-label="剩余时间" aria-live="off">{formatCountdown(remaining)}</div>
          <div className="pomodoro-progress" role="progressbar" aria-label="本次进度" aria-valuenow={Math.floor((1 - remaining / session.durationMs) * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${(1 - remaining / session.durationMs) * 100}%` }} /></div>
        </div>
        <div className="pomodoro-controls">
          <button className="button primary" disabled={disabled} onClick={() => void run({ type: session.status === 'running' ? 'pause' : 'start' })}>{session.status === 'running' ? <Pause size={17} /> : <Play size={17} />}{session.status === 'running' ? '暂停' : session.status === 'paused' ? '继续' : `开始${phaseLabels[session.phase]}`}</button>
          <button className="button secondary" disabled={disabled || !active} onClick={() => void run({ type: 'reset' })}><RotateCcw size={16} />重置</button>
        </div>
      </div>
      <div className="pomodoro-details">
        <label className="pomodoro-task">关联任务<select aria-label="番茄钟关联任务" value={session.task?.id ?? ''} disabled={disabled || active || session.phase !== 'focus'} onChange={event => void run({ type: 'select', taskId: event.target.value || null })}>
          <option value="">不关联任务</option>
          {session.task && !pendingTasks.some(task => task.id === session.task!.id) && <option value={session.task.id}>{session.task.title}（已完成或删除）</option>}
          {pendingTasks.map(task => <option key={task.id} value={task.id}>{task.values.title}</option>)}
        </select></label>
        <div className="pomodoro-stats"><span>今天 <strong>{snapshot.today.completed}</strong> 个番茄 · <strong>{Math.round(snapshot.today.minutes)}</strong> 分钟</span><span>本轮 {snapshot.cycleCompleted}/{snapshot.settings.longBreakEvery}</span></div>
        <button className="text-button pomodoro-settings-toggle" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}>时长设置</button>
        {settingsOpen && draft && <form className="pomodoro-settings" onSubmit={saveSettings}>
          <fieldset disabled={disabled || active}>
            <label>专注（分钟）<input type="number" aria-label="专注分钟数" min={1} max={180} required value={Number.isNaN(draft.focusMinutes) ? '' : draft.focusMinutes} onChange={event => setDraft({ ...draft, focusMinutes: event.target.valueAsNumber })} /></label>
            <label>短休息（分钟）<input type="number" aria-label="短休息分钟数" min={1} max={60} required value={Number.isNaN(draft.shortBreakMinutes) ? '' : draft.shortBreakMinutes} onChange={event => setDraft({ ...draft, shortBreakMinutes: event.target.valueAsNumber })} /></label>
            <label>长休息（分钟）<input type="number" aria-label="长休息分钟数" min={1} max={60} required value={Number.isNaN(draft.longBreakMinutes) ? '' : draft.longBreakMinutes} onChange={event => setDraft({ ...draft, longBreakMinutes: event.target.valueAsNumber })} /></label>
            <label>长休息间隔（次）<input type="number" aria-label="长休息间隔次数" min={2} max={12} required value={Number.isNaN(draft.longBreakEvery) ? '' : draft.longBreakEvery} onChange={event => setDraft({ ...draft, longBreakEvery: event.target.valueAsNumber })} /></label>
          </fieldset>
          {active ? <p className="setting-description">重置后可修改时长。</p> : <button className="button secondary" disabled={disabled}>保存时长</button>}
        </form>}
        <p className="pomodoro-hint">结束后手动开始下一阶段。退出或休眠时暂停。</p>
      </div>
    </div>}
    {!snapshot && !error && <p className="pomodoro-body">加载中…</p>}
    {(error || snapshot?.error) && <p className="inline-error" role="alert">{error || snapshot?.error}</p>}
  </section>;
}
