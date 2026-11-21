import { z } from 'zod';
import { noteColors, type Command } from './model';
import { defaultCardStyle } from './board';

export const startupViews = [
  { value: 'day', label: '我的一天' }, { value: 'board', label: '我的看板' },
  { value: 'inbox', label: '任务' }, { value: 'all', label: '全部任务' },
  { value: 'important', label: '重要' }, { value: 'planned', label: '计划' },
  { value: 'completed', label: '已完成' },
] as const;
const color = z.string().regex(/^#[\da-fA-F]{6}$/);
export const userPreferencesSchema = z.object({
  startupView: z.enum(['day', 'board', 'inbox', 'all', 'important', 'planned', 'completed']).default('day'),
  closeAction: z.enum(['auto', 'background', 'quit']).default('auto'),
  restoreNotes: z.boolean().default(true),
  restorePomodoro: z.boolean().default(true),
  taskNotifications: z.boolean().default(true),
  pomodoroNotifications: z.boolean().default(true),
  showCompleted: z.boolean().default(true),
  noteColor: z.enum(noteColors).default('yellow'),
  boardTextBackground: color.default(defaultCardStyle.color),
  boardTextColor: color.default(defaultCardStyle.textColor),
  boardTextFontSize: z.number().int().min(14).max(96).default(defaultCardStyle.fontSize),
});
export type UserPreferences = z.infer<typeof userPreferencesSchema>;
export const defaultUserPreferences = userPreferencesSchema.parse({});
// Optional defaults in Zod can fill missing keys. A patch must only change
// the fields the caller supplied, so remove defaults before making it partial.
export const userPreferencesPatchSchema = z.object({
  startupView: userPreferencesSchema.shape.startupView.unwrap(), closeAction: userPreferencesSchema.shape.closeAction.unwrap(),
  restoreNotes: userPreferencesSchema.shape.restoreNotes.unwrap(), restorePomodoro: userPreferencesSchema.shape.restorePomodoro.unwrap(),
  taskNotifications: userPreferencesSchema.shape.taskNotifications.unwrap(), pomodoroNotifications: userPreferencesSchema.shape.pomodoroNotifications.unwrap(),
  showCompleted: userPreferencesSchema.shape.showCompleted.unwrap(), noteColor: userPreferencesSchema.shape.noteColor.unwrap(),
  boardTextBackground: userPreferencesSchema.shape.boardTextBackground.unwrap(), boardTextColor: userPreferencesSchema.shape.boardTextColor.unwrap(),
  boardTextFontSize: userPreferencesSchema.shape.boardTextFontSize.unwrap(),
}).partial().strict();
export function patchUserPreferences(current: UserPreferences, patch: unknown): UserPreferences {
  const values = Object.fromEntries(Object.entries(userPreferencesPatchSchema.parse(patch)).filter(([, value]) => value !== undefined));
  return userPreferencesSchema.parse({ ...current, ...values });
}
export function creationDefaults(command: Command, preferences: UserPreferences): Command {
  if (command.type === 'note.add') return { ...command, color: command.color ?? preferences.noteColor };
  if (command.type === 'board.source.add' || command.type === 'task.link-note') return { ...command, noteColor: command.noteColor ?? preferences.noteColor };
  if (command.type === 'board.card.add' && command.content.kind === 'text') return {
    ...command, style: { color: preferences.boardTextBackground, textColor: preferences.boardTextColor, fontSize: preferences.boardTextFontSize, ...command.style },
  };
  return command;
}
