import { z } from 'zod';

export const pomodoroPhases = ['focus', 'shortBreak', 'longBreak'] as const;
export type PomodoroPhase = typeof pomodoroPhases[number];
export const phaseLabels: Record<PomodoroPhase, string> = { focus: '专注', shortBreak: '短休息', longBreak: '长休息' };
export const pomodoroSettingsSchema = z.object({
  focusMinutes: z.number().int().min(1).max(180),
  shortBreakMinutes: z.number().int().min(1).max(60),
  longBreakMinutes: z.number().int().min(1).max(60),
  longBreakEvery: z.number().int().min(2).max(12),
});
export type PomodoroSettings = z.infer<typeof pomodoroSettingsSchema>;
export const defaultPomodoroSettings: PomodoroSettings = { focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, longBreakEvery: 4 };
const taskSchema = z.object({ id: z.string().min(1).max(200), title: z.string().min(1).max(500) });
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const sessionSchema = z.object({
  phase: z.enum(pomodoroPhases), status: z.enum(['idle', 'running', 'paused']),
  durationMs: z.number().int().min(60_000).max(180 * 60_000),
  remainingMs: z.number().int().nonnegative().max(180 * 60_000),
  endsAt: timestamp.nullable(), task: taskSchema.nullable(),
}).superRefine((session, ctx) => {
  if (session.remainingMs > session.durationMs || (session.status === 'running') !== (session.endsAt !== null) ||
    (session.status === 'idle' && session.remainingMs !== session.durationMs) || (session.status === 'paused' && !session.remainingMs)) {
    ctx.addIssue({ code: 'custom', message: '无效的番茄钟状态' });
  }
});
export type PomodoroSession = z.infer<typeof sessionSchema>;
export const pomodoroDataSchema = z.object({
  schemaVersion: z.literal(1), settings: pomodoroSettingsSchema, session: sessionSchema,
  cycleCompleted: z.number().int().nonnegative().max(12),
  days: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), completed: z.number().int().nonnegative(), minutes: z.number().nonnegative() })).max(366),
  lastCompleted: z.object({ phase: z.enum(pomodoroPhases), at: timestamp, taskTitle: z.string().max(500).nullable() }).nullable(),
});
export type PomodoroData = z.infer<typeof pomodoroDataSchema>;
export interface PomodoroSnapshot {
  settings: PomodoroSettings; session: PomodoroSession; cycleCompleted: number;
  today: { date: string; completed: number; minutes: number };
  lastCompleted: PomodoroData['lastCompleted']; error: string | null; unavailable: boolean;
}
export const pomodoroCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start') }), z.object({ type: z.literal('pause') }), z.object({ type: z.literal('reset') }),
  z.object({ type: z.literal('select'), phase: z.enum(pomodoroPhases).optional(), taskId: z.string().min(1).max(200).nullable().optional() }),
  z.object({ type: z.literal('configure'), settings: pomodoroSettingsSchema }),
]);
export type PomodoroCommand = z.infer<typeof pomodoroCommandSchema>;
export function durationFor(phase: PomodoroPhase, settings: PomodoroSettings) {
  return (phase === 'focus' ? settings.focusMinutes : phase === 'shortBreak' ? settings.shortBreakMinutes : settings.longBreakMinutes) * 60_000;
}
export function idleSession(phase: PomodoroPhase, settings: PomodoroSettings, task: PomodoroSession['task'] = null): PomodoroSession {
  const durationMs = durationFor(phase, settings);
  return { phase, status: 'idle', durationMs, remainingMs: durationMs, endsAt: null, task };
}
export function emptyPomodoroData(): PomodoroData {
  return { schemaVersion: 1, settings: { ...defaultPomodoroSettings }, session: idleSession('focus', defaultPomodoroSettings), cycleCompleted: 0, days: [], lastCompleted: null };
}
export function remainingTime(session: PomodoroSession, now = Date.now()) {
  return session.status === 'running' && session.endsAt !== null ? Math.max(0, Math.min(session.durationMs, session.endsAt - now)) : session.remainingMs;
}
export function formatCountdown(milliseconds: number) {
  const seconds = Math.ceil(Math.max(0, milliseconds) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
