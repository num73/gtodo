import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { zoomSteps } from '../src/shared/model';
import { atomicWrite } from './storage';
import { outlookTargetSchema } from './outlook-bridge';
import { defaultPaneLayout, paneLayoutSchema } from '../src/shared/layout';

export const windowBoundsSchema = z.object({
  x: z.number().int(), y: z.number().int(), width: z.number().int().min(360).max(20000),
  height: z.number().int().min(400).max(20000), maximized: z.boolean(),
});
const schema = z.object({
  dataPath: z.string().refine(path.isAbsolute),
  zoom: z.number().refine(value => zoomSteps.includes(value as typeof zoomSteps[number])),
  window: windowBoundsSchema.optional(),
  paneLayout: paneLayoutSchema.default(defaultPaneLayout),
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
});
export type Preferences = z.infer<typeof schema>;
export class PreferencesStore {
  value: Preferences;
  private queue: Promise<unknown> = Promise.resolve();
  readonly file: string;
  constructor(readonly directory: string) {
    this.file = path.join(directory, 'preferences.json');
    this.value = { dataPath: path.join(directory, 'data'), zoom: 100, paneLayout: { ...defaultPaneLayout }, pomodoroWindow: { open: false, pinned: false }, noteWindows: {}, outlook: { enabled: false, target: null } };
  }
  async initialize() {
    try { this.value = schema.parse(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('本机设置无法读取。请保留 preferences.json 并检查备份，任务数据没有被修改。');
    }
  }
  update(change: (value: Preferences) => void) {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.value); change(next); schema.parse(next);
      await atomicWrite(this.file, JSON.stringify(next, null, 2)); this.value = next;
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  async flush() { await this.queue; }
}
