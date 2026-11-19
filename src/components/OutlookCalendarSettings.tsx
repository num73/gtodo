import { useState } from 'react';
import { CalendarDays, RefreshCw } from 'lucide-react';
import type { AppState, DesktopAPI } from '../shared/model';
import type { OutlookCalendarOption } from '../shared/outlook';

export default function OutlookCalendarSettings({ state, api, busy, execute, update }: {
  state: AppState; api: DesktopAPI; busy: boolean;
  execute: (action: () => Promise<unknown>) => Promise<void>; update: (state: AppState) => void;
}) {
  const [calendars, setCalendars] = useState<OutlookCalendarOption[]>([]);
  const [selected, setSelected] = useState('');
  const status = state.outlook;
  const refresh = () => execute(async () => {
    const found = await api.listOutlookCalendars(); setCalendars(found); setSelected(found[0]?.id ?? '');
  });
  const configure = (enabled: boolean, calendarId?: string) => execute(async () => {
    update(await api.configureOutlook({ enabled, ...(calendarId ? { calendarId } : {}) }));
    setCalendars([]); setSelected('');
  });
  return <section className="calendar-settings" aria-label="Outlook 日历同步">
    <h3 className="section-label"><span>Outlook 日历</span><span className="setting-badge">{status.enabled ? '已开启' : '未开启'}</span></h3>
    <p className="setting-description">通过经典 Outlook，将有截止日期的任务同步为全天日程。</p>
    {status.targetName && <div className="calendar-target"><CalendarDays size={16} /><span>{status.targetName}</span></div>}
    {status.enabled && <p className={`calendar-status ${status.error ? 'error-text' : ''}`} role="status">
      {status.phase === 'syncing' ? '正在更新 Outlook…' : status.error || (status.lastSyncedAt ? `上次更新 ${new Date(status.lastSyncedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '等待同步')}
    </p>}
    {calendars.length > 0 && !status.enabled && <label className="calendar-select">Outlook 账户日历<select aria-label="Outlook 账户日历" value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}>{calendars.map(calendar => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}</select></label>}
    <div className="button-row calendar-actions">
      {status.enabled ? <><button className="button secondary" disabled={busy || status.phase === 'syncing'} onClick={() => void execute(async () => update(await api.syncOutlook()))}><RefreshCw size={15} className={status.phase === 'syncing' ? 'spin' : ''} />立即同步</button><button className="button secondary" disabled={busy} onClick={() => void configure(false)}>停止同步</button></> : <>
        {selected ? <button className="button primary" disabled={busy} onClick={() => void configure(true, selected)}>开启同步</button> : status.targetName && <button className="button primary" disabled={busy} onClick={() => void configure(true)}>恢复同步</button>}
        <button className="button secondary" disabled={busy} onClick={() => void refresh()}>{calendars.length ? '重新读取' : status.targetName ? '更换日历' : '读取 Outlook 日历'}</button>
      </>}
    </div>
    <details className="calendar-help"><summary>同步说明</summary><p>在所选账户下创建独立的 GTodo 日历。标题、备注、步骤和完成状态单向更新；删除任务或清除截止日期会移除对应日程。在 Outlook 修改这些日程会被 GTodo 覆盖。</p><p>提醒仍由 GTodo 发送。重复任务在完成后同步下一次任务。停止同步或更换日历会保留原日程。同一份任务请只在一台电脑开启此同步。</p><p>需要经典 Outlook 已配置账户。云端传输由 Outlook 处理；同一云端账户的新 Outlook 可以查看同步日历。本地数据文件日历不会自动上传到云端。</p></details>
  </section>;
}
