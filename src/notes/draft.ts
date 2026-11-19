import type { NotePatch, NoteValues } from '../shared/model';

type Editable = Pick<NoteValues, 'title' | 'content' | 'color'>;
type Snapshot = { values: Editable; dirty: boolean; saving: boolean; error: string };
const fields = ['title', 'content', 'color'] as const;

/** Keeps edits made during a save, and never replaces dirty text with a folder update. */
export class NoteDraft {
  private listeners = new Set<() => void>();
  private dirty = new Set<keyof Editable>();
  private versions = { title: 0, content: 0, color: 0 };
  private timer?: ReturnType<typeof setTimeout>;
  private operation: Promise<void> | null = null;
  private snapshot: Snapshot;
  constructor(initial: Editable, private save: (patch: NotePatch) => Promise<Editable>, private delay = 350) {
    this.snapshot = { values: { title: initial.title, content: initial.content, color: initial.color }, dirty: false, saving: false, error: '' };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(patch: Partial<Snapshot> = {}) {
    this.snapshot = { ...this.snapshot, ...patch, dirty: this.dirty.size > 0 };
    for (const listener of this.listeners) listener();
  }
  change<K extends keyof Editable>(field: K, value: Editable[K]) {
    if (this.snapshot.values[field] === value) return;
    this.versions[field]++; this.dirty.add(field);
    this.emit({ values: { ...this.snapshot.values, [field]: value }, error: '' });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, this.delay);
  }
  receive(values: Editable) {
    const next = { ...this.snapshot.values }; let changed = false;
    for (const field of fields) {
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
        const patch = Object.fromEntries(fieldsToSave.map(field => [field, this.snapshot.values[field]])) as NotePatch;
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
