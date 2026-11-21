import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseWorkspace, type FolderStatus, type Workspace } from '../src/shared/model';
import { WorkspaceEngine } from '../src/shared/engine';
import { atomicWrite, DataStore } from './storage';
import { PreferencesStore } from './preferences';
import { DocumentFiles, documentEntry } from './document-files';
import { sharedAssetPath, type DocumentTarget } from '../src/shared/documents';
import { trashRecords, type TrashTarget, type TrashSnapshot, type TrashResult } from '../src/shared/trash';
import { cleanTrashFiles, inspectTrash } from './trash-files';
import type { BoardImageInput } from '../src/shared/board';
import { collectPurgedSharedRecords, SnapshotFiles } from './snapshot-files';
import { FileReadCache, safePath } from './file-io';
import { withBackupArchive, writeBackupArchive } from './backup-archive';

export const MAX_DATA_BYTES = 24 * 1024 * 1024;
// Include conflict copies produced by desktop sync clients, but never temp/backup files.
const snapshotName = /^device-[^\\/]+\.json$/i;
export class FolderStorage {
  status: FolderStatus = { error: null, lastRead: null };
  private queue: Promise<unknown> = Promise.resolve();
  private checking: Promise<void> | null = null;
  readonly snapshots = new SnapshotFiles();
  readonly fileCache = new FileReadCache();
  private decoded = new Map<string, { bytes: Buffer; workspace: Workspace }>();
  private mergedInputs = new WeakSet<Workspace>();
  private published = new Map<string, { workspace: Workspace; content: string }>();
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
      await safePath(directory, [name]);
      const bytes = await this.fileCache.read(file, MAX_DATA_BYTES), content = bytes.toString('utf8');
      try {
        let saved = this.decoded.get(file);
        if (saved?.bytes !== bytes) { saved = { bytes, workspace: await this.snapshots.decode(JSON.parse(content), directory) }; this.decoded.set(file, saved); }
        workspaces.push(saved.workspace);
      }
      catch (error) { if (String(error).includes('较新版本')) throw error; throw new Error(`文件 ${name} 尚未完整同步或格式损坏，已暂停合并；本机任务已保留。`); }
      contents.set(name, content);
    }
    return { workspaces, contents };
  }
  private async encode(workspace: Workspace, directory = this.directory) {
    const content = JSON.stringify(await this.snapshots.encode(workspace, directory));
    if (Buffer.byteLength(content) > MAX_DATA_BYTES) throw new Error('待办数据超过 24 MB，仍保存在本机，暂未写入数据文件夹。');
    return content;
  }
  private async reconcile(scanDocuments = true, forceNotify = false) {
    const previous = this.status;
    let modified = false;
    try {
      const { workspaces, contents } = await this.readDirectory(this.directory);
      let merged = this.local.engine;
      const writable = () => { if (merged === this.local.engine) merged = new WorkspaceEngine(this.local.engine.deviceId, this.local.engine.state); return merged; };
      for (const value of workspaces) if (!this.mergedInputs.has(value)) writable().merge(value);
      const editor = { get state() { return merged.state; }, apply: (command: Parameters<WorkspaceEngine['apply']>[0]) => writable().apply(command) };
      const scan = scanDocuments ? await this.documents.readChanges(this.directory, editor, [this.local.engine.state, ...workspaces]) : null;
      if (merged !== this.local.engine && !isDeepStrictEqual(merged.state, this.local.engine.state)) {
        await this.local.update(engine => engine.merge(merged.state));
        modified = true;
      }
      for (const value of workspaces) this.mergedInputs.add(value);
      if (scanDocuments) {
        const published = this.published.get(this.ownFile);
        const content = published?.workspace === this.local.engine.state && published.content === contents.get(path.basename(this.ownFile)) ? published.content : await this.encode(this.local.engine.state);
        if (contents.get(path.basename(this.ownFile)) !== content) {
          const previous = contents.get(path.basename(this.ownFile));
          if (previous && !JSON.parse(previous).format) await atomicWrite(`${this.ownFile}.v1.bak`, previous);
          await atomicWrite(this.ownFile, content); this.fileCache.invalidate(this.ownFile);
        }
        this.published.set(this.ownFile, { workspace: this.local.engine.state, content });
        await this.documents.writeDocuments(this.directory, this.local.engine.state, scan!);
      }
      this.status = { error: null, lastRead: new Date().toISOString(), notice: this.documents.notice };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.status = { ...this.status, error: code === 'ENOENT' || code === 'ENOTDIR'
        ? '数据文件夹暂时不可用，任务已保存在此设备。恢复文件夹或重新选择路径后会继续写入。'
        : code === 'EACCES' || code === 'EPERM' ? '数据文件夹不可读写，请检查权限。任务仍保存在此设备。'
        : error instanceof Error ? error.message : '无法读取数据文件夹，请重试。' };
    }
    if (forceNotify || modified || previous.error !== this.status.error || previous.notice !== this.status.notice) this.changed();
  }
  refresh(force = false): Promise<void> {
    if (force) return this.enqueue(() => {
      this.fileCache.invalidate(); this.snapshots.cache.invalidate(); this.documents.files.invalidate(); this.decoded.clear(); this.published.clear(); this.mergedInputs = new WeakSet();
      return this.reconcile();
    });
    if (this.checking) return this.checking;
    this.checking = this.enqueue(() => this.reconcile()).finally(() => { this.checking = null; });
    return this.checking;
  }
  update(change: (engine: WorkspaceEngine) => void) {
    return this.enqueue(async () => {
      await this.reconcile();
      await this.local.update(change); // Always commit locally even when the chosen drive is unavailable.
      await this.reconcile(true, true);
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
      const content = await this.encode(merged.state, directory);
      await atomicWrite(path.join(directory, `device-${this.local.engine.deviceId}.json`), content);
      await this.documents.writeDocuments(directory, merged.state, scan);
      await this.local.update(engine => engine.merge(merged.state));
      await this.preferences.update(value => { value.dataPath = directory; value.git.enabled = false; });
      this.status = { error: null, lastRead: new Date().toISOString() }; this.changed();
    });
  }
  addImage(target: DocumentTarget, bytes: Uint8Array) {
    return this.enqueue(async () => {
      await this.reconcile();
      const entry = documentEntry(this.local.engine.state, target);
      const id = await this.documents.cacheImage(bytes); const relative = sharedAssetPath(id);
      const assets = { ...entry.assets, [relative]: id };
      await this.local.update(engine => engine.apply(target.kind === 'task'
        ? { type: 'task.update', id: target.id, patch: { notesAssets: assets } }
        : { type: 'note.update', id: target.id, patch: { assets } }));
      await this.reconcile(true, true); return relative;
    });
  }
  addBoardImage(input: BoardImageInput, bytes: Uint8Array, name: string) {
    return this.enqueue(async () => {
      await this.reconcile();
      const assetId = await this.documents.cacheImage(bytes);
      await this.local.update(engine => engine.apply(input.destination === 'background'
        ? { type: 'board.update', patch: { backgroundId: assetId } }
        : { type: 'board.card.add', content: { kind: 'image', assetId, name: name.slice(0, 200) }, layout: input.layout }));
      await this.reconcile(true, true);
    });
  }
  getTrash(): Promise<TrashSnapshot> {
    return this.enqueue(async () => {
      await this.reconcile();
      try {
        if (this.status.error) throw new Error(this.status.error);
        return await inspectTrash(this.directory, this.local.directory, this.local.engine.state, await this.retainedWorkspaces());
      } catch (error) {
        return { items: trashRecords(this.local.engine.state), residualBytes: 0, residualFiles: 0, error: error instanceof Error ? error.message : '无法统计文件占用。' };
      }
    });
  }
  restoreTrash(target: TrashTarget) {
    return this.update(engine => engine.restore(target));
  }
  private async retainedWorkspaces() {
    const remote = await this.readDirectory(this.directory);
    return [...await this.local.backupWorkspaces(), ...remote.workspaces];
  }
  private async scrubMigrationBackup() {
    const file = await safePath(this.directory, [`${path.basename(this.ownFile)}.v1.bak`]);
    let content: string;
    try { content = await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const engine = new WorkspaceEngine(this.local.engine.deviceId, parseWorkspace(JSON.parse(content)));
    engine.merge({ ...engine.state, purged: this.local.engine.state.purged });
    await atomicWrite(file, JSON.stringify(engine.state));
  }
  purgeTrash(targets: TrashTarget[]): Promise<TrashResult> {
    return this.enqueue(async () => {
      await this.reconcile();
      if (this.status.error) throw new Error(this.status.error);
      if (targets.length) await this.local.update(engine => engine.purge(targets));
      // Persist markers and materialize surviving linked documents before unlink.
      await this.reconcile(true, true);
      if (this.status.error) return { freedBytes: 0, error: `永久删除已记录，文件尚未清理：${this.status.error}` };
      try {
        await this.scrubMigrationBackup();
        const result = await cleanTrashFiles(this.directory, this.local.directory, this.local.engine.state, await this.retainedWorkspaces());
        result.freedBytes += await this.local.collectRecords();
        result.freedBytes += await collectPurgedSharedRecords(this.directory, this.local.engine.state);
        await this.documents.forgetPurged(this.directory, this.local.engine.state);
        return result;
      }
      catch (error) { return { freedBytes: 0, error: error instanceof Error ? error.message : '文件尚未清理，请重试。' }; }
      finally { this.changed(); }
    });
  }
  importBackup(workspace: Workspace, attachments: unknown) {
    return this.enqueue(async () => {
      await this.reconcile();
      await this.documents.importAttachments(attachments);
      await this.local.update(engine => engine.merge(workspace));
      await this.reconcile(true, true);
    });
  }
  exportBackup() {
    return this.enqueue(async () => {
      await this.reconcile();
      // Keep the snapshot and its image reads in the same queue as edits/purge.
      return this.documents.backup(this.local.engine.state);
    });
  }
  async flush() { await this.queue; await this.local.flush(); }
  exportBackupTo(file: string) {
    return this.enqueue(async () => {
      await this.reconcile();
      if (path.extname(file).toLowerCase() === '.json') await atomicWrite(file, await this.documents.backup(this.local.engine.state));
      else await writeBackupArchive(file, this.local.engine.state, this.documents);
    });
  }
  importArchive(file: string) {
    return this.enqueue(async () => {
      await this.reconcile();
      await withBackupArchive(file, this.local.directory, async (workspace, images) => {
        for (const image of images) await this.documents.cacheImage(await readFile(image.file));
        await this.local.update(engine => engine.merge(workspace));
      });
      await this.reconcile(true, true);
    });
  }
  exclusive<T>(action: () => Promise<T>, prepare = true, refreshAfter = false): Promise<T> {
    return this.enqueue(async () => {
      if (prepare) { await this.reconcile(); if (this.status.error) throw new Error(this.status.error); }
      try { return await action(); }
      finally { if (refreshAfter) await this.reconcile(); }
    });
  }
}
