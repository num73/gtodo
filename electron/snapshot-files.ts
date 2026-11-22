import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parseWorkspace, type Workspace } from '../src/shared/model';
import { atomicWrite, FileReadCache, safePath } from './file-io';
import { CurrentRecords, isCurrentManifest } from './current-records';

export const collections = ['lists', 'tasks', 'steps', 'notes', 'noteFolders', 'boards', 'boardCards', 'purged', 'documentRevisions'] as const;
export const contentHash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const snapshotManifestSchema = z.object({
  format: z.literal('gtodo-records'), version: z.literal(2), schemaVersion: z.literal(2),
  records: z.object(Object.fromEntries(collections.map(name => [name, z.array(digest).max(400000)])) as Record<typeof collections[number], z.ZodArray<typeof digest>>),
});
export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;
export function isRecordManifest(value: unknown): value is SnapshotManifest { return !!value && typeof value === 'object' && (value as { format?: string }).format === 'gtodo-records'; }
export function recordParts(hash: string) { digest.parse(hash); return ['records', hash.slice(0, 2), `${hash}.json`]; }
export class SnapshotFiles {
  readonly cache = new FileReadCache();
  readonly current = new CurrentRecords(this.cache);
  private encoded = new Map<string, { value: unknown; hash: string; content: string }>();
  private verified = new WeakMap<Buffer, { hash: string; value: unknown }>();
  private verify(bytes: Buffer, hash: string) {
    const prior = this.verified.get(bytes);
    if (prior?.hash === hash) return prior.value;
    if (contentHash(bytes) !== hash) throw new Error('数据块尚未完整同步或校验失败，已保留本机数据。');
    const value: unknown = JSON.parse(bytes.toString('utf8')); this.verified.set(bytes, { hash, value }); return value;
  }
  async encode(workspace: Workspace, root: string): Promise<SnapshotManifest> {
    const records = {} as SnapshotManifest['records'];
    const live = new Set<string>();
    for (const name of collections) {
      records[name] = [];
      for (const item of workspace[name]) {
        const key = `${name}:${'kind' in item ? item.kind + ':' : ''}${item.id}`; live.add(key);
        let saved = this.encoded.get(key);
        if (!saved || !isDeepStrictEqual(saved.value, item)) {
          const content = JSON.stringify(item, null, 2) + '\n';
          saved = { value: structuredClone(item), content, hash: contentHash(content) }; this.encoded.set(key, saved);
        }
        const file = await safePath(root, recordParts(saved.hash), true);
        let bytes: Buffer | null = null;
        try { bytes = await this.cache.read(file, 2 * 1024 * 1024); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (!bytes) { await atomicWrite(file, saved.content); this.cache.invalidate(file); }
        else this.verify(bytes, saved.hash);
        records[name].push(saved.hash);
      }
    }
    for (const key of this.encoded.keys()) if (!live.has(key)) this.encoded.delete(key);
    return { format: 'gtodo-records', version: 2, schemaVersion: 2, records };
  }
  async decode(value: unknown, root: string): Promise<Workspace> {
    if (isCurrentManifest(value)) return this.current.decode(value, root);
    if ((value as { format?: string })?.format === 'gtodo-workspace' && Number((value as { version?: number }).version) > 3) throw new Error('数据由较新版本创建，请升级 GTodo 后再打开。');
    if (!isRecordManifest(value)) return parseWorkspace(value);
    if (Number(value.version) > 2 || Number(value.schemaVersion) > 2) throw new Error('数据由较新版本创建，请升级 GTodo 后再打开。');
    const manifest = snapshotManifestSchema.parse(value), result: Record<string, unknown> = { schemaVersion: 2 };
    for (const name of collections) {
      const items = [];
      for (const hash of manifest.records[name]) {
        const file = await safePath(root, recordParts(hash));
        const bytes = await this.cache.read(file, 2 * 1024 * 1024);
        items.push(this.verify(bytes, hash));
      }
      result[name] = items;
    }
    return parseWorkspace(result);
  }
}

// Only purge obsolete blocks for permanently deleted records. Other devices may
// be uploading new, not-yet-referenced blocks, so a general orphan sweep is unsafe.
export async function collectPurgedSharedRecords(root: string, workspace: Workspace, protectedHashes: Iterable<string> = []) {
  const used = new Set<string>(protectedHashes);
  for (const name of await readdir(root)) if (/^device-[^\\/]+\.json$/i.test(name)) {
    const value: unknown = JSON.parse(await readFile(await safePath(root, [name]), 'utf8'));
    if (isRecordManifest(value)) for (const values of Object.values(snapshotManifestSchema.parse(value).records)) for (const hash of values) used.add(hash);
    else await new SnapshotFiles().decode(value, root);
  }
  const purged = new Set(workspace.purged.map(marker => `${marker.kind}:${marker.id}`)); let freed = 0;
  let directory: string;
  try { directory = path.dirname(await safePath(root, ['records', 'placeholder'])); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  for (const prefix of await readdir(directory)) {
    if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
    const folder = path.dirname(await safePath(root, ['records', prefix, 'placeholder']));
    for (const name of await readdir(folder)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name) || used.has(name.slice(0, -5))) continue;
      const file = await safePath(root, ['records', prefix, name]), value = JSON.parse(await readFile(file, 'utf8'));
      const kind = value.targetId ? value.kind : value.values && ('notes' in value.values ? 'task' : 'desktop' in value.values ? 'note' : 'taskId' in value.values ? 'step' : 'parentId' in value.values ? 'noteFolder' : 'layout' in value.values ? 'boardCard' : 'name' in value.values ? 'list' : null);
      if (kind && purged.has(`${kind}:${value.targetId ?? value.id}`)) { freed += (await stat(file)).size; await unlink(await safePath(root, ['records', prefix, name])); }
    }
  }
  return freed;
}
