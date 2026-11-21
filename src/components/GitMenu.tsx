import { useEffect, useRef, useState } from 'react';
import { GitBranch, Plus, GitCommitHorizontal, ArrowDownToLine, ArrowUpFromLine, RefreshCw, X } from 'lucide-react';
import type { DesktopAPI } from '../shared/model';
import type { GitAction, GitStatus } from '../shared/git';
export default function GitMenu({ api }: { api: DesktopAPI }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [status, setStatus] = useState<GitStatus | null>(null);
  const [message, setMessage] = useState(''), [feedback, setFeedback] = useState(''), [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  async function refresh() { setError(''); try { setStatus(await api.getGitStatus()); } catch (error) { setError(String(error)); } }
  useEffect(() => { if (open) void refresh(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!busy && !root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close);
  }, [open, busy]);
  async function run(action: GitAction) {
    if (busy) return; setBusy(true); setError(''); setFeedback('');
    try { await api.gitAction(action); setStatus(await api.getGitStatus()); if (action.type === 'commit') setMessage(''); setFeedback(`${action.type === 'add' ? '暂存' : action.type === 'commit' ? '提交' : action.type === 'pull' ? '拉取' : '推送'}完成`); }
    catch (error) { setError((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); void api.getGitStatus().then(setStatus).catch(() => {}); }
    finally { setBusy(false); }
  }
  const staged = status?.files.filter(file => file.index !== '?' && file.index !== ' ').length ?? 0;
  return <div className="git-menu" ref={root} onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); if (!busy) { setOpen(false); trigger.current?.focus(); } } }}>
    <button ref={trigger} className="git-menu-trigger" aria-label="Git 同步菜单" title="Git 同步" aria-expanded={open} onClick={() => setOpen(value => !value)}><GitBranch size={16} />{busy && <span className="git-busy-dot" />}</button>
    {open && <div className="git-popover" role="dialog" aria-label="Git 同步菜单"><header><strong><GitBranch size={16} />{status?.branch || 'Git 同步'}</strong><button className="icon-button" aria-label="关闭 Git 菜单" disabled={busy} onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={16} /></button></header>
      <p className="git-summary">{status ? `${status.files.length} 个变更 · ${staged} 个已暂存 · ↑ ${status.ahead} ↓ ${status.behind}` : '正在读取仓库…'}</p>
      <div className="git-operation-buttons">
        <button className="button secondary" disabled={busy || !status?.repository || !status.files.length} onClick={() => void run({ type: 'add' })}><Plus size={15} />Add · 暂存</button>
        <button className="button secondary" disabled={busy || !status?.repository} onClick={() => void run({ type: 'pull' })}><ArrowDownToLine size={15} />Pull · 拉取</button>
        <button className="button secondary" disabled={busy || !status?.repository} onClick={() => void run({ type: 'push' })}><ArrowUpFromLine size={15} />Push · 推送</button>
        <button className="button secondary" disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} />刷新</button>
      </div>
      <form onSubmit={event => { event.preventDefault(); void run({ type: 'commit', message }); }}><label>提交说明<textarea aria-label="Git 提交说明" rows={2} maxLength={4000} value={message} disabled={busy} onChange={event => setMessage(event.target.value)} placeholder="记录这次修改" /></label><button className="button primary" disabled={busy || !message.trim() || !staged}><GitCommitHorizontal size={15} />Commit · 提交</button></form>
      {!!status?.files.length && <details><summary>查看变更文件</summary><ul>{status.files.slice(0, 100).map(file => <li key={file.path}><code>{file.index}{file.worktree}</code><span>{file.path}</span></li>)}</ul>{status.files.length > 100 && <small>仅显示前 100 个文件</small>}</details>}
      {busy && <p role="status">正在执行 Git 操作…</p>}{feedback && <p role="status">{feedback}</p>}{(error || status?.error) && <p className="inline-error" role="alert">{error || status?.error}</p>}
    </div>}
  </div>;
}
