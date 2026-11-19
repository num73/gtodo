import { emptyWorkspace, localDate, nextDate, type Clock, type Command, type RecordItem, type Workspace, type TaskValues, type PurgedRecord } from './model';
import { compareClock, linkedNoteForTask, linkedTaskForNote, synchronizeLinkedNotes } from './note-links';

export { compareClock } from './note-links';
function mergePurged(a: PurgedRecord[], b: PurgedRecord[]) {
  const markers = new Map<string, PurgedRecord>();
  for (const marker of [...a, ...b]) {
    const key = `${marker.kind}:${marker.id}`; const prior = markers.get(key);
    if (!prior || compareClock(marker.clock, prior.clock) > 0) markers.set(key, { kind: marker.kind, id: marker.id, clock: { tick: marker.clock.tick, device: marker.clock.device } });
  }
  return [...markers.values()].sort((x, y) => `${x.kind}:${x.id}`.localeCompare(`${y.kind}:${y.id}`, 'en'));
}
function removePurged(workspace: Workspace) {
  const ids = new Set(workspace.purged.map(item => `${item.kind}:${item.id}`));
  workspace.tasks = workspace.tasks.filter(item => !ids.has(`task:${item.id}`));
  workspace.notes = workspace.notes.filter(item => !ids.has(`note:${item.id}`));
  workspace.lists = workspace.lists.filter(item => !ids.has(`list:${item.id}`));
  workspace.steps = workspace.steps.filter(item => !ids.has(`step:${item.id}`) && !ids.has(`task:${item.values.taskId}`));
  for (const task of workspace.tasks) {
    if (ids.has(`list:${task.values.listId}`)) task.values.listId = 'inbox';
    if (task.values.noteLink && ids.has(`note:${task.values.noteLink.noteId}`)) task.values.noteLink = null;
  }
  return workspace;
}
function mergeRecords<T extends object>(a: RecordItem<T>[], b: RecordItem<T>[]): RecordItem<T>[] {
  const result = new Map(a.map(item => [item.id, structuredClone(item)]));
  for (const remote of b) {
    const local = result.get(remote.id);
    if (!local) { result.set(remote.id, structuredClone(remote)); continue; }
    for (const key of Object.keys(remote.values) as (keyof T)[]) {
      if (compareClock(remote.clocks[key], local.clocks[key]) > 0) {
        local.values[key] = remote.values[key];
        local.clocks[key] = { ...remote.clocks[key] };
      }
    }
  }
  return [...result.values()].sort((x, y) => x.id.localeCompare(y.id, 'en'));
}
export function mergeWorkspaces(a: Workspace, b: Workspace): Workspace {
  return synchronizeLinkedNotes(removePurged({ schemaVersion: 1, lists: mergeRecords(a.lists, b.lists), tasks: mergeRecords(a.tasks, b.tasks), steps: mergeRecords(a.steps, b.steps), notes: mergeRecords(a.notes, b.notes), purged: mergePurged(a.purged ?? [], b.purged ?? []) }));
}
export class WorkspaceEngine {
  state: Workspace;
  private tick = 0;
  constructor(readonly deviceId: string, state = emptyWorkspace()) { this.state = synchronizeLinkedNotes(removePurged({ ...structuredClone(state), purged: mergePurged(state.purged ?? [], []) })); this.observe(); }
  private observe() {
    for (const marker of this.state.purged) this.tick = Math.max(this.tick, marker.clock.tick);
    for (const collection of [this.state.lists, this.state.tasks, this.state.steps, this.state.notes]) {
      for (const item of collection) for (const clock of Object.values(item.clocks) as Clock[]) this.tick = Math.max(this.tick, clock.tick);
    }
  }
  private clock(): Clock { this.tick = Math.max(this.tick + 1, Date.now()); return { tick: this.tick, device: this.deviceId }; }
  private record<T extends object>(id: string, values: T): RecordItem<T> {
    const clock = this.clock();
    return { id, values, clocks: Object.fromEntries(Object.keys(values).map(key => [key, clock])) as RecordItem<T>['clocks'] };
  }
  private patch<T extends object>(item: RecordItem<T> | undefined, patch: Partial<T>) {
    if (!item) throw new Error('这条记录已不存在，请重新选择。');
    const clock = this.clock();
    for (const key of Object.keys(patch) as (keyof T)[]) {
      if (patch[key] !== undefined && patch[key] !== item.values[key]) { item.values[key] = patch[key]!; item.clocks[key] = clock; }
    }
  }
  merge(remote: Workspace) { this.state = mergeWorkspaces(this.state, remote); this.observe(); }
  private deletedRecord(target: PurgedRecord) {
    const collection = target.kind === 'task' ? this.state.tasks : target.kind === 'note' ? this.state.notes : target.kind === 'list' ? this.state.lists : this.state.steps;
    const item = collection.find(item => item.id === target.id);
    if (!item?.values.deleted || compareClock(item.clocks.deleted, target.clock) !== 0) throw new Error('回收站内容已变化，请刷新后重试。');
    return item;
  }
  restore(target: PurgedRecord) {
    this.deletedRecord(target);
    if (target.kind === 'task') {
      const task = this.state.tasks.find(item => item.id === target.id)!;
      const listId = this.state.lists.some(item => item.id === task.values.listId && !item.values.deleted) ? task.values.listId : 'inbox';
      this.apply({ type: 'task.update', id: target.id, patch: { deleted: false, listId } });
    } else if (target.kind === 'step') {
      const step = this.state.steps.find(item => item.id === target.id)!;
      if (!this.state.tasks.some(item => item.id === step.values.taskId && !item.values.deleted)) throw new Error('请先恢复此步骤所属的任务。');
      this.apply({ type: 'step.update', id: target.id, patch: { deleted: false } });
    } else if (target.kind === 'note') this.apply({ type: 'note.update', id: target.id, patch: { deleted: false } });
    else this.apply({ type: 'list.update', id: target.id, patch: { deleted: false } });
  }
  purge(targets: PurgedRecord[]) {
    for (const target of targets) this.deletedRecord(target);
    const markers = targets.map(target => ({ kind: target.kind, id: target.id, clock: this.clock() }));
    const taskIds = new Set(targets.filter(item => item.kind === 'task').map(item => item.id));
    for (const step of this.state.steps) if (taskIds.has(step.values.taskId)) markers.push({ kind: 'step', id: step.id, clock: this.clock() });
    this.state.purged = mergePurged(this.state.purged, markers);
    removePurged(this.state);
  }
  apply(command: Command) {
    const now = new Date().toISOString();
    switch (command.type) {
      case 'list.add': this.state.lists.push(this.record(crypto.randomUUID(), { name: command.name, color: command.color, deleted: false, createdAt: now })); break;
      case 'list.update': {
        this.patch(this.state.lists.find(item => item.id === command.id), command.patch);
        // Tasks stay recoverable in the inbox when their custom list is deleted.
        if (command.patch.deleted) for (const item of this.state.tasks.filter(item => item.values.listId === command.id)) this.patch(item, { listId: 'inbox' });
        break;
      }
      case 'task.add': {
        const taskId = crypto.randomUUID();
        this.ensureList(command.listId);
        this.state.tasks.push(this.record<TaskValues>(taskId, {
          title: command.title, listId: command.listId, notes: '', notesFormat: 'text', notesAssets: {}, noteLink: null, important: command.important ?? false,
          completed: false, myDay: command.myDay ?? null, dueDate: command.dueDate ?? null,
          reminder: null, repeat: 'none', seriesId: taskId, createdAt: now, completedAt: null, deleted: false,
        })); break;
      }
      case 'task.update': {
        const task = this.state.tasks.find(item => item.id === command.id);
        if (!task) throw new Error('任务不存在。');
        if (command.patch.listId) this.ensureList(command.patch.listId);
        const wasCompleted = task.values.completed;
        const { deleted, ...patch } = command.patch;
        this.patch(task, patch);
        synchronizeLinkedNotes(this.state);
        const linked = linkedNoteForTask(this.state, task);
        if (deleted !== undefined) this.patch(task, { deleted });
        if (deleted && linked) this.patch(task, { noteLink: { ...task.values.noteLink!, detached: { side: 'task', clock: { ...task.clocks.deleted } } } });
        if (command.patch.completed !== undefined && wasCompleted !== command.patch.completed) {
          this.patch(task, { completedAt: command.patch.completed ? now : null });
          if (command.patch.completed && task.values.repeat !== 'none' && !task.values.deleted) this.repeatTask(task.id);
        }
        break;
      }
      case 'task.link-note': {
        const task = this.state.tasks.find(item => item.id === command.id && !item.values.deleted);
        if (!task) throw new Error('任务不存在。');
        if (linkedNoteForTask(this.state, task)) break;
        const note = this.record(crypto.randomUUID(), { title: task.values.title.slice(0, 200), content: task.values.notes, color: 'yellow' as const, format: task.values.notesFormat, assets: structuredClone(task.values.notesAssets), createdAt: now, deleted: false });
        note.clocks.content = { ...task.clocks.notes }; note.clocks.format = { ...task.clocks.notesFormat }; note.clocks.assets = { ...task.clocks.notesAssets };
        this.state.notes.push(note);
        this.patch(task, { noteLink: { noteId: note.id, taskLife: { ...task.clocks.deleted }, noteLife: { ...note.clocks.deleted } } });
        break;
      }
      case 'step.add': {
        if (!this.state.tasks.some(item => item.id === command.taskId && !item.values.deleted)) throw new Error('任务不存在。');
        const stepId = crypto.randomUUID();
        this.state.steps.push(this.record(stepId, { taskId: command.taskId, title: command.title, completed: false, deleted: false, originId: stepId })); break;
      }
      case 'step.update': this.patch(this.state.steps.find(item => item.id === command.id), command.patch); break;
      case 'note.add': this.state.notes.push(this.record(crypto.randomUUID(), { title: command.title ?? '', content: command.content ?? '', color: command.color ?? 'yellow', format: command.format ?? 'text', assets: command.assets ?? {}, createdAt: now, deleted: false })); break;
      case 'note.update': {
        const note = this.state.notes.find(item => item.id === command.id);
        const { deleted, ...patch } = command.patch;
        this.patch(note, patch);
        synchronizeLinkedNotes(this.state);
        const task = note && linkedTaskForNote(this.state, note);
        if (deleted !== undefined) this.patch(note, { deleted });
        if (deleted && task) this.patch(task, { noteLink: { ...task.values.noteLink!, detached: { side: 'note', clock: { ...note!.clocks.deleted } } } });
        break;
      }
    }
  }
  private ensureList(id: string) {
    if (id !== 'inbox' && !this.state.lists.some(item => item.id === id && !item.values.deleted)) throw new Error('清单已删除，请选择其他清单。');
  }
  private repeatTask(id: string) {
    const current = this.state.tasks.find(item => item.id === id)!;
    const dueDate = nextDate(current.values.dueDate ?? localDate(), current.values.repeat);
    const nextId = `${current.values.seriesId}@${dueDate}`;
    if (this.state.tasks.some(item => item.id === nextId) || this.state.purged.some(item => item.kind === 'task' && item.id === nextId)) return;
    const now = new Date().toISOString();
    this.state.tasks.push(this.record(nextId, { ...current.values, noteLink: null, dueDate, myDay: null, completed: false, completedAt: null, reminder: null, createdAt: now }));
    for (const step of this.state.steps.filter(item => item.values.taskId === id && !item.values.deleted)) {
      this.state.steps.push(this.record(`${nextId}:${step.values.originId}`, { ...step.values, taskId: nextId, completed: false }));
    }
  }
}
