import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseWorkspace, type FolderStatus, type Workspace } from '../src/shared/model';
import { WorkspaceEngine } from '../src/shared/engine';
import { atomicWrite, DataStore } from './storage';
import { PreferencesStore } from './preferences';
import { DocumentFiles, documentEntry } from './document-files';
import type { DocumentTarget } from '../src/shared/documents';

export const MAX_DATA_BYTES = 24 * 1024 * 1024;
// Include conflict copies produced by desktop sync clients, but never temp/backup files.
const snapshotName = /^device-[^\\/]+\.json$/i;
export class FolderStorage {
  status: FolderStatus = { error: null, lastRead: null };
  private queue: Promise<unknown> = Promise.resolve();
  private checking: Promise<void> | null = null;
  constructor(readonly local: DataStore, readonly preferences: PreferencesStore, private changed: () => void = () => {}, readonly documents = new DocumentFiles(local.directory)) {}
  get directory() { return this.preferences.value.dataPath; }
  get ownFile() { return path.join(this.directory, `device-${this.local.engine.deviceId}.json`); }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action); this.queue = next.catch(() => {}); return next;
  }
  async initialize() {
    if (this.directory === path.join(this.preferences.directory, 'data')) await mkdir(this.directory, { recursive: true });
    await this.refresh();
  }
  private async readDirectory(directory: string): Promise<{ workspaces: Workspace[]; contents: Map<string, string> }> {
    const entries = await readdir(directory, { withFileTypes: true });
    const names = entries.filter(entry => entry.isFile() && snapshotName.test(entry.name)).map(entry => entry.name).sort();
    if (names.length > 200) throw new Error('数据文件夹中的设备快照超过 200 份，请整理后重试。');
    const workspaces: Workspace[] = []; const contents = new Map<string, string>(); let total = 0;
    for (const name of names) {
      const file = path.join(directory, name); const info = await stat(file); total += info.size;
      if (info.size > MAX_DATA_BYTES || total > MAX_DATA_BYTES * 4) throw new Error('数据文件过大，已暂停读取。单文件上限为 24 MB。');
      const content = await readFile(file, 'utf8');
      if (Buffer.byteLength(content) > MAX_DATA_BYTES) throw new Error(`文件 ${name} 超过 24 MB。`);
      try { workspaces.push(parseWorkspace(JSON.parse(content))); }
      catch { throw new Error(`文件 ${name} 尚未完整同步或格式损坏，已暂停合并；本机任务已保留。`); }
      contents.set(name, content);
    }
    return { workspaces, contents };
  }
  private encode(workspace: Workspace) {
    const content = JSON.stringify(workspace);
    if (Buffer.byteLength(content) > MAX_DATA_BYTES) throw new Error('待办数据超过 24 MB，仍保存在本机，暂未写入数据文件夹。');
    return content;
  }
  private async reconcile() {
    try {
      const { workspaces, contents } = await this.readDirectory(this.directory);
      const merged = new WorkspaceEngine(this.local.engine.deviceId, this.local.engine.state);
      for (const value of workspaces) merged.merge(value);
      const scan = await this.documents.readChanges(this.directory, merged, [this.local.engine.state, ...workspaces]);
      if (JSON.stringify(merged.state) !== JSON.stringify(this.local.engine.state)) {
        await this.local.update(engine => engine.merge(merged.state));
      }
      const content = this.encode(this.local.engine.state);
      if (contents.get(path.basename(this.ownFile)) !== content) await atomicWrite(this.ownFile, content);
      await this.documents.writeDocuments(this.directory, this.local.engine.state, scan);
      this.status = { error: null, lastRead: new Date().toISOString(), notice: this.documents.notice };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.status = { ...this.status, error: code === 'ENOENT' || code === 'ENOTDIR'
        ? '数据文件夹暂时不可用，任务已保存在此设备。恢复文件夹或重新选择路径后会继续写入。'
        : code === 'EACCES' || code === 'EPERM' ? '数据文件夹不可读写，请检查权限。任务仍保存在此设备。'
        : error instanceof Error ? error.message : '无法读取数据文件夹，请重试。' };
    }
    this.changed();
  }
  refresh(): Promise<void> {
    if (this.checking) return this.checking;
    this.checking = this.enqueue(() => this.reconcile()).finally(() => { this.checking = null; });
    return this.checking;
  }
  update(change: (engine: WorkspaceEngine) => void) {
    return this.enqueue(async () => {
      await this.reconcile();
      await this.local.update(change); // Always commit locally even when the chosen drive is unavailable.
      await this.reconcile();
    });
  }
  changeDirectory(directory: string) {
    return this.enqueue(async () => {
      await this.reconcile();
      if (!path.isAbsolute(directory)) throw new Error('请选择完整的本地文件夹路径。');
      const destination = await stat(directory);
      if (!destination.isDirectory()) throw new Error('请选择文件夹。');
      if (path.resolve(directory) === path.resolve(this.directory)) { await this.reconcile(); return; }
      const { workspaces } = await this.readDirectory(directory);
      const merged = new WorkspaceEngine(this.local.engine.deviceId, this.local.engine.state);
      for (const value of workspaces) merged.merge(value);
      const scan = await this.documents.readChanges(directory, merged, [this.local.engine.state, ...workspaces]);
      const content = this.encode(merged.state);
      await atomicWrite(path.join(directory, `device-${this.local.engine.deviceId}.json`), content);
      await this.documents.writeDocuments(directory, merged.state, scan);
      await this.local.update(engine => engine.merge(merged.state));
      await this.preferences.update(value => { value.dataPath = directory; });
      this.status = { error: null, lastRead: new Date().toISOString() }; this.changed();
    });
  }
  addImage(target: DocumentTarget, bytes: Uint8Array) {
    return this.enqueue(async () => {
      await this.reconcile();
      const entry = documentEntry(this.local.engine.state, target);
      if (entry.format !== 'markdown') throw new Error('请先启用 Markdown。');
      const id = await this.documents.cacheImage(bytes); const relative = `assets/${id}`;
      const assets = { ...entry.assets, [relative]: id };
      await this.local.update(engine => engine.apply(target.kind === 'task'
        ? { type: 'task.update', id: target.id, patch: { notesAssets: assets } }
        : { type: 'note.update', id: target.id, patch: { assets } }));
      await this.reconcile(); return relative;
    });
  }
  async flush() { await this.queue; await this.local.flush(); }
}
