import { emptyWorkspace, localDate, nextDate, type Clock, type Command, type RecordItem, type Workspace, type TaskValues } from './model';

export function compareClock(a: Clock, b: Clock): number {
  return a.tick - b.tick || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0);
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
  return { schemaVersion: 1, lists: mergeRecords(a.lists, b.lists), tasks: mergeRecords(a.tasks, b.tasks), steps: mergeRecords(a.steps, b.steps), notes: mergeRecords(a.notes, b.notes) };
}
export class WorkspaceEngine {
  state: Workspace;
  private tick = 0;
  constructor(readonly deviceId: string, state = emptyWorkspace()) { this.state = structuredClone(state); this.observe(); }
  private observe() {
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
          title: command.title, listId: command.listId, notes: '', important: command.important ?? false,
          completed: false, myDay: command.myDay ?? null, dueDate: command.dueDate ?? null,
          reminder: null, repeat: 'none', seriesId: taskId, createdAt: now, completedAt: null, deleted: false,
        })); break;
      }
      case 'task.update': {
        const task = this.state.tasks.find(item => item.id === command.id);
        if (!task) throw new Error('任务不存在。');
        if (command.patch.listId) this.ensureList(command.patch.listId);
        const wasCompleted = task.values.completed;
        this.patch(task, command.patch);
        if (command.patch.completed !== undefined && wasCompleted !== command.patch.completed) {
          this.patch(task, { completedAt: command.patch.completed ? now : null });
          if (command.patch.completed && task.values.repeat !== 'none' && !task.values.deleted) this.repeatTask(task.id);
        }
        break;
      }
      case 'step.add': {
        if (!this.state.tasks.some(item => item.id === command.taskId && !item.values.deleted)) throw new Error('任务不存在。');
        const stepId = crypto.randomUUID();
        this.state.steps.push(this.record(stepId, { taskId: command.taskId, title: command.title, completed: false, deleted: false, originId: stepId })); break;
      }
      case 'step.update': this.patch(this.state.steps.find(item => item.id === command.id), command.patch); break;
      case 'note.add': this.state.notes.push(this.record(crypto.randomUUID(), { title: command.title ?? '', content: command.content ?? '', color: command.color ?? 'yellow', createdAt: now, deleted: false })); break;
      case 'note.update': this.patch(this.state.notes.find(item => item.id === command.id), command.patch); break;
    }
  }
  private ensureList(id: string) {
    if (id !== 'inbox' && !this.state.lists.some(item => item.id === id && !item.values.deleted)) throw new Error('清单已删除，请选择其他清单。');
  }
  private repeatTask(id: string) {
    const current = this.state.tasks.find(item => item.id === id)!;
    const dueDate = nextDate(current.values.dueDate ?? localDate(), current.values.repeat);
    const nextId = `${current.values.seriesId}@${dueDate}`;
    if (this.state.tasks.some(item => item.id === nextId)) return;
    const now = new Date().toISOString();
    this.state.tasks.push(this.record(nextId, { ...current.values, dueDate, myDay: null, completed: false, completedAt: null, reminder: null, createdAt: now }));
    for (const step of this.state.steps.filter(item => item.values.taskId === id && !item.values.deleted)) {
      this.state.steps.push(this.record(`${nextId}:${step.values.originId}`, { ...step.values, taskId: nextId, completed: false }));
    }
  }
}
