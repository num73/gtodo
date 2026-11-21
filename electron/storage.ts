import { mkdir, readFile, stat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { WorkspaceEngine } from '../src/shared/engine';
import { emptyWorkspace, parseWorkspace, type Workspace } from '../src/shared/model';
import { atomicWrite, safePath } from './file-io';
import { isRecordManifest, SnapshotFiles, snapshotManifestSchema } from './snapshot-files';
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
  constructor(readonly directory: string) { this.file = path.join(directory, 'workspace.json'); }
  async readSnapshot(file: string) {
    const text = await readFile(file, 'utf8');
    const parsed = savedSchema.parse(JSON.parse(text));
    const workspace = await this.snapshots.decode(parsed.workspace, this.directory);
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
          this.engine = new WorkspaceEngine(crypto.randomUUID());
          await atomicWrite(this.file, await this.serialize(this.engine)); return;
        }
        locations.push(...history.sort((a, b) => b.time - a.time || b.file.localeCompare(a.file)).map(item => item.file));
      }
    }
    if (!saved) throw new Error(`本地数据与备份均无法读取，已停止写入。请保留 ${this.directory} 并检查备份。`);
    this.engine = new WorkspaceEngine(saved.deviceId, saved.workspace);
    if (saved.legacy) {
      const migrated = await this.serialize(this.engine);
      const backup = await safePath(this.directory, ['history', `migration-${Date.now()}-${crypto.randomUUID()}.json`], true);
      await atomicWrite(backup, saved.text);
      await atomicWrite(this.file, migrated);
    } else if (recovered) await atomicWrite(this.file, await this.serialize(this.engine));
    if (recovered) this.notice = '主数据文件异常，已从本地备份恢复。建议导出一份备份。';
  }
  private async serialize(engine: WorkspaceEngine) { return JSON.stringify({ deviceId: engine.deviceId, workspace: await this.snapshots.encode(engine.state, this.directory) }); }
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
    const operation = this.queue.then(async () => {
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
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  async collectRecords() {
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
