import { createHash } from 'node:crypto';
import { readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parseWorkspace, type Workspace } from '../src/shared/model';
import { atomicWrite, FileReadCache, safePath } from './file-io';

const collections = ['lists', 'tasks', 'steps', 'notes', 'noteFolders', 'boards', 'boardCards', 'purged', 'documentRevisions'] as const;
type Collection = typeof collections[number];
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.object({ key: digest });
export const currentManifestSchema = z.object({
  format: z.literal('gtodo-current'), version: z.literal(3), schemaVersion: z.literal(2), deviceId: z.string().uuid(),
  records: z.object(Object.fromEntries(collections.map(name => [name, z.array(reference).max(400000)])) as Record<Collection, z.ZodArray<typeof reference>>),
});
export type CurrentManifest = z.infer<typeof currentManifestSchema>;
export const isCurrentManifest = (value: unknown): value is CurrentManifest => !!value && typeof value === 'object' && (value as { format?: string }).format === 'gtodo-current';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const recordSchema = z.object({ collection: z.enum(collections), items: z.array(z.unknown()).min(1).max(400000) });
export function currentRecordParts(deviceId: string, collection: Collection, key: string) {
  z.string().uuid().parse(deviceId); z.enum(collections).parse(collection); digest.parse(key);
  return ['records', `device-${deviceId}`, `${collection}-${key}.json`];
}
function recordKey(collection: Collection, item: Workspace[Collection][number]) {
  const id = 'targetId' in item ? `${item.kind}:${item.targetId}` : `${'kind' in item ? item.kind + ':' : ''}${item.id}`;
  return hash(`${collection}:${id}`);
}

// Each logical record has a stable path. Body revisions are grouped by document,
// so editing a task's flags never creates another file or a history entry.
export class CurrentRecords {
  constructor(readonly cache = new FileReadCache()) {}
  private decoded = new Map<string, { signature: string; bytes: Buffer[]; workspace: Workspace }>();
  async encode(workspace: Workspace, root: string, deviceId: string): Promise<CurrentManifest> {
    const records = {} as CurrentManifest['records'];
    for (const collection of collections) {
      records[collection] = [];
      const groups = new Map<string, Workspace[Collection]>();
      for (const item of workspace[collection]) {
        const key = recordKey(collection, item), items = groups.get(key) ?? [];
        (items as unknown[]).push(item); groups.set(key, items);
      }
      for (const [key, items] of groups) {
        const content = JSON.stringify({ collection, items }, null, 2) + '\n';
        if (Buffer.byteLength(content) > MAX_RECORD_BYTES) throw new Error('单条记录及正文历史超过 64 MB，请先导出备份并整理历史。');
        const file = await safePath(root, currentRecordParts(deviceId, collection, key), true);
        let previous: Buffer | undefined;
        try { previous = await this.cache.read(file, MAX_RECORD_BYTES); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (previous?.toString('utf8') !== content) { await atomicWrite(file, content); this.cache.invalidate(file); }
        records[collection].push({ key });
      }
      records[collection].sort((a, b) => a.key.localeCompare(b.key, 'en'));
    }
    return { format: 'gtodo-current', version: 3, schemaVersion: 2, deviceId, records };
  }
  async decode(value: unknown, root: string): Promise<Workspace> {
    if (Number((value as CurrentManifest).version) > 3 || Number((value as CurrentManifest).schemaVersion) > 2) throw new Error('数据由较新版本创建，请升级 GTodo 后再打开。');
    const manifest = currentManifestSchema.parse(value), signature = JSON.stringify(manifest), buffers: Buffer[] = [];
    const cacheKey = path.join(root, manifest.deviceId), prior = this.decoded.get(cacheKey);
    for (const collection of collections) for (const ref of manifest.records[collection]) {
      const bytes = await this.cache.read(await safePath(root, currentRecordParts(manifest.deviceId, collection, ref.key)), MAX_RECORD_BYTES);
      buffers.push(bytes);
    }
    if (prior?.signature === signature && buffers.length === prior.bytes.length && buffers.every((bytes, i) => bytes === prior.bytes[i])) return prior.workspace;
    const result: Record<string, unknown> = { schemaVersion: 2 }; let index = 0;
    for (const collection of collections) {
      const items: unknown[] = [];
      for (const ref of manifest.records[collection]) {
        const record = recordSchema.parse(JSON.parse(buffers[index++].toString('utf8')));
        if (record.collection !== collection || collection !== 'documentRevisions' && record.items.length !== 1
          || record.items.some(item => !item || typeof item !== 'object' || recordKey(collection, item as Workspace[Collection][number]) !== ref.key)) throw new Error('记录标识不匹配，已停止读取。');
        items.push(...record.items);
      }
      result[collection] = items;
    }
    const workspace = parseWorkspace(result); this.decoded.set(cacheKey, { signature, bytes: buffers, workspace }); return workspace;
  }
  async collect(root: string, deviceId: string) {
    const used = new Set<string>();
    for (const name of await readdir(root)) if (/^device-[^\\/]+\.json$/i.test(name)) {
      const value = JSON.parse((await this.cache.read(await safePath(root, [name]), 24 * 1024 * 1024)).toString('utf8'));
      if (!isCurrentManifest(value)) continue;
      const manifest = currentManifestSchema.parse(value);
      if (manifest.deviceId === deviceId) for (const collection of collections) for (const ref of manifest.records[collection]) used.add(`${collection}-${ref.key}.json`);
    }
    const parts = ['records', `device-${z.string().uuid().parse(deviceId)}`];
    let names: string[];
    try { names = await readdir(path.dirname(await safePath(root, [...parts, 'placeholder']))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const name of names) if (new RegExp(`^(${collections.join('|')})-[a-f0-9]{64}\\.json$`).test(name) && !used.has(name)) {
      const file = await safePath(root, [...parts, name]); await unlink(file); this.cache.invalidate(file);
    }
  }
}
