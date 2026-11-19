import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { localDate } from '../src/shared/model';
import { emptyPomodoroData, idleSession, pomodoroCommandSchema, pomodoroDataSchema, remainingTime, type PomodoroCommand, type PomodoroData, type PomodoroSession, type PomodoroSnapshot } from '../src/shared/pomodoro';
import { atomicWrite } from './storage';

interface Options {
  directory: string;
  task: (id: string) => PomodoroSession['task'];
  changed?: (state: PomodoroSnapshot) => void;
  completed?: (completion: NonNullable<PomodoroData['lastCompleted']>) => void;
  now?: () => number;
  write?: typeof atomicWrite;
}
// The main process owns the clock. No renderer ticks or cloud-folder writes are needed.
export class PomodoroTimer {
  readonly file: string;
  private data = emptyPomodoroData();
  private queue: Promise<unknown> = Promise.resolve();
  private error: string | null = null;
  private unavailable = false;
  private lastDay = '';
  private now: () => number;
  private write: typeof atomicWrite;
  constructor(private options: Options) {
    this.file = path.join(options.directory, 'pomodoro.json');
    this.now = options.now ?? Date.now; this.write = options.write ?? atomicWrite;
  }
  async initialize() {
    let missing = 0;
    for (const file of [this.file, `${this.file}.bak`]) {
      try {
        this.data = pomodoroDataSchema.parse(JSON.parse(await readFile(file, 'utf8')));
        if (file !== this.file) await this.write(this.file, JSON.stringify(this.data));
        this.lastDay = localDate(new Date(this.now())); return;
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing++; }
    }
    if (missing === 2) {
      try { await this.write(this.file, JSON.stringify(this.data)); this.lastDay = localDate(new Date(this.now())); return; }
      catch { /* Leave workspace data usable even if timer storage is unavailable. */ }
    }
    this.unavailable = true;
    this.error = `番茄钟数据无法读取或保存，请保留 ${this.file} 及备份，检查后重启应用。`;
  }
  snapshot(): PomodoroSnapshot {
    const date = localDate(new Date(this.now()));
    return structuredClone({ settings: this.data.settings, session: this.data.session, cycleCompleted: this.data.cycleCompleted,
      today: this.data.days.find(day => day.date === date) ?? { date, completed: 0, minutes: 0 },
      lastCompleted: this.data.lastCompleted, error: this.error, unavailable: this.unavailable });
  }
  isActive() { return !this.unavailable && this.data.session.status !== 'idle'; }
  private publish() { this.options.changed?.(this.snapshot()); }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(action);
    this.queue = operation.catch(() => {}); return operation;
  }
  private async commit(next: PomodoroData) {
    pomodoroDataSchema.parse(next);
    try {
      await this.write(`${this.file}.bak`, JSON.stringify(this.data));
      await this.write(this.file, JSON.stringify(next));
    } catch {
      const message = '番茄钟未能保存，请检查磁盘空间和文件权限后重试。';
      if (this.error !== message) { this.error = message; this.publish(); }
      throw new Error(message);
    }
    this.data = next; this.error = null; this.publish();
  }
  private async finishDue(now: number) {
    const current = this.data.session;
    if (current.status !== 'running' || current.endsAt === null || current.endsAt > now) return;
    const next = structuredClone(this.data);
    const completion = { phase: current.phase, at: current.endsAt, taskTitle: current.phase === 'focus' ? current.task?.title ?? null : null };
    if (current.phase === 'focus') {
      const date = localDate(new Date(current.endsAt));
      let day = next.days.find(item => item.date === date);
      if (!day) { day = { date, completed: 0, minutes: 0 }; next.days.push(day); }
      day.completed++; day.minutes += current.durationMs / 60_000;
      next.days = next.days.sort((a, b) => a.date.localeCompare(b.date)).slice(-366);
      next.cycleCompleted = (next.cycleCompleted >= next.settings.longBreakEvery ? 0 : next.cycleCompleted) + 1;
      next.session = idleSession(next.cycleCompleted >= next.settings.longBreakEvery ? 'longBreak' : 'shortBreak', next.settings, current.task);
    } else {
      if (current.phase === 'longBreak') next.cycleCompleted = 0;
      next.session = idleSession('focus', next.settings, current.task);
    }
    next.lastCompleted = completion;
    await this.commit(next);
    // Commit first: concurrent ticks and restarts cannot count or notify twice.
    this.options.completed?.(completion);
  }
  tick(): Promise<void> {
    return this.enqueue(async () => {
      if (this.unavailable) return;
      await this.finishDue(this.now());
      const day = localDate(new Date(this.now()));
      if (day !== this.lastDay) { this.lastDay = day; this.publish(); }
    });
  }
  command(value: PomodoroCommand): Promise<PomodoroSnapshot> {
    const command = pomodoroCommandSchema.parse(value);
    // Capture pause time before waiting for I/O, including the suspend event.
    const pauseAt = this.now();
    return this.enqueue(async () => {
      if (this.unavailable) throw new Error(this.error!);
      const now = command.type === 'pause' ? pauseAt : this.now();
      await this.finishDue(now);
      const next = structuredClone(this.data);
      const session = next.session;
      if (command.type === 'start') {
        if (session.status === 'running') return this.snapshot();
        // A task may have been renamed, completed, or deleted since it was selected.
        if (session.status === 'idle' && session.task) session.task = this.options.task(session.task.id);
        session.status = 'running'; session.endsAt = now + session.remainingMs; next.lastCompleted = null;
      }
      if (command.type === 'pause') {
        if (session.status !== 'running') return this.snapshot();
        session.remainingMs = remainingTime(session, now); session.endsAt = null; session.status = 'paused';
      }
      if (command.type === 'reset') { next.session = idleSession(session.phase, next.settings, session.task); next.lastCompleted = null; }
      if (command.type === 'select' || command.type === 'configure') {
        if (session.status !== 'idle') throw new Error('请先重置当前计时，再更改模式、任务或时长。');
        if (command.type === 'configure') { next.settings = command.settings; next.cycleCompleted = 0; }
        let task = session.task;
        if (command.type === 'select' && command.taskId !== undefined) {
          task = command.taskId === null ? null : this.options.task(command.taskId);
          if (command.taskId !== null && !task) throw new Error('该任务已完成或删除，请重新选择。');
        }
        next.session = idleSession(command.type === 'select' ? command.phase ?? session.phase : session.phase, next.settings, task);
        next.lastCompleted = null;
      }
      await this.commit(next); return this.snapshot();
    });
  }
  async pause() { if (!this.unavailable) await this.command({ type: 'pause' }); }
}
