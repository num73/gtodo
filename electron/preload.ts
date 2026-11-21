import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, AppState } from '../src/shared/model';
import type { PomodoroSnapshot } from '../src/shared/pomodoro';

const api: DesktopAPI = {
  getDocumentHistory: target => ipcRenderer.invoke('gtodo:document-history', target),
  restoreDocumentVersion: (target, versionId) => ipcRenderer.invoke('gtodo:document-restore', { target, versionId }),
  getGitStatus: () => ipcRenderer.invoke('gtodo:git-status'),
  configureGit: input => ipcRenderer.invoke('gtodo:git-configure', input),
  gitAction: input => ipcRenderer.invoke('gtodo:git-action', input),
  getPomodoro: () => ipcRenderer.invoke('gtodo:pomodoro-state'),
  pomodoroCommand: command => ipcRenderer.invoke('gtodo:pomodoro-command', command),
  onPomodoro: callback => {
    const listener = (_event: unknown, state: PomodoroSnapshot) => callback(state);
    ipcRenderer.on('gtodo:pomodoro-changed', listener);
    return () => ipcRenderer.removeListener('gtodo:pomodoro-changed', listener);
  },
  openPomodoro: taskId => ipcRenderer.invoke('gtodo:pomodoro-open', taskId),
  pomodoroWindow: action => ipcRenderer.invoke('gtodo:pomodoro-window', action),
  setPaneLayout: layout => ipcRenderer.invoke('gtodo:pane-layout', layout),
  setPreferences: patch => ipcRenderer.invoke('gtodo:preferences', patch),
  getState: () => ipcRenderer.invoke('gtodo:state'),
  command: value => ipcRenderer.invoke('gtodo:command', value),
  chooseDataFolder: () => ipcRenderer.invoke('gtodo:choose-folder'),
  openDataFolder: () => ipcRenderer.invoke('gtodo:open-folder'),
  refreshFolder: () => ipcRenderer.invoke('gtodo:refresh-folder'),
  setZoom: action => ipcRenderer.invoke('gtodo:zoom', action),
  exportBackup: () => ipcRenderer.invoke('gtodo:export'),
  importBackup: () => ipcRenderer.invoke('gtodo:import'),
  getTrash: () => ipcRenderer.invoke('gtodo:trash'),
  restoreTrash: target => ipcRenderer.invoke('gtodo:trash-restore', target),
  purgeTrash: targets => ipcRenderer.invoke('gtodo:trash-purge', targets),
  listOutlookCalendars: () => ipcRenderer.invoke('gtodo:outlook-list'),
  configureOutlook: input => ipcRenderer.invoke('gtodo:outlook-configure', input),
  syncOutlook: () => ipcRenderer.invoke('gtodo:outlook-sync'),
  createNote: input => ipcRenderer.invoke('gtodo:note-create', input),
  createLinkedNote: taskId => ipcRenderer.invoke('gtodo:note-link', taskId),
  pickBoardImage: input => ipcRenderer.invoke('gtodo:board-image-pick', input),
  insertBoardImage: input => ipcRenderer.invoke('gtodo:board-image', input),
  pickDocumentImage: target => ipcRenderer.invoke('gtodo:document-image-pick', target),
  captureDocumentImage: target => ipcRenderer.invoke('gtodo:document-image-capture', target),
  insertDocumentImage: input => ipcRenderer.invoke('gtodo:document-image', input),
  showDocumentFile: target => ipcRenderer.invoke('gtodo:document-show', target),
  openLink: url => ipcRenderer.invoke('gtodo:open-link', url),
  noteWindow: action => ipcRenderer.invoke('gtodo:note-window', action),
  deleteNote: id => ipcRenderer.invoke('gtodo:note-delete', id),
  showMain: () => ipcRenderer.invoke('gtodo:show-main'),
  showNotebook: id => ipcRenderer.invoke('gtodo:show-notebook', id),
  quit: () => ipcRenderer.send('gtodo:quit'),
  noteFlushed: (requestId, success) => ipcRenderer.invoke('gtodo:note-flushed', { requestId, success }),
  onNoteFlush: callback => {
    const listener = (_event: unknown, requestId: string) => callback(requestId);
    ipcRenderer.on('gtodo:note-flush', listener);
    return () => ipcRenderer.removeListener('gtodo:note-flush', listener);
  },
  windowControl: action => ipcRenderer.send('gtodo:window', action),
  onState: callback => {
    const listener = (_event: unknown, state: AppState) => callback(state);
    ipcRenderer.on('gtodo:changed', listener);
    return () => ipcRenderer.removeListener('gtodo:changed', listener);
  },
};
contextBridge.exposeInMainWorld('gtodo', api);
