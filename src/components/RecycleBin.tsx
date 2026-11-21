import { useEffect, useState } from 'react';
import { AlertCircle, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import type { AppState, DesktopAPI } from '../shared/model';
import { formatBytes, trashKindNames, type TrashSnapshot, type TrashTarget } from '../shared/trash';
import Modal from './Modal';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
export default function RecycleBin({ api, close, update, toast }: {
  api: DesktopAPI; close: () => void; update: (state: AppState) => void; toast: (text: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<TrashSnapshot | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(50);
  const [confirmation, setConfirmation] = useState<{ targets: TrashTarget[]; title: string } | null>(null);
  useEffect(() => {
    let active = true;
    void api.getTrash().then(value => { if (active) setSnapshot(value); }, error => { if (active) setError(errorText(error)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api]);
  async function execute(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); }
    catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  }
  const items = snapshot?.items ?? [];
  const filtered = items.filter(item => `${item.title}\n${item.preview}\n${trashKindNames[item.kind]}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const total = items.reduce((sum, item) => sum + item.bytes, 0) + (snapshot?.residualBytes ?? 0);
  const target = (item: TrashTarget): TrashTarget => ({ kind: item.kind, id: item.id, clock: item.clock });
  return <Modal title="回收站" close={() => confirmation ? setConfirmation(null) : close()} wide busy={busy}>
    <div className="recycle-body">
      {confirmation ? <div role="alertdialog" aria-label="永久删除确认">
        <h3>{confirmation.title}</h3>
        <p className="setting-description">{confirmation.targets.length ? '将清理所选记录的正文、附件和文件备份，无法撤销。仍被其他记录使用的图片会保留。' : '将清理已永久删除记录的残留文件、未引用的图片及已过保留期的数据块。当前记录、回收站和保留的历史版本不会删除。'}</p>
        <div className="form-footer"><button autoFocus className="button secondary" disabled={busy} onClick={() => setConfirmation(null)}>取消</button><button className="button danger-button" disabled={busy} onClick={() => void execute(async () => {
          const result = await api.purgeTrash(confirmation.targets);
          setConfirmation(null);
          if (result.error) setError(result.error);
          else toast(`清理完成，释放 ${formatBytes(result.freedBytes)}`);
          setSnapshot(await api.getTrash());
        })}>{busy ? '正在清理…' : '确认永久删除'}</button></div>
      </div> : <>
        <div className="recycle-toolbar"><div><strong>{snapshot ? items.length : '—'} 项</strong><span className="recycle-size">文件占用 {!snapshot || snapshot.error ? '未能统计' : formatBytes(total)}</span></div>
          <div className="button-row"><button className="icon-button" aria-label="刷新回收站" title="刷新" disabled={busy} onClick={() => void execute(async () => setSnapshot(await api.getTrash()))}><RefreshCw size={16} className={busy ? 'spin' : ''} /></button>
            <button className="button secondary danger-text" disabled={busy || !items.length || !!snapshot?.error} onClick={() => setConfirmation({ targets: items.map(target), title: `清空回收站中的 ${items.length} 项？` })}><Trash2 size={15} />清空回收站</button></div>
        </div>
        <p className="setting-description">清理当前数据文件夹。普通修改留下的数据块，连续 7 天未被任何设备索引或保留的备份引用后自动回收。手动备份、旧数据目录和其他设备的快照会保留。</p>
        <input className="recycle-search" aria-label="搜索回收站" placeholder="搜索名称或内容" value={query} disabled={busy} onChange={event => { setQuery(event.target.value); setLimit(50); }} />
        <div className="recycle-items" aria-label="已删除的记录" aria-busy={busy}>
          {!snapshot ? <p className="recycle-empty">{busy ? '正在读取…' : '无法读取回收站'}</p> : filtered.length === 0 ? <p className="recycle-empty">{query ? '没有匹配的记录' : '回收站为空'}</p> : filtered.slice(0, limit).map(item => <article className="recycle-item" key={`${item.kind}:${item.id}`} aria-label={`${trashKindNames[item.kind]}：${item.title}`}>
            <div className="recycle-item-content"><h3>{item.title}</h3><div className="recycle-meta"><span>{trashKindNames[item.kind]}</span><span>{new Date(item.clock.tick).toLocaleString('zh-CN')}</span><span>{formatBytes(item.bytes)}</span></div>{item.preview && <p className="recycle-preview">{item.preview}</p>}</div>
            <div className="recycle-actions"><button className="text-button" disabled={busy} onClick={() => void execute(async () => { update(await api.restoreTrash(target(item))); setSnapshot(await api.getTrash()); toast('已恢复'); })}><RotateCcw size={14} />恢复</button><button className="text-button danger-text" disabled={busy || !!snapshot?.error} onClick={() => setConfirmation({ targets: [target(item)], title: `永久删除“${item.title}”？` })}><Trash2 size={14} />永久删除</button></div>
          </article>)}
          {filtered.length > limit && <button className="text-button recycle-more" disabled={busy} onClick={() => setLimit(value => value + 50)}>显示更多（剩余 {filtered.length - limit} 项）</button>}
        </div>
        {!!snapshot?.residualFiles && <div className="recycle-residual"><span>残留文件与未引用图片缓存 · {formatBytes(snapshot.residualBytes)}</span><button className="text-button danger-text" disabled={busy || !!snapshot.error} onClick={() => setConfirmation({ targets: [], title: '清理残留文件和未引用的图片缓存？' })}>清理残留文件</button></div>}
        <p className="settings-footnote">永久删除会保留少量同步标识，防止旧副本恢复记录。记录列表的占用不包含索引内的文本；清理时也会移除本设备索引和自动备份中的对应记录。</p>
      </>}
      {(error || snapshot?.error) && <div className="inline-error" role="alert"><AlertCircle size={18} /><span>{error || snapshot?.error}</span></div>}
    </div>
  </Modal>;
}
