import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { zoomSteps } from '../src/shared/model';
import { atomicWrite } from './storage';
import { outlookTargetSchema } from './outlook-bridge';
import { defaultPaneLayout, paneLayoutSchema } from '../src/shared/layout';
import { defaultUserPreferences, userPreferencesSchema } from '../src/shared/preferences';

export const windowBoundsSchema = z.object({
  x: z.number().int(), y: z.number().int(), width: z.number().int().min(360).max(20000),
  height: z.number().int().min(400).max(20000), maximized: z.boolean(),
});
const schema = z.object({
  deviceId: z.string().uuid().optional(),
  storageVersion: z.literal(3).optional(),
  migrationPath: z.string().optional(),
  dataPath: z.string().refine(path.isAbsolute),
  zoom: z.number().refine(value => zoomSteps.includes(value as typeof zoomSteps[number])),
  window: windowBoundsSchema.optional(),
  paneLayout: paneLayoutSchema.default(defaultPaneLayout),
  user: userPreferencesSchema.default(defaultUserPreferences),
  pomodoroWindow: z.object({
    open: z.boolean(), pinned: z.boolean(), bounds: z.object({
      x: z.number().int(), y: z.number().int(), width: z.number().int().min(280).max(20000), height: z.number().int().min(320).max(20000),
    }).optional(),
  }).default({ open: false, pinned: false }),
  noteWindows: z.record(z.string(), z.object({
    open: z.boolean(), pinned: z.boolean(), bounds: z.object({
      x: z.number().int(), y: z.number().int(), width: z.number().int().min(260).max(20000), height: z.number().int().min(240).max(20000),
    }).optional(),
  })).default({}),
  outlook: z.object({ enabled: z.boolean(), target: outlookTargetSchema.nullable() }).default({ enabled: false, target: null }),
  git: z.object({ enabled: z.boolean() }).default({ enabled: false }),
});
export type Preferences = z.infer<typeof schema>;
export class PreferencesStore {
  value: Preferences;
  private queue: Promise<unknown> = Promise.resolve();
  readonly file: string;
  private workspaceFile?: string;
  private workspaceSerialized = '{}';
  constructor(readonly directory: string) {
    this.file = path.join(directory, 'preferences.json');
    this.value = { dataPath: path.join(directory, 'data'), zoom: 100, paneLayout: { ...defaultPaneLayout }, user: { ...defaultUserPreferences }, pomodoroWindow: { open: false, pinned: false }, noteWindows: {}, outlook: { enabled: false, target: null }, git: { enabled: false } };
  }
  async initialize() {
    try { this.value = schema.parse(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (error) {
      try {
        this.value = schema.parse(JSON.parse(await readFile(`${this.file}.bak`, 'utf8')));
        await atomicWrite(this.file, JSON.stringify(this.value, null, 2));
      } catch (backupError) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || (backupError as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('本机设置与备份无法读取。请保留 preferences.json 并检查备份，任务数据没有被修改。');
      }
    }
  }
  async readWorkspaceWindows(directory: string) {
    const file = path.join(directory, 'windows.json');
    let value: Preferences['noteWindows'] = {};
    try { value = schema.shape.noteWindows.parse(JSON.parse(await readFile(file, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('便签窗口设置无法读取，请检查数据目录。'); }
    return value;
  }
  async attachWorkspace(directory: string, prepared?: Preferences['noteWindows']) {
    await this.flush();
    const value = prepared ?? await this.readWorkspaceWindows(directory);
    this.workspaceFile = path.join(directory, 'windows.json'); this.workspaceSerialized = JSON.stringify(value); this.value.noteWindows = value;
  }
  update(change: (value: Preferences) => void) {
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.value); change(draft); const next = schema.parse(draft);
      const backup = structuredClone(this.value);
      if (next.storageVersion === 3 && backup.storageVersion !== 3) { backup.storageVersion = 3; backup.deviceId = next.deviceId; backup.dataPath = next.dataPath; backup.migrationPath = next.migrationPath; }
      if (next.user.inboxPurged) { backup.user.inboxPurged = true; backup.user.inboxVisible = false; if (backup.user.startupView === 'inbox') backup.user.startupView = 'all'; }
      const windows = JSON.stringify(next.noteWindows);
      if (this.workspaceFile && windows !== this.workspaceSerialized) { await atomicWrite(this.workspaceFile, windows); this.workspaceSerialized = windows; }
      const configuration = (value: Preferences) => next.storageVersion === 3 ? { ...value, noteWindows: {} } : value;
      await atomicWrite(`${this.file}.bak`, JSON.stringify(configuration(backup), null, 2));
      await atomicWrite(this.file, JSON.stringify(configuration(next), null, 2)); this.value = next;
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  async flush() { await this.queue; }
}
