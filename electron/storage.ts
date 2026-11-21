import { mkdir, readFile, stat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { WorkspaceEngine } from '../src/shared/engine';
import { emptyWorkspace, parseWorkspace, type Workspace } from '../src/shared/model';
import { atomicWrite, safePath } from './file-io';
import { isRecordManifest, SnapshotFiles, snapshotManifestSchema } from './snapshot-files';
import { withRecordWrite } from './record-gc';
export { atomicWrite } from './file-io';

async function exists(file: string) { try { await stat(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
const savedSchema = z.object({ deviceId: z.string().uuid(), workspace: z.unknown() });
const historyName = /^(hour-\d{8}T\d{2}|day-\d{8}|migration-[a-zA-Z0-9-]+)\.json$/;
export class DataStore {
  engine!: WorkspaceEngine;
  notice: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  readonly snapshots = new SnapshotFiles();
  readonly file: string;
  constructor(readonly directory: string, readonly dataRoot = directory, private deviceId?: string, private marker?: string) { this.file = path.join(directory, 'workspace.json'); }
  get scoped() { return this.dataRoot !== this.directory; }
  async assertAvailable() {
    if (!this.scoped) return;
    try {
      const value = await readFile(await safePath(this.dataRoot, ['.gtodo', 'data.json']), 'utf8');
      if (!this.marker || value !== this.marker) throw new Error('changed');
    } catch { throw new Error('数据文件夹已被移除或替换，请重新选择数据文件夹。未保存的编辑仍保留在窗口中。'); }
  }
  static async open(directory: string, deviceId: string, allowUnavailable = false) {
    const privateDirectory = path.join(directory, '.gtodo', 'devices', deviceId);
    let marker: string;
    try { await stat(directory); }
    catch (error) {
      if (!allowUnavailable || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const store = new DataStore(privateDirectory, directory, deviceId);
      store.engine = new WorkspaceEngine(deviceId); store.notice = '数据文件夹不可用，请在设置中选择可用的目录。'; return store;
    }
    const markerFile = await safePath(directory, ['.gtodo', 'data.json'], true);
    try { marker = await readFile(markerFile, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      marker = JSON.stringify({ format: 'gtodo-directory', version: 1, id: crypto.randomUUID() }); await atomicWrite(markerFile, marker);
    }
    z.object({ format: z.literal('gtodo-directory'), version: z.literal(1), id: z.string().uuid() }).parse(JSON.parse(marker));
    await safePath(directory, ['.gtodo', 'devices', deviceId, 'workspace.json'], true);
    const store = new DataStore(privateDirectory, directory, deviceId, marker); await withRecordWrite(directory, deviceId, () => store.initialize()); return store;
  }
  async readSnapshot(file: string) {
    const text = await readFile(file, 'utf8');
    const parsed = savedSchema.parse(JSON.parse(text));
    const workspace = await this.snapshots.decode(parsed.workspace, this.dataRoot);
    return { ...parsed, workspace, text, legacy: !isRecordManifest(parsed.workspace) };
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true });
    let saved: Awaited<ReturnType<DataStore['readSnapshot']>> | undefined, recovered = false;
    const locations = [this.file, `${this.file}.bak`];
    for (const file of locations) {
      try { saved = await this.readSnapshot(file); recovered = file !== this.file; break; }
      catch (error) { if (String(error).includes('较新版本')) throw error; }
      if (file === `${this.file}.bak`) {
        const history = await Promise.all((await this.historyFiles()).map(async name => { const file = await safePath(this.directory, ['history', name]); return { file, time: (await stat(file)).mtimeMs }; }));
        if (!await exists(this.file) && !await exists(`${this.file}.bak`) && !history.length) {
          this.engine = new WorkspaceEngine(this.deviceId ?? crypto.randomUUID());
          await atomicWrite(this.file, await this.serialize(this.engine)); return;
        }
        locations.push(...history.sort((a, b) => b.time - a.time || b.file.localeCompare(a.file)).map(item => item.file));
      }
    }
    if (!saved) throw new Error(`本地数据与备份均无法读取，已停止写入。请保留 ${this.directory} 并检查备份。`);
    this.engine = new WorkspaceEngine(this.deviceId ?? saved.deviceId, saved.workspace);
    if (saved.legacy) {
      const migrated = await this.serialize(this.engine);
      const backup = await safePath(this.directory, ['history', `migration-${Date.now()}-${crypto.randomUUID()}.json`], true);
      await atomicWrite(backup, saved.text);
      await atomicWrite(this.file, migrated);
    } else if (recovered) await atomicWrite(this.file, await this.serialize(this.engine));
    if (recovered) this.notice = '主数据文件异常，已从本地备份恢复。建议导出一份备份。';
  }
  private async serialize(engine: WorkspaceEngine) { return JSON.stringify({ deviceId: engine.deviceId, workspace: await this.snapshots.encode(engine.state, this.dataRoot) }); }
  async flush() { await this.queue; }
  async backupWorkspace(): Promise<Workspace> {
    if (!await exists(`${this.file}.bak`)) return emptyWorkspace();
    return (await this.readSnapshot(`${this.file}.bak`)).workspace;
  }
  private async historyFiles() {
    try { return (await readdir(path.join(this.directory, 'history'))).filter(name => historyName.test(name)).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async backupWorkspaces(): Promise<Workspace[]> {
    const workspaces = [await this.backupWorkspace()];
    for (const name of await this.historyFiles()) workspaces.push((await this.readSnapshot(await safePath(this.directory, ['history', name]))).workspace);
    return workspaces;
  }
  private async retainHistory(current: string) {
    const now = new Date().toISOString().replaceAll('-', '');
    let created = false;
    for (const name of [`hour-${now.slice(0, 11)}.json`, `day-${now.slice(0, 8)}.json`]) {
      const file = await safePath(this.directory, ['history', name], true);
      if (!await exists(file)) { await atomicWrite(file, current); created = true; }
    }
    const files = await this.historyFiles();
    for (const [prefix, count] of [['hour-', 24], ['day-', 7], ['migration-', 3]] as const) {
      for (const name of files.filter(name => name.startsWith(prefix)).slice(0, -count)) await unlink(await safePath(this.directory, ['history', name]));
    }
    if (created) await this.collectRecords();
  }
  update(change: (engine: WorkspaceEngine) => void): Promise<Workspace> {
    const save = async () => {
      await this.assertAvailable();
      const next = new WorkspaceEngine(this.engine.deviceId, this.engine.state); change(next); parseWorkspace(next.state);
      const content = await this.serialize(next);
      const backup = new WorkspaceEngine(this.engine.deviceId, this.engine.state);
      backup.merge({ ...emptyWorkspace(), purged: next.state.purged });
      if (next.state.purged.length !== this.engine.state.purged.length) {
        for (const name of await this.historyFiles()) {
          const file = await safePath(this.directory, ['history', name]);
          const historical = await this.readSnapshot(file);
          const engine = new WorkspaceEngine(historical.deviceId, historical.workspace);
          engine.merge({ ...emptyWorkspace(), purged: next.state.purged });
          await atomicWrite(file, await this.serialize(engine));
        }
      }
      await atomicWrite(`${this.file}.bak`, await this.serialize(backup));
      await atomicWrite(this.file, content); this.engine = next;
      try { await this.retainHistory(content); } catch { this.notice = '当前内容已保存，但历史备份未能更新，请检查磁盘空间和权限。'; }
      return structuredClone(this.engine.state);
    };
    const operation = this.queue.then(async () => { await this.assertAvailable(); return this.scoped ? withRecordWrite(this.dataRoot, this.engine.deviceId, save) : save(); });
    this.queue = operation.catch(() => {}); return operation;
  }
  async collectRecords() {
    // A directory-scoped store shares its pool with every device and backup.
    // FolderStorage runs the shared collector after publishing the device index.
    if (this.scoped) return 0;
    const used = new Set<string>();
    for (const file of [this.file, `${this.file}.bak`, ...await Promise.all((await this.historyFiles()).map(name => safePath(this.directory, ['history', name])))]) {
      if (!await exists(file)) continue;
      const value = savedSchema.parse(JSON.parse(await readFile(file, 'utf8'))).workspace;
      if (isRecordManifest(value)) for (const hashes of Object.values(snapshotManifestSchema.parse(value).records)) for (const hash of hashes) used.add(hash);
    }
    let freed = 0;
    try {
      const root = path.dirname(await safePath(this.directory, ['records', 'placeholder']));
      for (const prefix of await readdir(root)) {
        if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
        const directory = path.dirname(await safePath(this.directory, ['records', prefix, 'placeholder']));
        for (const name of await readdir(directory)) if (/^[a-f0-9]{64}\.json$/.test(name) && !used.has(name.slice(0, -5))) {
          const file = await safePath(this.directory, ['records', prefix, name]); freed += (await stat(file)).size; await unlink(file); this.snapshots.cache.invalidate(file);
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return freed;
  }
}
