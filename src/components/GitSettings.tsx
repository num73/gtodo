import { useEffect, useState } from 'react';
import { GitBranch, RefreshCw } from 'lucide-react';
import type { AppState, DesktopAPI } from '../shared/model';
import type { GitStatus } from '../shared/git';
export default function GitSettings({ state, api, active, update }: { state: AppState; api: DesktopAPI; active: boolean; update: (state: AppState) => void }) {
  const [status, setStatus] = useState<GitStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [remote, setRemote] = useState(''), [userName, setUserName] = useState(''), [userEmail, setUserEmail] = useState('');
  useEffect(() => {
    if (!active) return; let alive = true;
    void api.getGitStatus().then(next => { if (alive) { setStatus(next); setRemote(next.remote); setUserName(next.userName); setUserEmail(next.userEmail); } }).catch(error => { if (alive) setError(String(error)); });
    return () => { alive = false; };
  }, [api, active, state.dataPath]);
  async function configure(enabled: boolean, initialize = false) {
    setBusy(true); setError('');
    try {
      const next = await api.configureGit({ enabled, initialize, ...(enabled ? {
        ...(remote !== status?.remote ? { remote } : {}), ...(userName !== status?.userName ? { userName } : {}), ...(userEmail !== status?.userEmail ? { userEmail } : {}),
      } : {}) });
      setStatus(next); setRemote(next.remote); setUserName(next.userName); setUserEmail(next.userEmail); update(await api.getState());
    }
    catch (error) { setError((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    finally { setBusy(false); }
  }
  return <section className="git-settings" aria-label="Git 同步设置"><h3 className="section-label"><GitBranch size={16} />Git 同步</h3>
    <p className="setting-description">将当前数据文件夹作为独立仓库。开启后可从标题栏手动暂存、提交、拉取和推送；需要本机已安装 Git。</p>
    {status && <p className="setting-description">{status.repository ? `当前分支：${status.branch || '未在分支上'}` : '当前数据文件夹尚未初始化独立仓库'} · {state.gitEnabled ? '已启用' : '未启用'}</p>}
    <form className="git-config-form" onSubmit={event => { event.preventDefault(); void configure(true, !status?.repository); }}>
      <label>远程仓库地址（origin）<input aria-label="Git 远程仓库地址" placeholder="https://… 或 git@…（可稍后填写）" value={remote} onChange={event => setRemote(event.target.value)} disabled={busy} maxLength={2000} /></label>
      <div className="git-identity"><label>提交用户名<input aria-label="Git 提交用户名" value={userName} onChange={event => setUserName(event.target.value)} disabled={busy} maxLength={200} /></label><label>提交邮箱<input aria-label="Git 提交邮箱" value={userEmail} onChange={event => setUserEmail(event.target.value)} disabled={busy} maxLength={254} /></label></div>
      <p className="setting-description">身份设置仅用于此仓库。远程认证使用本机 Git 的凭据或 SSH 配置。</p>
      <div className="button-row"><button className="button primary" disabled={busy || !status?.installed}>{busy ? '处理中…' : !status?.repository ? '初始化 Git 并启用' : state.gitEnabled ? '保存 Git 设置' : '启用 Git 同步'}</button>
        {state.gitEnabled && <button type="button" className="button secondary" disabled={busy} onClick={() => void configure(false)}>停用 Git 同步</button>}
        <button type="button" className="icon-button" aria-label="刷新 Git 状态" disabled={busy} onClick={() => { setError(''); void api.getGitStatus().then(setStatus).catch(error => setError(String(error))); }}><RefreshCw size={16} /></button></div>
    </form>
    {(error || status?.error) && <p className="inline-error" role="alert">{error || status?.error}</p>}
  </section>;
}
