import { createHash } from 'node:crypto';
import type { Workspace } from '../src/shared/model';

export interface OutlookEvent {
  id: string;
  event: { subject: string; body: string; date: string; revision: string; important: boolean } | null;
}
function shortSubject(value: string) {
  const shortened = value.slice(0, 250);
  return /[\uD800-\uDBFF]$/.test(shortened) ? shortened.slice(0, -1) : shortened;
}
export function outlookEvents(workspace: Workspace): OutlookEvent[] {
  const lists = new Map(workspace.lists.filter(list => !list.values.deleted).map(list => [list.id, list.values.name]));
  const steps = new Map<string, string[]>();
  for (const step of workspace.steps) {
    if (step.values.deleted) continue;
    const rows = steps.get(step.values.taskId) ?? [];
    rows.push(`${step.values.completed ? '☑' : '☐'} ${step.values.title}`);
    steps.set(step.values.taskId, rows);
  }
  return workspace.tasks.map(task => {
    const v = task.values;
    if (v.deleted || !v.dueDate) return { id: task.id, event: null };
    const year = Number(v.dueDate.slice(0, 4));
    if (year < 1601 || year > 4499) throw new Error('Outlook 同步支持 1601～4499 年的截止日期，请调整超出范围的任务。');
    const subject = shortSubject(`${v.completed ? '✓ ' : ''}${v.title}`);
    const body = [v.title, `清单：${lists.get(v.listId) ?? '任务'}`, `状态：${v.completed ? '已完成' : '未完成'}`,
      '', v.notes, '', ...(steps.get(task.id) ?? [])].join('\n').trimEnd();
    const event = { subject, body, date: v.dueDate, important: v.important };
    return { id: task.id, event: { ...event, revision: createHash('sha256').update(JSON.stringify(event)).digest('hex') } };
  });
}
