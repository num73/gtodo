import { mkdir, readFile, rename, stat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { WorkspaceEngine } from '../src/shared/engine';
import { parseWorkspace, type Workspace } from '../src/shared/model';

export async function atomicWrite(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
async function exists(file: string) { try { await stat(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
const savedSchema = z.object({ deviceId: z.string().uuid(), workspace: z.unknown() });
export class DataStore {
  engine!: WorkspaceEngine;
  notice: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  readonly file: string;
  constructor(readonly directory: string) { this.file = path.join(directory, 'workspace.json'); }
  async initialize() {
    await mkdir(this.directory, { recursive: true });
    if (!await exists(this.file) && !await exists(`${this.file}.bak`)) {
      this.engine = new WorkspaceEngine(crypto.randomUUID());
      await atomicWrite(this.file, this.serialize(this.engine)); return;
    }
    for (const file of [this.file, `${this.file}.bak`]) {
      try {
        const parsed = savedSchema.parse(JSON.parse(await readFile(file, 'utf8')));
        this.engine = new WorkspaceEngine(parsed.deviceId, parseWorkspace(parsed.workspace));
        if (file !== this.file) {
          this.notice = '主数据文件异常，已从本地备份恢复。建议导出一份备份。';
          await atomicWrite(this.file, this.serialize(this.engine));
        }
        return;
      } catch { /* Keep both files intact until a known-good snapshot is found. */ }
    }
    throw new Error(`本地数据与备份均无法读取，已停止写入。请保留 ${this.directory} 并检查备份。`);
  }
  private serialize(engine: WorkspaceEngine) { return JSON.stringify({ deviceId: engine.deviceId, workspace: engine.state }); }
  async flush() { await this.queue; }
  update(change: (engine: WorkspaceEngine) => void): Promise<Workspace> {
    const operation = this.queue.then(async () => {
      const next = new WorkspaceEngine(this.engine.deviceId, this.engine.state);
      change(next);
      parseWorkspace(next.state);
      await atomicWrite(`${this.file}.bak`, this.serialize(this.engine));
      await atomicWrite(this.file, this.serialize(next));
      this.engine = next;
      return structuredClone(next.state);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

