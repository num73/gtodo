import { contextBridge, ipcRenderer } from 'electron';
import type { CaptureAPI } from '../src/shared/screen-capture';
const api: CaptureAPI = {
  getPreview: () => ipcRenderer.invoke('gtodo:capture-preview'),
  ready: () => ipcRenderer.invoke('gtodo:capture-ready'),
  select: rect => ipcRenderer.invoke('gtodo:capture-select', rect),
  cancel: () => ipcRenderer.invoke('gtodo:capture-cancel'),
};
contextBridge.exposeInMainWorld('screenCapture', api);
