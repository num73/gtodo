import { z } from 'zod';
import { purgedRecordSchema, type Workspace } from './model';
import { boardCardTitle } from './board';

// The deletion clock makes a stale confirmation fail if another device restores
// or deletes the same record again before the user confirms.
export const trashTargetSchema = purgedRecordSchema;
export const trashTargetsSchema = z.array(trashTargetSchema).max(315000);
export type TrashTarget = z.infer<typeof trashTargetSchema>;
export type TrashItem = TrashTarget & { title: string; preview: string; bytes: number };
export interface TrashSnapshot { items: TrashItem[]; residualBytes: number; residualFiles: number; error: string | null }
export interface TrashResult { freedBytes: number; error: string | null }
export const trashKindNames = { task: '任务', note: '笔记 / 便签', list: '清单', step: '步骤', boardCard: '看板贴纸', noteFolder: '笔记目录' };
export function trashRecords(workspace: Workspace): TrashItem[] {
  const tasks = new Map(workspace.tasks.map(item => [item.id, item]));
  return [
    ...workspace.noteFolders.filter(item => item.values.deleted).map(item => ({ kind: 'noteFolder' as const, id: item.id, clock: item.clocks.deleted, title: item.values.name, preview: '目录中的笔记和子目录保留在根目录；恢复后重新归入此目录。', bytes: 0 })),
    ...workspace.boardCards.filter(item => item.values.deleted).map(item => ({ kind: 'boardCard' as const, id: item.id, clock: item.clocks.deleted, title: boardCardTitle(item, workspace), preview: '恢复后会回到看板原来的位置。原任务和便签不受影响。', bytes: 0 })),
    ...workspace.tasks.filter(item => item.values.deleted).map(item => ({ kind: 'task' as const, id: item.id, clock: item.clocks.deleted, title: item.values.title, preview: item.values.notes.slice(0, 160), bytes: 0 })),
    ...workspace.notes.filter(item => item.values.deleted).map(item => ({ kind: 'note' as const, id: item.id, clock: item.clocks.deleted, title: item.values.title || '无标题便签', preview: item.values.content.slice(0, 160), bytes: 0 })),
    ...workspace.lists.filter(item => item.values.deleted).map(item => ({ kind: 'list' as const, id: item.id, clock: item.clocks.deleted, title: item.values.name, preview: '原清单中的任务已保留在“任务”中。', bytes: 0 })),
    ...workspace.steps.filter(item => item.values.deleted && !tasks.get(item.values.taskId)?.values.deleted).map(item => ({ kind: 'step' as const, id: item.id, clock: item.clocks.deleted, title: item.values.title, preview: tasks.get(item.values.taskId)?.values.title ?? '', bytes: 0 })),
  ].sort((a, b) => b.clock.tick - a.clock.tick || a.id.localeCompare(b.id));
}
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
