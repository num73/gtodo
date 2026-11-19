import type { NotePatch, NoteValues } from '../shared/model';

type Editable = Pick<NoteValues, 'title' | 'content' | 'color' | 'format'>;
type Snapshot<T> = { values: T; dirty: boolean; saving: boolean; error: string };

/** Keeps edits made during a save, and never replaces dirty text with a folder update. */
export class FieldDraft<T extends object> {
  private listeners = new Set<() => void>();
  private dirty = new Set<keyof T>();
  private versions: Record<keyof T, number>;
  private fields: (keyof T)[];
  private timer?: ReturnType<typeof setTimeout>;
  private operation: Promise<void> | null = null;
  private snapshot: Snapshot<T>;
  constructor(initial: T, private save: (patch: Partial<T>) => Promise<T>, private delay = 350) {
    this.fields = Object.keys(initial) as (keyof T)[];
    this.versions = Object.fromEntries(this.fields.map(field => [field, 0])) as Record<keyof T, number>;
    this.snapshot = { values: { ...initial }, dirty: false, saving: false, error: '' };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(patch: Partial<Snapshot<T>> = {}) {
    this.snapshot = { ...this.snapshot, ...patch, dirty: this.dirty.size > 0 };
    for (const listener of this.listeners) listener();
  }
  change<K extends keyof T>(field: K, value: T[K]) {
    if (this.snapshot.values[field] === value) return;
    this.versions[field]++; this.dirty.add(field);
    this.emit({ values: { ...this.snapshot.values, [field]: value }, error: '' });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, this.delay);
  }
  receive(values: T) {
    const next = { ...this.snapshot.values }; let changed = false;
    for (const field of this.fields) {
      if (!this.dirty.has(field) && next[field] !== values[field]) {
        Object.assign(next, { [field]: values[field] }); changed = true;
      }
    }
    if (changed) this.emit({ values: next });
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.operation) return this.operation;
    if (!this.dirty.size) return Promise.resolve();
    this.emit({ saving: true, error: '' });
    const operation = (async () => {
      while (this.dirty.size) {
        const fieldsToSave = [...this.dirty]; const versions = { ...this.versions };
        const patch = Object.fromEntries(fieldsToSave.map(field => [field, this.snapshot.values[field]])) as Partial<T>;
        const saved = await this.save(patch);
        for (const field of fieldsToSave) if (versions[field] === this.versions[field]) this.dirty.delete(field);
        this.receive(saved); this.emit();
      }
    })().catch(error => {
      this.emit({ error: (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
      throw error;
    }).finally(() => { this.operation = null; this.emit({ saving: false }); });
    this.operation = operation; return operation;
  }
  dispose() { clearTimeout(this.timer); }
}
export class NoteDraft extends FieldDraft<Editable> {
  constructor(initial: Editable, save: (patch: NotePatch) => Promise<Editable>, delay = 350) {
    super({ title: initial.title, content: initial.content, color: initial.color, format: initial.format }, save, delay);
  }
}
const mainDrafts = new Map<symbol, { draft: { flush(): Promise<void> }; attached: boolean }>();
export function registerMainDraft(draft: { flush(): Promise<void> }) {
  const key = Symbol(); const item = { draft, attached: true }; mainDrafts.set(key, item);
  return () => { item.attached = false; void draft.flush().then(() => mainDrafts.delete(key), () => {}); };
}
export async function flushMainDrafts() {
  await Promise.all([...mainDrafts].map(async ([key, item]) => { await item.draft.flush(); if (!item.attached) mainDrafts.delete(key); }));
}
