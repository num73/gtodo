import { useState } from 'react';
import { FolderOpen, RefreshCw, Check, Download, Upload, AlertCircle, Minus, Plus, RotateCcw } from 'lucide-react';
import { zoomSteps, type AppState, type DesktopAPI, type ZoomAction } from '../shared/model';
import Modal from './Modal';
import OutlookCalendarSettings from './OutlookCalendarSettings';

function cleanError(error: unknown) { return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
export default function Settings({ state, api, close, update, toast }: { state: AppState; api: DesktopAPI; close: () => void; update: (state: AppState) => void; toast: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function execute(action: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await action(); } catch (error) { setError(cleanError(error)); } finally { setBusy(false); }
  }
  function zoom(action: ZoomAction) { void execute(async () => update(await api.setZoom(action))); }
  return <Modal title="设置" close={close} wide busy={busy}>
    <div className="settings-body">
      <h3 className="section-label">数据文件夹</h3>
      <div className="data-location-card">
        <div className="folder-path" aria-label="当前数据文件夹">{state.dataPath}</div>
        <div className={`folder-state ${state.folder.error ? 'error-text' : ''}`}>{state.folder.error ? <AlertCircle size={14} /> : <Check size={14} />}<span>{state.folder.error ?? '已保存'}</span></div>
        <div className="folder-buttons"><button className="button primary" disabled={busy} onClick={() => void execute(async () => {
          const next = await api.chooseDataFolder(); update(next);
          if (next.dataPath !== state.dataPath) toast('数据文件夹已更新，原文件已保留');
        })}><FolderOpen size={16} />选择文件夹</button><button className="button secondary" disabled={busy} onClick={() => void execute(() => api.openDataFolder())}>打开文件夹</button><button className="icon-button" aria-label="重新读取文件夹" title="重新读取文件夹" disabled={busy} onClick={() => void execute(async () => update(await api.refreshFolder()))}><RefreshCw size={17} className={busy ? 'spin' : ''} /></button></div>
      </div>
      <p className="setting-description">选择网盘的本地目录，由网盘客户端同步。请将文件保留在本地。</p>
      <p className="setting-description">切换目录会合并数据，保留原文件。</p>
      <div className="settings-divider" />
      <OutlookCalendarSettings state={state} api={api} busy={busy} execute={execute} update={update} />
      <div className="settings-divider" />
      <div className="zoom-setting-row"><h3 className="section-label">界面缩放</h3><div className="zoom-setting-controls"><button className="icon-button" aria-label="缩小界面" disabled={busy || state.zoom <= zoomSteps[0]} onClick={() => zoom('out')}><Minus size={17} /></button><select aria-label="界面缩放比例" value={state.zoom} disabled={busy} onChange={event => zoom(Number(event.target.value))}>{zoomSteps.map(value => <option key={value} value={value}>{value}%</option>)}</select><button className="icon-button" aria-label="放大界面" disabled={busy || state.zoom >= zoomSteps.at(-1)!} onClick={() => zoom('in')}><Plus size={17} /></button><button className="icon-button" aria-label="恢复默认缩放" title="恢复 100%" disabled={busy || state.zoom === 100} onClick={() => zoom('reset')}><RotateCcw size={16} /></button></div></div>
      <div className="shortcut-hints"><span><kbd>Ctrl</kbd> + <kbd>+</kbd> / <kbd>−</kbd> 缩放</span><span><kbd>Ctrl</kbd> + <kbd>0</kbd> 恢复</span><span><kbd>Ctrl</kbd> + 滚轮</span></div>
      <div className="settings-divider" />
      <div className="backup-row"><div><h3 className="section-label">数据备份</h3><p>JSON 格式，导入时合并数据。</p></div><div className="button-row"><button className="button secondary" disabled={busy} onClick={() => void execute(async () => { if (await api.exportBackup()) toast('备份已导出'); })}><Download size={16} />导出</button><button className="button secondary" disabled={busy} onClick={() => void execute(async () => update(await api.importBackup()))}><Upload size={16} />导入</button></div></div>
      <div className="settings-footer"><span>GTodo v{state.version}</span><button className="text-button app-quit-button" title="保存内容并关闭所有 GTodo 窗口" onClick={() => api.quit()}>退出 GTodo</button></div>
      <p className="settings-footnote">关闭主窗口后，便签、番茄钟和已开启的日历同步继续运行。退出时保存内容并暂停计时。</p>
    </div>
    {error && <div className="inline-error" role="alert"><AlertCircle size={18} /><span>{error}</span></div>}
  </Modal>;
}
