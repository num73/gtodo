import { z } from 'zod';
import type { OutlookCalendarOption, OutlookStatus } from './outlook';
import type { PaneLayout } from './layout';
import type { UserPreferences } from './preferences';
import { assetMapSchema, documentFormatSchema, type CreateNoteInput, type DocumentTarget } from './documents';
import { boardValuesSchema, boardCardValuesSchema, boardContentSchema, boardLayoutSchema, boardCardPatchSchema, type Board, type BoardCard, type BoardImageInput } from './board';

const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9@._:-]+$/);
const title = z.string().trim().min(1, '请输入名称').max(500);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T12:00:00`);
  return !Number.isNaN(parsed.valueOf()) && localDate(parsed) === value;
}, '日期无效');
const nullableDate = date.nullable();
export const clockSchema = z.object({ tick: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1000000), device: id });
export type Clock = z.infer<typeof clockSchema>;
export const recordKindSchema = z.enum(['task', 'note', 'list', 'step', 'boardCard']);
export const purgedRecordSchema = z.object({ kind: recordKindSchema, id, clock: clockSchema });
export type PurgedRecord = z.infer<typeof purgedRecordSchema>;
const noteLinkSchema = z.object({ noteId: id, taskLife: clockSchema, noteLife: clockSchema, detached: z.object({ side: z.enum(['task', 'note']), clock: clockSchema }).optional() }).nullable();
export const colors = ['purple', 'blue', 'green', 'rose', 'orange', 'slate'] as const;
export const listValuesSchema = z.object({
  name: title, color: z.enum(colors), deleted: z.boolean(), createdAt: z.string().datetime(),
});
export const taskValuesSchema = z.object({
  title, listId: id, notes: z.string().max(100000), important: z.boolean(), completed: z.boolean(),
  notesFormat: documentFormatSchema.default('text'), notesAssets: assetMapSchema.default({}),
  noteLink: noteLinkSchema.default(null),
  myDay: nullableDate, dueDate: nullableDate, reminder: z.string().datetime().nullable(),
  repeat: z.enum(['none', 'daily', 'weekly', 'monthly']),
  seriesId: id, createdAt: z.string().datetime(), completedAt: z.string().datetime().nullable(), deleted: z.boolean(),
});
export const stepValuesSchema = z.object({ taskId: id, title, completed: z.boolean(), deleted: z.boolean(), originId: id });
export const noteColors = ['yellow', 'orange', 'coral', 'rose', 'purple', 'indigo', 'blue', 'teal', 'mint', 'green', 'gray', 'white'] as const;
export const noteColorNames = {
  yellow: '黄色', orange: '橙色', coral: '珊瑚色', rose: '粉色', purple: '紫色', indigo: '靛蓝',
  blue: '蓝色', teal: '青色', mint: '薄荷色', green: '绿色', gray: '灰色', white: '白色',
} satisfies Record<typeof noteColors[number], string>;
export const noteValuesSchema = z.object({
  title: z.string().max(200), content: z.string().max(100000), color: z.enum(noteColors),
  format: documentFormatSchema.default('text'), assets: assetMapSchema.default({}),
  createdAt: z.string().datetime(), deleted: z.boolean(),
});
export type NoteValues = z.infer<typeof noteValuesSchema>;
export type NotePatch = Partial<Pick<NoteValues, 'title' | 'content' | 'color' | 'format'>>;
export type Note = RecordItem<NoteValues>;
export type ListValues = z.infer<typeof listValuesSchema>;
export type TaskValues = z.infer<typeof taskValuesSchema>;
export type StepValues = z.infer<typeof stepValuesSchema>;
export type RecordItem<T> = { id: string; values: T; clocks: { [K in keyof T]: Clock } };
export type Task = RecordItem<TaskValues>;
export type TaskList = RecordItem<ListValues>;
export type Step = RecordItem<StepValues>;

function recordSchema<T extends z.ZodRawShape>(values: z.ZodObject<T>) {
  const shape = Object.fromEntries(Object.keys(values.shape).map(key => [key,
    ['notesFormat', 'notesAssets', 'format', 'assets', 'noteLink'].includes(key) ? clockSchema.default({ tick: 0, device: 'legacy' }) : clockSchema]));
  return z.object({ id, values, clocks: z.object(shape) });
}
export const workspaceSchema = z.object({
  schemaVersion: z.literal(1),
  lists: z.array(recordSchema(listValuesSchema)).max(5000),
  tasks: z.array(recordSchema(taskValuesSchema)).max(100000),
  steps: z.array(recordSchema(stepValuesSchema)).max(200000),
  notes: z.array(recordSchema(noteValuesSchema)).max(10000).default([]),
  boards: z.array(recordSchema(boardValuesSchema)).max(1).default([]),
  boardCards: z.array(recordSchema(boardCardValuesSchema)).max(5000).default([]),
  purged: z.array(purgedRecordSchema).max(400000).default([]),
}).superRefine((value, ctx) => {
  for (const key of ['lists', 'tasks', 'steps', 'notes', 'boards', 'boardCards'] as const) {
    if (new Set(value[key].map(item => item.id)).size !== value[key].length) {
      ctx.addIssue({ code: 'custom', message: `${key} 中有重复标识` });
    }
  }
  if (value.boards.some(item => item.id !== 'main')) ctx.addIssue({ code: 'custom', message: '看板标识无效' });
});
export interface Workspace { schemaVersion: 1; lists: TaskList[]; tasks: Task[]; steps: Step[]; notes: Note[]; boards: Board[]; boardCards: BoardCard[]; purged: PurgedRecord[] }
export function parseWorkspace(value: unknown): Workspace { return workspaceSchema.parse(value) as Workspace; }
export function emptyWorkspace(): Workspace { return { schemaVersion: 1, lists: [], tasks: [], steps: [], notes: [], boards: [], boardCards: [], purged: [] }; }
export function localDate(value = new Date()): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}
export function nextDate(value: string, repeat: TaskValues['repeat']): string {
  const day = new Date(`${value}T12:00:00`);
  if (repeat === 'monthly') {
    const original = day.getDate();
    day.setDate(1); day.setMonth(day.getMonth() + 1);
    const last = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
    day.setDate(Math.min(original, last));
  } else day.setDate(day.getDate() + (repeat === 'weekly' ? 7 : 1));
  return localDate(day);
}
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('board.update'), patch: boardValuesSchema.partial() }),
  z.object({ type: z.literal('board.card.add'), content: boardContentSchema, layout: boardLayoutSchema.optional(), style: boardCardValuesSchema.pick({ color: true, textColor: true, fontSize: true, align: true, imageFit: true }).partial().optional() }),
  z.object({ type: z.literal('board.source.add'), kind: z.enum(['task', 'note']), title: z.string().trim().max(200), content: z.string().max(100000), layout: boardLayoutSchema.optional(), noteColor: z.enum(noteColors).optional() }),
  z.object({ type: z.literal('board.card.update'), id, patch: boardCardPatchSchema }),
  z.object({ type: z.literal('board.card.layer'), id, front: z.boolean() }),
  z.object({ type: z.literal('task.add'), title, listId: id, myDay: nullableDate.optional(), important: z.boolean().optional(), dueDate: nullableDate.optional() }),
  z.object({ type: z.literal('task.update'), id, patch: taskValuesSchema.omit({ seriesId: true, createdAt: true, completedAt: true, notesFormat: true, notesAssets: true, noteLink: true }).partial().extend({ notesFormat: documentFormatSchema.optional(), notesAssets: assetMapSchema.optional() }) }),
  z.object({ type: z.literal('task.link-note'), id, noteColor: z.enum(noteColors).optional() }),
  z.object({ type: z.literal('list.add'), name: title, color: z.enum(colors) }),
  z.object({ type: z.literal('list.update'), id, patch: listValuesSchema.omit({ createdAt: true }).partial() }),
  z.object({ type: z.literal('step.add'), taskId: id, title }),
  z.object({ type: z.literal('step.update'), id, patch: stepValuesSchema.pick({ title: true, completed: true, deleted: true }).partial() }),
  z.object({ type: z.literal('note.add'), title: z.string().max(200).optional(), content: z.string().max(100000).optional(), color: z.enum(noteColors).optional(), format: documentFormatSchema.optional(), assets: assetMapSchema.optional() }),
  z.object({ type: z.literal('note.update'), id, patch: noteValuesSchema.omit({ createdAt: true, format: true, assets: true }).partial().extend({ format: documentFormatSchema.optional(), assets: assetMapSchema.optional() }) }),
]);
export type Command = z.infer<typeof commandSchema>;
export interface FolderStatus { error: string | null; lastRead: string | null; notice?: string | null }
export interface NoteWindowSettings { open: boolean; pinned: boolean; bounds?: { x: number; y: number; width: number; height: number } }
export interface AppState { workspace: Workspace; deviceId: string; dataPath: string; notice: string | null; folder: FolderStatus; zoom: number; version: string; mainWindow: { maximized: boolean; fullScreen: boolean }; paneLayout: PaneLayout; preferences: UserPreferences; pomodoroWindow: NoteWindowSettings; noteWindows: Record<string, NoteWindowSettings>; outlook: OutlookStatus }
export const noteWindowActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('open'), id }), z.object({ type: z.literal('hide'), id }),
  z.object({ type: z.literal('pin'), id, pinned: z.boolean() }),
]);
export type NoteWindowAction = z.infer<typeof noteWindowActionSchema>;
export const zoomSteps = [60, 75, 90, 100, 110, 125, 150, 175, 200] as const;
export type ZoomAction = 'in' | 'out' | 'reset' | number;
export function nextZoom(current: number, action: ZoomAction): number {
  if (action === 'reset') return 100;
  if (action === 'in') return zoomSteps.find(value => value > current) ?? zoomSteps.at(-1)!;
  if (action === 'out') return [...zoomSteps].reverse().find(value => value < current) ?? zoomSteps[0];
  return zoomSteps.includes(action as typeof zoomSteps[number]) ? action : current;
}
export interface DesktopAPI {
  getPomodoro(): Promise<import('./pomodoro').PomodoroSnapshot>;
  pomodoroCommand(command: import('./pomodoro').PomodoroCommand): Promise<import('./pomodoro').PomodoroSnapshot>;
  onPomodoro(callback: (state: import('./pomodoro').PomodoroSnapshot) => void): () => void;
  openPomodoro(taskId?: string): Promise<void>;
  pomodoroWindow(action: { type: 'hide' } | { type: 'pin'; pinned: boolean }): Promise<void>;
  setPaneLayout(layout: PaneLayout): Promise<AppState>;
  setPreferences(patch: Partial<UserPreferences>): Promise<AppState>;
  getState(): Promise<AppState>;
  command(command: Command): Promise<AppState>;
  chooseDataFolder(): Promise<AppState>;
  openDataFolder(): Promise<void>;
  refreshFolder(): Promise<AppState>;
  setZoom(action: ZoomAction): Promise<AppState>;
  exportBackup(): Promise<boolean>;
  importBackup(): Promise<AppState>;
  getTrash(): Promise<import('./trash').TrashSnapshot>;
  restoreTrash(target: import('./trash').TrashTarget): Promise<AppState>;
  purgeTrash(targets: import('./trash').TrashTarget[]): Promise<import('./trash').TrashResult>;
  listOutlookCalendars(): Promise<OutlookCalendarOption[]>;
  configureOutlook(input: { enabled: boolean; calendarId?: string }): Promise<AppState>;
  syncOutlook(): Promise<AppState>;
  createNote(input?: CreateNoteInput): Promise<string>;
  createLinkedNote(taskId: string): Promise<string>;
  pickBoardImage(input: BoardImageInput): Promise<{ state: AppState; assetId: string } | null>;
  insertBoardImage(input: BoardImageInput & { bytes: Uint8Array; name: string }): Promise<AppState>;
  pickDocumentImage(target: DocumentTarget): Promise<{ path: string; name: string } | null>;
  captureDocumentImage(target: DocumentTarget): Promise<{ path: string; name: string } | null>;
  insertDocumentImage(input: { target: DocumentTarget; bytes: Uint8Array; name: string }): Promise<{ path: string; name: string }>;
  showDocumentFile(target: DocumentTarget): Promise<void>;
  openLink(url: string): Promise<void>;
  noteWindow(action: NoteWindowAction): Promise<void>;
  deleteNote(id: string): Promise<AppState>;
  showMain(): Promise<void>;
  quit(): void;
  onNoteFlush(callback: (requestId: string) => void): () => void;
  noteFlushed(requestId: string, success: boolean): Promise<void>;
  windowControl(action: 'minimize' | 'maximize' | 'close'): void;
  onState(callback: (state: AppState) => void): () => void;
}
