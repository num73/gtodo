import { useEffect, useState, lazy, Suspense } from 'react';
import type { DocumentTarget } from '../shared/documents';
import type { documentHistory } from '../shared/document-history';
import Modal from './Modal';
const Preview = lazy(() => import('./MarkdownPreview'));
export default function DocumentHistory({ target, close }: { target: DocumentTarget; close: () => void }) {
  const [history, setHistory] = useState<ReturnType<typeof documentHistory> | null>(null);
  const [selectedId, setSelectedId] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let active = true;
    void window.gtodo!.getDocumentHistory(target).then(value => { if (active) { setHistory(value); setSelectedId(value.versions[0]?.id ?? ''); } }, error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [target.kind, target.id]);
  const selected = history?.versions.find(version => version.id === selectedId);
  return <Modal title="正文历史版本" close={() => confirm ? setConfirm(false) : close()} wide busy={busy}><div className="document-history">
    {history && history.heads.length > 1 && <p className="notice" role="status">这篇文档有不同设备的修改版本，已分别保留。可选择版本查看并还原。</p>}
    {confirm ? <><p>将用所选历史版本替换当前正文和图片。当前内容仍保留在历史记录中。</p><div className="form-footer"><button autoFocus className="button secondary" disabled={busy} onClick={() => setConfirm(false)}>取消</button><button className="button primary" disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { await window.gtodo!.restoreDocumentVersion(target, selectedId); close(); }
      catch (error) { setError((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
      finally { setBusy(false); }
    }}>{busy ? '正在还原…' : '确认还原版本'}</button></div></> : <>
      <label>选择历史版本<select aria-label="选择历史版本" value={selectedId} disabled={!history?.versions.length} onChange={event => setSelectedId(event.target.value)}>{history?.versions.map(version => <option key={version.id} value={version.id}>{new Date(version.clock.tick).toLocaleString('zh-CN')}{history.heads.length > 1 && history.heads.includes(version.id) ? ' · 分支版本' : ''} · {version.content.slice(0, 24).replaceAll('\n', ' ') || '空白正文'}</option>)}</select></label>
      {!history ? <p>正在读取…</p> : !selected ? <p>暂无正文历史版本。</p> : <div className="document-history-preview"><Suspense fallback={<p>正在加载预览…</p>}><Preview value={selected.content} label="历史正文" target={target} assets={selected.assets} openLink={url => void window.gtodo!.openLink(url)} /></Suspense></div>}
      <div className="form-footer"><button className="button secondary" onClick={close}>关闭</button><button className="button primary" disabled={!selected} onClick={() => setConfirm(true)}>还原此版本</button></div>
    </>}{error && <p className="error-text" role="alert">{error}</p>}
  </div></Modal>;
}
