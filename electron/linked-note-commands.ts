import type { Command, Workspace } from '../src/shared/model';
import { linkedNoteForTask, linkedTaskForNote } from '../src/shared/note-links';

export async function applyCommandWithDrafts(command: Command, options: {
  workspace: () => Workspace;
  flushMain: () => Promise<boolean>;
  withSavedNote: (id: string, action: () => Promise<unknown>) => Promise<unknown>;
  update: (command: Command) => Promise<unknown>;
}) {
  const deletingTask = command.type === 'task.update' && command.patch.deleted === true;
  const deletingNote = command.type === 'note.update' && command.patch.deleted === true;
  const workspace = options.workspace();
  let noteId: string | undefined;
  let flushMain = deletingTask;
  if (deletingTask) {
    const task = workspace.tasks.find(task => task.id === command.id);
    noteId = task && linkedNoteForTask(workspace, task)?.id;
  } else if (deletingNote) {
    noteId = command.id;
    const note = workspace.notes.find(note => note.id === command.id);
    flushMain = !!note && !!linkedTaskForNote(workspace, note);
  }
  if (flushMain && !await options.flushMain()) throw new Error('任务修改尚未保存，已取消删除。请检查保存提示后重试。');
  const update = () => options.update(command);
  if (noteId) await options.withSavedNote(noteId, update); else await update();
}
