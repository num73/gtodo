import type { Note, Workspace } from './model';
import { compareClock } from './note-links';

export const isDesktopNote = (note: Note) => !note.values.deleted && (note.values.desktop ?? 'visible') === 'visible';
export const isNotebookNote = (note: Note) => !note.values.deleted && note.values.notebook === 'visible';

// Both entry points share one record and one document. Removing one view cannot
// erase the other, including when two devices remove different views offline.
export function normalizeNoteViews(workspace: Workspace) {
  for (const note of workspace.notes) {
    note.values.desktop ??= note.values.deleted ? 'removed' : 'visible';
    note.values.notebook ??= 'none'; note.values.folderId ??= null;
    note.clocks.desktop ??= { ...note.clocks.deleted };
    note.clocks.notebook ??= { tick: 0, device: 'legacy' }; note.clocks.folderId ??= { tick: 0, device: 'legacy' };
    const deleted = note.values.desktop !== 'visible' && note.values.notebook !== 'visible';
    if (note.values.deleted === deleted) continue;
    note.values.deleted = deleted;
    note.clocks.deleted = { ...(compareClock(note.clocks.desktop, note.clocks.notebook) > 0 ? note.clocks.desktop : note.clocks.notebook) };
    if (deleted) for (const task of workspace.tasks) {
      const link = task.values.noteLink;
      if (link?.noteId === note.id && !link.detached) {
        task.values.noteLink = { ...link, detached: { side: 'note', clock: { ...note.clocks.deleted } } };
        if (compareClock(note.clocks.deleted, task.clocks.noteLink) > 0) task.clocks.noteLink = { ...note.clocks.deleted };
      }
    }
  }
  return workspace;
}
export function folderParent(workspace: Workspace, id: string): string | null {
  const folders = new Map(workspace.noteFolders.filter(item => !item.values.deleted).map(item => [item.id, item]));
  const parent = folders.get(id)?.values.parentId;
  const seen = new Set([id]); let current = parent;
  while (current) { if (seen.has(current)) return null; seen.add(current); current = folders.get(current)?.values.parentId; }
  return parent && folders.has(parent) ? parent : null;
}
export function noteFolder(workspace: Workspace, note: Note): string | null {
  return workspace.noteFolders.some(item => item.id === note.values.folderId && !item.values.deleted) ? note.values.folderId : null;
}
