import { useState } from 'react';
import { FolderOpen, RefreshCw, Check, Download, Upload, AlertCircle, Minus, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { noteColors, noteColorNames, zoomSteps, type AppState, type DesktopAPI, type ZoomAction } from '../shared/model';
import { resolveStartupView, startupViews, type UserPreferences } from '../shared/preferences';
import { defaultPaneLayout } from '../shared/layout';
import { textBackgrounds } from '../shared/board';
import type { PomodoroController } from '../pomodoro/usePomodoro';
import PomodoroSettings from '../pomodoro/PomodoroSettings';
import Modal from './Modal';
import OutlookCalendarSettings from './OutlookCalendarSettings';
import GitSettings from './GitSettings';
import RecycleBin from './RecycleBin';

function cleanError(error: unknown) { return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
const categories = ['常规', '显示与样式', '专注与提醒', '数据与同步'] as const;
export default function Settings({ state, api, pomodoro, close, update, toast }: { state: AppState; api: DesktopAPI; pomodoro: PomodoroController; close: () => void; update: (state: AppState) => void; toast: (text: string) => void }) {
  const [category, setCategory] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [trashOpen, setTrashOpen] = useState(false);
  const [purgeInbox, setPurgeInbox] = useState(false);
  const [colorEdit, setColorEdit] = useState<{ key: 'boardTextBackground' | 'boardTextColor'; label: string; value: string } | null>(null);
  async function execute(action: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await action(); } catch (error) { setError(cleanError(error)); } finally { setBusy(false); }
  }
  function zoom(action: ZoomAction) { void execute(async () => update(await api.setZoom(action))); }
  function preference(patch: Partial<UserPreferences>) { void execute(async () => update(await api.setPreferences(patch))); }
  const prefs = state.preferences;
  const working = busy || pomodoro.busy;
  if (trashOpen) return <RecycleBin api={api} close={() => setTrashOpen(false)} update={update} toast={toast} />;
  return <Modal title="设置" close={close} wide busy={working}>
    <div className="settings-body">
      <div className="settings-tabs" role="tablist" aria-label="设置类别">{categories.map((name, index) => <button key={name} id={`settings-tab-${index}`} role="tab" aria-selected={category === index} aria-controls={`settings-panel-${index}`} tabIndex={category === index ? 0 : -1} onClick={() => setCategory(index)} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? categories.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + categories.length) % categories.length;
        setCategory(next); document.getElementById(`settings-tab-${next}`)?.focus();
      }}>{name}</button>)}</div>
      <p className="setting-description settings-save-hint">偏好仅用于本机。自定义颜色和时长点击保存，其他选项自动保存。</p>
      <section id="settings-panel-0" role="tabpanel" aria-labelledby="settings-tab-0" hidden={category !== 0}>
        <label className="settings-option"><span><strong>启动默认页面</strong><small>下次打开应用时生效。</small></span><select aria-label="启动默认页面" value={resolveStartupView(prefs)} disabled={busy} onChange={event => preference({ startupView: event.target.value as UserPreferences['startupView'] })}>{startupViews.filter(view => prefs.inboxVisible || view.value !== 'inbox').map(view => <option key={view.value} value={view.value}>{view.label}</option>)}</select></label>
        <label className="settings-option settings-option-stack"><span><strong>关闭主窗口时</strong><small>后台运行时可点击系统托盘图标重新打开。</small></span><select aria-label="关闭主窗口时" value={prefs.closeAction} disabled={busy} onChange={event => preference({ closeAction: event.target.value as UserPreferences['closeAction'] })}><option value="auto">有便签、计时或日历同步时留在后台</option><option value="background">始终留在后台</option><option value="quit">退出 GTodo</option></select></label>
        <Toggle label="启动时恢复便签" description="恢复上次未收起的便签；关闭此项不会删除内容。" checked={prefs.restoreNotes} disabled={busy} change={restoreNotes => preference({ restoreNotes })} />
        <Toggle label="启动时恢复番茄钟窗口" description="恢复上次打开的窗口，计时仍需手动继续。" checked={prefs.restorePomodoro} disabled={busy} change={restorePomodoro => preference({ restorePomodoro })} />
      </section>
      <section id="settings-panel-1" role="tabpanel" aria-labelledby="settings-tab-1" hidden={category !== 1}>
        <div className="zoom-setting-row"><h3 className="section-label">界面缩放</h3><div className="zoom-setting-controls"><button className="icon-button" aria-label="缩小界面" disabled={busy || state.zoom <= zoomSteps[0]} onClick={() => zoom('out')}><Minus size={17} /></button><select aria-label="界面缩放比例" value={state.zoom} disabled={busy} onChange={event => zoom(Number(event.target.value))}>{zoomSteps.map(value => <option key={value} value={value}>{value}%</option>)}</select><button className="icon-button" aria-label="放大界面" disabled={busy || state.zoom >= zoomSteps.at(-1)!} onClick={() => zoom('in')}><Plus size={17} /></button><button className="icon-button" aria-label="恢复默认缩放" title="恢复 100%" disabled={busy || state.zoom === 100} onClick={() => zoom('reset')}><RotateCcw size={16} /></button></div></div>
        <div className="shortcut-hints"><span><kbd>Ctrl</kbd> + <kbd>+</kbd> / <kbd>−</kbd> 缩放</span><span><kbd>Ctrl</kbd> + <kbd>0</kbd> 恢复</span><span><kbd>Ctrl</kbd> + 滚轮</span></div>
        <div className="settings-option"><span><strong>分栏宽度</strong><small>恢复左侧导航和任务详情栏的默认宽度。</small></span><button className="button secondary" disabled={busy} onClick={() => void execute(async () => { update(await api.setPaneLayout({ ...defaultPaneLayout })); toast('分栏宽度已恢复默认'); })}><RotateCcw size={15} />重置分栏宽度</button></div>
        <Toggle label="默认展开已完成任务" description="用于普通任务列表；搜索和“已完成”页面始终显示完成记录。" checked={prefs.showCompleted} disabled={busy} change={showCompleted => preference({ showCompleted })} />
        <label className="settings-option"><span><strong>新便签默认颜色</strong><small>只影响之后新建的便签。</small></span><select aria-label="新便签默认颜色" value={prefs.noteColor} disabled={busy} onChange={event => preference({ noteColor: event.target.value as UserPreferences['noteColor'] })}>{noteColors.map(color => <option key={color} value={color}>{noteColorNames[color]}</option>)}</select></label>
        <div className="settings-divider" />
        <h3 className="section-label">看板文字 / 标语默认样式</h3>
        <p className="setting-description">只影响之后添加的文字，已贴到看板的内容保持原样。</p>
        <fieldset className="board-color-presets" disabled={busy}><legend>默认背景预设</legend><div className="board-color-options">{textBackgrounds.map(option => <button key={option.color} type="button" aria-label={`默认${option.name}背景`} aria-pressed={prefs.boardTextBackground.toLowerCase() === option.color} onClick={() => preference({ boardTextBackground: option.color })}><span className="board-color-swatch" style={{ backgroundColor: option.color }}>{prefs.boardTextBackground.toLowerCase() === option.color && <Check size={16} />}</span><span>{option.name}</span></button>)}</div></fieldset>
        <div className="settings-style-controls">
          <label>自定义背景<button type="button" className="settings-color-button" aria-label="看板文字默认背景" style={{ backgroundColor: prefs.boardTextBackground }} disabled={busy} onClick={() => { setError(''); setColorEdit({ key: 'boardTextBackground', label: '看板文字默认背景', value: prefs.boardTextBackground }); }} /></label>
          <label>文字颜色<button type="button" className="settings-color-button" aria-label="看板文字默认颜色" style={{ backgroundColor: prefs.boardTextColor }} disabled={busy} onClick={() => { setError(''); setColorEdit({ key: 'boardTextColor', label: '看板文字默认颜色', value: prefs.boardTextColor }); }} /></label>
          <label>字号<select aria-label="看板文字默认字号" value={prefs.boardTextFontSize} disabled={busy} onChange={event => preference({ boardTextFontSize: Number(event.target.value) })}>{[...new Set([14, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 96, prefs.boardTextFontSize])].sort((a, b) => a - b).map(size => <option key={size} value={size}>{size}</option>)}</select></label>
        </div>
        <div className="settings-text-preview" aria-label="看板文字样式预览" style={{ backgroundColor: prefs.boardTextBackground, color: prefs.boardTextColor, fontSize: prefs.boardTextFontSize }}>把想做的事，放在眼前</div>
      </section>
      <section id="settings-panel-2" role="tabpanel" aria-labelledby="settings-tab-2" hidden={category !== 2}>
        <Toggle label="任务提醒通知" description="任务设置的提醒时间到达时发送系统通知。" checked={prefs.taskNotifications} disabled={busy} change={taskNotifications => preference({ taskNotifications })} />
        <Toggle label="番茄钟结束提醒" description="专注或休息结束时发送通知并提示窗口；关闭后仍记录完成次数。" checked={prefs.pomodoroNotifications} disabled={busy} change={pomodoroNotifications => preference({ pomodoroNotifications })} />
        <p className="setting-description">提醒需要 GTodo 保持运行，并允许系统通知。关闭提醒不会修改任务设置的提醒时间。</p>
        <div className="settings-divider" />
        <h3 className="section-label">番茄钟时长</h3>
        <PomodoroSettings controller={pomodoro} onSaved={() => toast('番茄钟时长已保存')} />
        {(pomodoro.error || pomodoro.snapshot?.error) && <p className="inline-error" role="alert">{pomodoro.error || pomodoro.snapshot?.error}</p>}
      </section>
      <section id="settings-panel-3" role="tabpanel" aria-labelledby="settings-tab-3" hidden={category !== 3}>
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
      <GitSettings state={state} api={api} active={category === 3} update={update} />
      <div className="settings-divider" />
      <div className="backup-row"><div><h3 className="section-label">回收站</h3><p>恢复已删除的记录，或永久清理文件。</p></div><button className="button secondary" disabled={busy} onClick={() => setTrashOpen(true)}><Trash2 size={16} />打开回收站</button></div>
      {!prefs.inboxVisible && !prefs.inboxPurged && <div className="settings-option" aria-label="已删除的任务清单"><span><strong>已删除的“任务”清单</strong><small>原有任务仍在“全部任务”中。此清单入口仅保存在本机。</small></span><div className="button-row"><button className="button secondary" disabled={busy} onClick={() => preference({ inboxVisible: true })}><RotateCcw size={15} />还原清单</button><button className="button secondary danger-text" disabled={busy} onClick={() => setPurgeInbox(true)}><Trash2 size={15} />永久删除清单</button></div></div>}
      <div className="settings-divider" />
      <OutlookCalendarSettings state={state} api={api} busy={busy} execute={execute} update={update} />
      <div className="settings-divider" />
      <div className="backup-row"><div><h3 className="section-label">数据备份</h3><p>ZIP 包含正文、图片和历史版本，也支持原有 JSON 备份。导入时合并数据。</p><p>本机自动保留最近 24 份小时备份和 7 份每日备份。</p></div><div className="button-row"><button className="button secondary" disabled={busy} onClick={() => void execute(async () => { if (await api.exportBackup()) toast('备份已导出'); })}><Download size={16} />导出</button><button className="button secondary" disabled={busy} onClick={() => void execute(async () => update(await api.importBackup()))}><Upload size={16} />导入</button></div></div>
      </section>
      <div className="settings-footer"><div className="settings-about"><span>GTodo v{state.version}</span><span className="settings-contact">作者邮箱：xlnum73@outlook.com</span></div><button className="text-button app-quit-button" disabled={working} title="保存内容并关闭所有 GTodo 窗口" onClick={() => api.quit()}>退出 GTodo</button></div>
      <p className="settings-footnote">“退出 GTodo”会保存内容、暂停计时并关闭所有窗口。</p>
    </div>
    {error && !colorEdit && <div className="inline-error" role="alert"><AlertCircle size={18} /><span>{error}</span></div>}
    {purgeInbox && <Modal title="永久删除“任务”清单" close={() => setPurgeInbox(false)} busy={busy}><div className="list-form"><p className="setting-description">永久删除后，将清除这个清单的还原入口，无法撤销。里面的任务和备注仍保留在“全部任务”中。</p>{error && <p className="error-text" role="alert">{error}</p>}<div className="form-footer"><button autoFocus className="button secondary" disabled={busy} onClick={() => setPurgeInbox(false)}>取消</button><button className="button danger-button" disabled={busy} onClick={() => void execute(async () => { update(await api.setPreferences({ inboxPurged: true })); setPurgeInbox(false); toast('清单已永久删除，任务已保留'); })}>确认永久删除</button></div></div></Modal>}
    {colorEdit && <Modal title={colorEdit.label} close={() => { setColorEdit(null); setError(''); }} busy={busy}>
      <form className="board-form" onSubmit={event => { event.preventDefault(); void execute(async () => { update(await api.setPreferences({ [colorEdit.key]: colorEdit.value })); setColorEdit(null); }); }}>
        <label>选择颜色<input type="color" aria-label="自定义默认颜色" autoFocus value={colorEdit.value} disabled={busy} onChange={event => setColorEdit({ ...colorEdit, value: event.target.value })} /></label>
        <div className="settings-text-preview" style={{ backgroundColor: colorEdit.key === 'boardTextBackground' ? colorEdit.value : prefs.boardTextBackground, color: colorEdit.key === 'boardTextColor' ? colorEdit.value : prefs.boardTextColor }}>文字预览</div>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="button-row"><button type="button" className="button secondary" disabled={busy} onClick={() => setColorEdit(null)}>取消</button><button className="button primary" disabled={busy}>保存颜色</button></div>
      </form>
    </Modal>}
  </Modal>;
}

function Toggle({ label, description, checked, disabled, change }: { label: string; description: string; checked: boolean; disabled: boolean; change: (value: boolean) => void }) {
  return <label className="settings-option"><span><strong>{label}</strong><small>{description}</small></span><input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={event => change(event.target.checked)} /></label>;
}
