import { mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
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
import { collectRecordGarbage, recordReferences, retainedDirectoryWorkspaces, withRecordWrite } from './record-gc';
import { isCurrentManifest } from './current-records';

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
  private nextCollection = 0;
  constructor(public local: DataStore, readonly preferences: PreferencesStore, private changed: () => void = () => {}, public documents = FolderStorage.documentsFor(local)) {}
  static documentsFor(local: DataStore) { return new DocumentFiles(local.directory, local.scoped ? { assetRoot: local.dataRoot, assertAvailable: () => local.assertAvailable() } : {}); }
  get directory() { return this.preferences.value.dataPath; }
  get ownFile() { return path.join(this.directory, `device-${this.local.engine.deviceId}.json`); }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action); this.queue = next.catch(() => {}); return next;
  }
  async initialize() {
    if (!this.local.scoped && this.directory === path.join(this.preferences.directory, 'data')) await mkdir(this.directory, { recursive: true });
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
        const value: unknown = JSON.parse(content);
        if (saved?.bytes !== bytes || isCurrentManifest(value)) { saved = { bytes, workspace: await this.snapshots.decode(value, directory) }; this.decoded.set(file, saved); }
        workspaces.push(saved.workspace);
      }
      catch (error) {
        if (String(error).includes('较新版本')) throw error;
        // Our durable working snapshot is committed before publishing mutable
        // files. Re-publish it after an interrupted write of our own index.
        if (file === this.ownFile && Object.values(this.local.engine.state).some(value => Array.isArray(value) && value.length)) this.published.delete(file);
        else throw new Error(`文件 ${name} 尚未完整同步或格式损坏，已暂停合并；本机任务已保留。`);
      }
      contents.set(name, content);
    }
    return { workspaces, contents };
  }
  private async encode(workspace: Workspace, directory = this.directory) {
    const content = JSON.stringify(await this.snapshots.current.encode(workspace, directory, this.local.engine.deviceId));
    if (Buffer.byteLength(content) > MAX_DATA_BYTES) throw new Error('设备索引超过 24 MB，已暂停发布同步索引，请先导出备份并整理记录。');
    return content;
  }
  private async reconcile(scanDocuments = true, forceNotify = false) {
    const previous = this.status;
    let modified = false;
    try {
      await this.local.assertAvailable();
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
          await withRecordWrite(this.directory, this.local.engine.deviceId, () => atomicWrite(this.ownFile, content)); this.fileCache.invalidate(this.ownFile);
        }
        this.published.set(this.ownFile, { workspace: this.local.engine.state, content });
        await this.snapshots.current.collect(this.directory, this.local.engine.deviceId);
        await this.documents.writeDocuments(this.directory, this.local.engine.state, scan!);
      }
      this.status = { error: null, lastRead: new Date().toISOString(), notice: this.documents.notice };
      if (Date.now() >= this.nextCollection) {
        this.nextCollection = Date.now() + 60 * 60 * 1000;
        try { await collectRecordGarbage(this.directory, this.local.engine.deviceId); }
        catch { this.status.notice = '数据已保存，过期数据块暂未清理，将稍后重试。'; }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.status = { ...this.status, error: code === 'ENOENT' || code === 'ENOTDIR'
        ? '数据文件夹暂时不可用，请恢复原目录或重新选择目录。'
        : code === 'EACCES' || code === 'EPERM' ? '数据文件夹不可读写，请检查权限。未保存的编辑仍保留在窗口中。'
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
      await this.local.update(change);
      await this.reconcile(true, true);
    });
  }
  changeDirectory(directory: string, beforeActivate?: () => Promise<void>) {
    return this.enqueue(async () => {
      await this.reconcile();
      if (!path.isAbsolute(directory)) throw new Error('请选择完整的本地文件夹路径。');
      const destination = await stat(directory);
      if (!destination.isDirectory()) throw new Error('请选择文件夹。');
      const relative = path.relative(await realpath(this.preferences.directory), await realpath(directory));
      if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('请选择应用配置目录以外的数据文件夹。');
      if (path.resolve(directory) === path.resolve(this.directory)) {
        try { await this.local.assertAvailable(); await this.reconcile(); return; } catch { /* Explicitly reopening a replaced directory starts a new workspace. */ }
      }
      const { workspaces } = await this.readDirectory(directory);
      const local = await DataStore.open(directory, this.local.engine.deviceId);
      const windows = await this.preferences.readWorkspaceWindows(local.directory);
      const documents = FolderStorage.documentsFor(local);
      const merged = new WorkspaceEngine(local.engine.deviceId, local.engine.state);
      for (const value of workspaces) merged.merge(value);
      const scan = await documents.readChanges(directory, merged, [local.engine.state, ...workspaces]);
      await local.update(engine => engine.merge(merged.state));
      const content = await this.encode(local.engine.state, directory);
      await withRecordWrite(directory, local.engine.deviceId, () => atomicWrite(path.join(directory, `device-${local.engine.deviceId}.json`), content));
      await documents.writeDocuments(directory, local.engine.state, scan);
      await beforeActivate?.();
      await this.preferences.update(value => { value.dataPath = directory; value.git.enabled = false; });
      await this.preferences.attachWorkspace(local.directory, windows);
      this.local = local; this.documents = documents; this.nextCollection = 0;
      this.fileCache.invalidate(); this.snapshots.cache.invalidate(); this.decoded.clear(); this.published.clear(); this.mergedInputs = new WeakSet();
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
        const snapshot = await inspectTrash(this.directory, this.local.directory, this.local.engine.state, await this.retainedWorkspaces());
        const records = await collectRecordGarbage(this.directory, this.local.engine.deviceId, { remove: false });
        snapshot.residualBytes += records.eligibleBytes; snapshot.residualFiles += records.eligibleFiles; return snapshot;
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
    return [...await this.local.backupWorkspaces(), ...await retainedDirectoryWorkspaces(this.directory), ...remote.workspaces];
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
        result.freedBytes += await collectPurgedSharedRecords(this.directory, this.local.engine.state, (await recordReferences(this.directory)).used);
        result.freedBytes += (await collectRecordGarbage(this.directory, this.local.engine.deviceId)).freedBytes;
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
