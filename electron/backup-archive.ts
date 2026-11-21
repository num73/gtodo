import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, open, rename, rm, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { ZipFile } from 'yazl';
import { open as openZip, type ZipFile as InputZip, type Entry } from 'yauzl';
import { z } from 'zod';
import type { Workspace } from '../src/shared/model';
import { assetIdSchema, documentParts, isAssetPath, MAX_IMAGE_BYTES } from '../src/shared/documents';
import { DocumentFiles, imageType, workspaceAssetIds, workspaceDocuments } from './document-files';
import { collections, contentHash, recordParts, snapshotManifestSchema, SnapshotFiles, type SnapshotManifest } from './snapshot-files';
import { safePath } from './file-io';

export const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 2 * MAX_ARCHIVE_BYTES;
const archiveSchema = z.object({ format: z.literal('gtodo-backup'), version: z.literal(2), createdAt: z.string().datetime(), snapshot: snapshotManifestSchema,
  files: z.record(z.string(), z.object({ bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })) });
export async function writeBackupArchive(file: string, workspace: Workspace, documents: DocumentFiles) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`, zip = new ZipFile();
  await mkdir(path.dirname(file), { recursive: true });
  const output = createWriteStream(temporary, { flags: 'wx' });
  zip.on('error', error => output.destroy(error));
  let compressed = 0;
  const limit = new Transform({ transform(chunk: Buffer, _encoding, done) { compressed += chunk.length; done(compressed > MAX_ARCHIVE_BYTES ? new Error('ZIP 备份超过 1 GB，请直接备份数据文件夹。') : null, chunk); } });
  const complete = pipeline(zip.outputStream, limit, output); void complete.catch(() => {});
  const files: Record<string, { bytes: number; sha256: string }> = {};
  let size = 0, count = 0;
  function register(name: string, bytes: number, sha256: string) {
    if (files[name]) return false;
    size += bytes; count++; if (size > MAX_EXPANDED_BYTES || count > 399999) throw new Error('备份内容超过 2 GB 或文件数量限制，请直接备份数据文件夹。');
    files[name] = { bytes, sha256 }; return true;
  }
  function add(name: string, data: Buffer) { if (register(name, data.length, contentHash(data))) zip.addBuffer(data, name); }
  try {
    const records = {} as SnapshotManifest['records'];
    for (const name of collections) {
      records[name] = [];
      for (const item of workspace[name]) {
        const bytes = Buffer.from(JSON.stringify(item, null, 2) + '\n'), hash = contentHash(bytes);
        records[name].push(hash); add(recordParts(hash).join('/'), bytes);
      }
    }
    for (const entry of workspaceDocuments(workspace)) {
      add([...documentParts(entry), 'note.md'].join('/'), Buffer.from(entry.content));
      // External Markdown may deliberately use a mutable, human-named asset.
      // Preserve these aliases in an extracted archive as well as the hash pool.
      for (const [relative, id] of Object.entries(entry.assets)) if (relative.startsWith('assets/')) {
        const asset = await documents.assetFile(id), name = [...documentParts(entry), relative].join('/');
        if (register(name, asset.size, id.split('.')[0])) zip.addFile(asset.file, name, { compress: false });
      }
    }
    for (const id of workspaceAssetIds(workspace)) {
      const asset = await documents.assetFile(id);
      if (register(`assets/${id}`, asset.size, id.split('.')[0])) zip.addFile(asset.file, `assets/${id}`, { compress: false });
    }
    zip.addBuffer(Buffer.from(JSON.stringify({ format: 'gtodo-backup', version: 2, createdAt: new Date().toISOString(), snapshot: { format: 'gtodo-records', version: 2, schemaVersion: 2, records }, files })), 'backup.json');
    zip.end(); await complete;
    const handle = await open(temporary, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } catch (error) { output.destroy(); await complete.catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
}
function allowedName(name: string) {
  return name === 'backup.json' || /^records\/[a-f0-9]{2}\/[a-f0-9]{64}\.json$/.test(name)
    || /^assets\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(name)
    || /^documents\/(tasks|notes)\/(task|note)-[a-zA-Z0-9@_%:.\-]+\/note\.md$/.test(name)
    || (/^documents\/(tasks|notes)\/(task|note)-[a-zA-Z0-9@_%:.\-]+\/assets\/[^/]+$/.test(name) && isAssetPath(name.split('/').slice(-2).join('/')));
}
export async function withBackupArchive<T>(file: string, localRoot: string, consume: (workspace: Workspace, images: { id: string; file: string }[]) => Promise<T>): Promise<T> {
  if ((await stat(file)).size > MAX_ARCHIVE_BYTES) throw new Error('ZIP 备份超过 1 GB。');
  const parent = path.dirname(await safePath(localRoot, ['imports', 'placeholder'], true));
  const staging = await mkdtemp(path.join(parent, 'backup-'));
  let zip: InputZip | undefined;
  let pending: Promise<void> | undefined;
  let input: import('node:stream').Readable | undefined;
  try {
    zip = await new Promise<InputZip>((resolve, reject) => openZip(file, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, value) => error ? reject(error) : resolve(value!)));
    const found = new Map<string, { bytes: number; sha256: string }>(); let total = 0;
    await new Promise<void>((resolve, reject) => {
      zip!.on('error', error => { input?.destroy(error); reject(error); }); zip!.on('end', resolve);
      zip!.on('entry', (entry: Entry) => { pending = (async () => {
        const name = entry.fileName, type = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (!allowedName(name) || found.has(name) || entry.isEncrypted() || (type && type !== 0o100000)) throw new Error('备份包含不允许的路径、重复文件或特殊文件。');
        const maximum = name === 'backup.json' ? 64 * 1024 * 1024 : name.startsWith('assets/') || name.includes('/assets/') ? MAX_IMAGE_BYTES : 2 * 1024 * 1024;
        total += entry.uncompressedSize;
        if (entry.uncompressedSize > maximum || total > MAX_EXPANDED_BYTES || found.size >= 400000) throw new Error('备份解压后的大小超过限制。');
        const destination = await safePath(staging, name.split('/'), true);
        input = await new Promise<import('node:stream').Readable>((resolve, reject) => zip!.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value!)));
        const digest = createHash('sha256'); let bytes = 0;
        const check = new Transform({ transform(chunk: Buffer, _encoding, done) { bytes += chunk.length; if (bytes > maximum || bytes > entry.uncompressedSize) { done(new Error('备份文件大小不匹配。')); return; } digest.update(chunk); done(null, chunk); } });
        await pipeline(input, check, createWriteStream(destination, { flags: 'wx' }));
        found.set(name, { bytes, sha256: digest.digest('hex') }); zip!.readEntry();
      })().catch(error => { zip!.close(); reject(error); }); });
      zip!.readEntry();
    });
    const manifest = archiveSchema.parse(JSON.parse(await readFile(path.join(staging, 'backup.json'), 'utf8')));
    if (found.size !== Object.keys(manifest.files).length + 1) throw new Error('备份文件清单不完整。');
    for (const [name, expected] of Object.entries(manifest.files)) {
      const actual = found.get(name); if (!actual || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error('备份文件校验失败，现有数据未改变。');
    }
    const workspace = await new SnapshotFiles().decode(manifest.snapshot, staging), images: { id: string; file: string }[] = [];
    for (const id of workspaceAssetIds(workspace)) {
      assetIdSchema.parse(id); const name = `assets/${id}`;
      if (!found.has(name)) throw new Error('备份缺少正文所引用的图片。');
      const image = await safePath(staging, ['assets', id]), data = await readFile(image);
      if (`${contentHash(data)}.${imageType(data)}` !== id) throw new Error('备份图片校验失败。');
      images.push({ id, file: image });
    }
    return await consume(workspace, images);
  } finally {
    zip?.close();
    input?.destroy(); await pending;
    const target = path.resolve(staging), relative = path.relative(path.resolve(parent), target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('备份临时目录超出范围。');
    await rm(target, { recursive: true, force: true });
  }
}
