import type { Clock, Note, Task, Workspace } from './model';

export function compareClock(a: Clock, b: Clock): number {
  return a.tick - b.tick || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0);
}
function matchesLink(task: Task, note: Note) {
  const link = task.values.noteLink;
  // A deletion changes the lifetime clock. Undo must not silently reconnect two
  // documents that may already have been edited independently after detaching.
  return !!link && !link.detached && link.noteId === note.id && !task.values.deleted && !note.values.deleted
    && compareClock(link.taskLife, task.clocks.deleted) === 0 && compareClock(link.noteLife, note.clocks.deleted) === 0;
}
export function linkedNoteForTask(workspace: Workspace, task: Task) {
  const note = task.values.noteLink && workspace.notes.find(note => note.id === task.values.noteLink!.noteId);
  return note && matchesLink(task, note) ? note : undefined;
}
export function linkedTaskForNote(workspace: Workspace, note: Note) {
  return workspace.tasks.find(task => matchesLink(task, note));
}
export function linkedTasksByNote(workspace: Workspace) {
  const notes = new Map(workspace.notes.map(note => [note.id, note]));
  const linked = new Map<string, Task>();
  for (const task of workspace.tasks) {
    const note = task.values.noteLink && notes.get(task.values.noteLink.noteId);
    if (note && matchesLink(task, note)) linked.set(note.id, task);
  }
  return linked;
}
export function synchronizeLinkedNotes(workspace: Workspace) {
  const notes = new Map(workspace.notes.map(note => [note.id, note]));
  for (const task of workspace.tasks) {
    const link = task.values.noteLink;
    const note = link && notes.get(link.noteId);
    if (!note || !link) continue;
    const active = matchesLink(task, note);
    // Preserve late-arriving edits from the deleted side of the original link.
    // The exact deletion clock prevents undo/re-delete from linking them again.
    const fromTask = active || (link.detached?.side === 'task' && task.values.deleted && !note.values.deleted
      && compareClock(link.detached.clock, task.clocks.deleted) === 0 && compareClock(link.noteLife, note.clocks.deleted) === 0);
    const fromNote = active || (link.detached?.side === 'note' && note.values.deleted && !task.values.deleted
      && compareClock(link.detached.clock, note.clocks.deleted) === 0 && compareClock(link.taskLife, task.clocks.deleted) === 0);
    if (!fromTask && !fromNote) continue;
    for (const [taskField, noteField] of [['notes', 'content'], ['notesFormat', 'format'], ['notesAssets', 'assets']] as const) {
      if (fromTask && compareClock(task.clocks[taskField], note.clocks[noteField]) > 0) {
        Object.assign(note.values, { [noteField]: structuredClone(task.values[taskField]) });
        note.clocks[noteField] = { ...task.clocks[taskField] };
      } else if (fromNote && compareClock(task.clocks[taskField], note.clocks[noteField]) < 0) {
        Object.assign(task.values, { [taskField]: structuredClone(note.values[noteField]) });
        task.clocks[taskField] = { ...note.clocks[noteField] };
      }
    }
  }
  return workspace;
}
