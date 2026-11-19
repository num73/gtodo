import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { z } from 'zod';
import { assetIdSchema, documentFileName, documentParts, isAssetPath, MAX_IMAGE_BYTES, normalizeAssetPath, type AssetMap, type DocumentFormat, type DocumentTarget } from '../src/shared/documents';
import type { Workspace } from '../src/shared/model';
import type { WorkspaceEngine } from '../src/shared/engine';
import { linkedTaskForNote, linkedTasksByNote } from '../src/shared/note-links';
import { atomicWrite } from './storage';

const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const MAX_TEXT_BYTES = 600000;
export const MAX_BACKUP_BYTES = 160 * 1024 * 1024;
type Entry = DocumentTarget & { content: string; format: DocumentFormat; assets: AssetMap; deleted: boolean };
function entries(workspace: Workspace): Entry[] {
  const linked = linkedTasksByNote(workspace);
  return [...workspace.tasks.map(item => ({ kind: 'task' as const, id: item.id, content: item.values.notes, format: item.values.notesFormat, assets: item.values.notesAssets, deleted: item.values.deleted })),
    ...workspace.notes.filter(item => !linked.has(item.id)).map(item => ({ kind: 'note' as const, id: item.id, content: item.values.content, format: item.values.format, assets: item.values.assets, deleted: item.values.deleted }))];
}
export function documentEntry(workspace: Workspace, target: DocumentTarget): Entry {
  if (target.kind === 'note') {
    const note = workspace.notes.find(note => note.id === target.id && !note.values.deleted);
    const task = note && linkedTaskForNote(workspace, note);
    if (task) target = { kind: 'task', id: task.id };
  }
  const entry = entries(workspace).find(item => item.kind === target.kind && item.id === target.id && !item.deleted);
  if (!entry) throw new Error('这条记录已不存在。');
  return entry;
}
function patch(engine: WorkspaceEngine, entry: Entry, content: string, assets: AssetMap) {
  if (entry.kind === 'task') engine.apply({ type: 'task.update', id: entry.id, patch: { notes: content, notesAssets: assets } });
  else engine.apply({ type: 'note.update', id: entry.id, patch: { content, assets } });
}
export function imageType(bytes: Uint8Array) {
  const data = Buffer.from(bytes);
  if (!data.length || data.length > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 10 MB。');
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString())) return 'gif';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'webp';
  throw new Error('请选择 PNG、JPEG、GIF 或 WebP 图片。');
}
export function referencedImages(content: string): string[] {
  const found = new Set<string>();
  function visit(value: unknown) {
    const node = value as Record<string, unknown>;
    if (['image', 'definition', 'link'].includes(String(node.type)) && typeof node.url === 'string') {
      const relative = normalizeAssetPath(node.url); if (relative) found.add(relative);
    }
    if (Array.isArray(node.children)) for (const child of node.children) visit(child);
  }
  visit(fromMarkdown(content)); return [...found];
}
// Resolve each component separately. A synced junction/symlink must never redirect
// document writes or image reads outside the folder the user selected.
async function safePath(root: string, parts: string[], create = false) {
  let current = await realpath(root);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (!part || part === '.' || part === '..' || /[\\/\x00]/.test(part)) throw new Error('文件路径无效。');
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (!missing(error)) throw error;
      if (index < parts.length - 1 && create) { await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; }); info = await lstat(current); }
      else if (index < parts.length - 1) throw error;
    }
    if (info?.isSymbolicLink()) throw new Error('文档或图片路径不能是符号链接。');
    if (info && (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw new Error('文档路径被其他文件占用。');
  }
  return current;
}
async function optionalRead(root: string, parts: string[], maximum: number) {
  try {
    const file = await safePath(root, parts);
    if ((await stat(file)).size > maximum) throw new Error('文档或图片超过大小限制。');
    const data = await readFile(file); if (data.length > maximum) throw new Error('文档或图片超过大小限制。');
    return data;
  } catch (error) { if (missing(error)) return null; throw error; }
}
type Scan = { protected: Set<string>; observed: Map<string, string | null> };
export class DocumentFiles {
  private baseline: Record<string, string> = {};
  private serialized = '{}';
  private initialized = false;
  private pending = new Map<string, { hash: string; since: number }>();
  notice: string | null = null;
  constructor(readonly directory: string, private options: { settleMs?: number; now?: () => number } = {}) {}
  private key(root: string, parts: string[]) { return path.resolve(root, ...parts); }
  private async initialize() {
    if (this.initialized) return;
    const file = path.join(this.directory, 'document-state.json');
    try { this.baseline = z.record(z.string(), z.string()).parse(JSON.parse(await readFile(file, 'utf8'))); }
    catch (error) {
      if (!missing(error)) {
        try { this.baseline = z.record(z.string(), z.string()).parse(JSON.parse(await readFile(`${file}.bak`, 'utf8'))); }
        catch { throw new Error('文档同步记录无法读取，已暂停覆盖文档文件。'); }
      }
    }
    this.serialized = JSON.stringify(this.baseline); this.initialized = true;
  }
  private settled(key: string, value: string) {
    const now = (this.options.now ?? Date.now)(); const prior = this.pending.get(key);
    if (prior?.hash === value && now - prior.since >= (this.options.settleMs ?? 400)) return true;
    if (prior?.hash !== value) this.pending.set(key, { hash: value, since: now });
    return false;
  }
  private async conflict(root: string, entry: Entry, content: string) {
    const file = await safePath(root, [...documentParts(entry), 'conflicts', `${hash(content)}.${entry.format === 'markdown' ? 'md' : 'txt'}`], true);
    await atomicWrite(file, content);
    this.notice = '检测到同时编辑，已在文档旁的 conflicts 文件夹保留另一份内容。';
  }
  async cacheImage(bytes: Uint8Array) {
    const id = `${hash(bytes)}.${imageType(bytes)}`;
    const cache = path.join(this.directory, 'media'); await mkdir(cache, { recursive: true });
    const file = await safePath(cache, [id]);
    if (!await optionalRead(cache, [id], MAX_IMAGE_BYTES)) await atomicWrite(file, Buffer.from(bytes));
    return id;
  }
  private async cached(id: string) {
    assetIdSchema.parse(id);
    const bytes = await optionalRead(path.join(this.directory, 'media'), [id], MAX_IMAGE_BYTES);
    if (bytes && `${hash(bytes)}.${imageType(bytes)}` !== id) throw new Error('本机图片校验失败，请保留图片文件并检查备份。');
    return bytes;
  }
  async readChanges(root: string, engine: WorkspaceEngine, known: Workspace[]): Promise<Scan> {
    await this.initialize();
    const scan: Scan = { protected: new Set(), observed: new Map() };
    const knownEntries = known.flatMap(entries);
    for (const original of entries(engine.state).filter(item => !item.deleted)) {
      const parts = [...documentParts(original), documentFileName(original.format)];
      const key = this.key(root, parts);
      const bytes = await optionalRead(root, parts, MAX_TEXT_BYTES);
      let content = original.content;
      let diskContent = content;
      if (bytes) {
        const disk = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\ufeff/, '');
        diskContent = disk;
        if (disk.length > 100000) throw new Error('备注文件不能超过 100000 个字符。');
        const diskHash = hash(disk); scan.observed.set(key, diskHash);
        const knownBodies = knownEntries.filter(item => item.kind === original.kind && item.id === original.id).map(item => item.content);
        if (disk !== content && this.baseline[key] !== diskHash && !knownBodies.includes(disk)) {
          if (!this.settled(key, diskHash)) scan.protected.add(key);
          else {
            if (this.baseline[key] !== hash(content)) await this.conflict(root, original, content);
            content = disk;
          }
        }
      } else scan.observed.set(key, null);
      const assets = { ...original.assets };
      const paths = new Set([...Object.keys(assets), ...(original.format === 'markdown' ? [...referencedImages(content), ...referencedImages(diskContent)] : [])]);
      for (const relative of paths) {
        const assetParts = [...documentParts(original), 'assets', relative.slice(7)];
        const assetKey = this.key(root, assetParts);
        const data = await optionalRead(root, assetParts, MAX_IMAGE_BYTES);
        scan.observed.set(assetKey, data ? hash(data) : null);
        if (!data) continue;
        const id = await this.cacheImage(data); const actual = hash(data);
        const knownAsset = knownEntries.some(item => item.kind === original.kind && item.id === original.id && item.assets[relative] === id);
        if (assets[relative] !== id && (!assets[relative] || (this.baseline[assetKey] !== actual && !knownAsset))) {
          if (!this.settled(assetKey, actual)) scan.protected.add(assetKey);
          else assets[relative] = id;
        }
      }
      if (content !== original.content || JSON.stringify(assets) !== JSON.stringify(original.assets)) patch(engine, original, content, assets);
    }
    return scan;
  }
  async writeDocuments(root: string, workspace: Workspace, scan: Scan) {
    await this.initialize();
    for (const entry of entries(workspace).filter(item => !item.deleted)) {
      const parts = [...documentParts(entry), documentFileName(entry.format)]; const key = this.key(root, parts);
      if (!scan.protected.has(key)) {
        const old = await optionalRead(root, parts, MAX_TEXT_BYTES);
        const oldText = old ? new TextDecoder('utf-8', { fatal: true }).decode(old).replace(/^\ufeff/, '') : null;
        if (scan.observed.get(key) === (oldText === null ? null : hash(oldText))) {
          const file = await safePath(root, parts, true);
          if (oldText !== entry.content) {
            if (oldText !== null) await atomicWrite(await safePath(root, [...documentParts(entry), `${documentFileName(entry.format)}.bak`], true), oldText);
            await atomicWrite(file, entry.content);
          }
          this.baseline[key] = hash(entry.content); this.pending.delete(key);
          const otherParts = [...documentParts(entry), documentFileName(entry.format === 'markdown' ? 'text' : 'markdown')];
          const other = await optionalRead(root, otherParts, MAX_TEXT_BYTES);
          if (other) {
            const otherText = new TextDecoder('utf-8', { fatal: true }).decode(other);
            if (this.baseline[this.key(root, otherParts)] !== hash(otherText)) await this.conflict(root, { ...entry, format: entry.format === 'markdown' ? 'text' : 'markdown' }, otherText);
            await rename(await safePath(root, otherParts), await safePath(root, [...documentParts(entry), `${otherParts.at(-1)}.previous`], true));
          }
        }
      }
      for (const [relative, id] of Object.entries(entry.assets)) {
        const parts = [...documentParts(entry), 'assets', relative.slice(7)]; const key = this.key(root, parts);
        if (scan.protected.has(key)) continue;
        const bytes = await this.cached(id); if (!bytes) continue;
        const old = await optionalRead(root, parts, MAX_IMAGE_BYTES);
        if (scan.observed.get(key) !== (old ? hash(old) : null) && scan.observed.has(key)) continue;
        if (!old?.equals(bytes)) await atomicWrite(await safePath(root, parts, true), bytes);
        this.baseline[key] = hash(bytes); this.pending.delete(key);
      }
    }
    const next = JSON.stringify(this.baseline);
    if (next !== this.serialized) {
      await atomicWrite(path.join(this.directory, 'document-state.json.bak'), this.serialized);
      await atomicWrite(path.join(this.directory, 'document-state.json'), next); this.serialized = next;
    }
  }
  async filePath(root: string, workspace: Workspace, target: DocumentTarget) {
    const entry = documentEntry(workspace, target);
    return safePath(root, [...documentParts(entry), documentFileName(entry.format)]);
  }
  async forgetPurged(root: string, workspace: Workspace) {
    await this.initialize();
    const prefixes = workspace.purged.filter(item => item.kind === 'task' || item.kind === 'note')
      .map(item => this.key(root, documentParts({ kind: item.kind as 'task' | 'note', id: item.id })) + path.sep);
    for (const key of Object.keys(this.baseline)) if (prefixes.some(prefix => key.startsWith(prefix))) { delete this.baseline[key]; this.pending.delete(key); }
    const next = JSON.stringify(this.baseline);
    if (next !== this.serialized) {
      await atomicWrite(path.join(this.directory, 'document-state.json.bak'), next);
      await atomicWrite(path.join(this.directory, 'document-state.json'), next); this.serialized = next;
    }
  }
  async readImage(root: string, workspace: Workspace, target: DocumentTarget, relative: string) {
    if (!isAssetPath(relative)) throw new Error('图片路径无效。');
    const entry = documentEntry(workspace, target); const id = entry.assets[relative];
    if (id) { const bytes = await this.cached(id); if (bytes) return { bytes, type: imageType(bytes) }; }
    const bytes = await optionalRead(root, [...documentParts(entry), 'assets', relative.slice(7)], MAX_IMAGE_BYTES);
    if (!bytes) throw new Error('图片尚未同步或已移动。');
    return { bytes, type: imageType(bytes) };
  }
  async backup(workspace: Workspace) {
    const attachments: Record<string, string> = {};
    let size = Buffer.byteLength(JSON.stringify(workspace));
    for (const id of new Set(entries(workspace).flatMap(entry => Object.values(entry.assets)))) {
      const data = await this.cached(id); if (!data) throw new Error('有图片尚未同步完成，请稍后再导出备份。');
      attachments[id] = data.toString('base64'); size += attachments[id].length;
      if (size > MAX_BACKUP_BYTES - 1024 * 1024) throw new Error('含图片的备份超过 160 MB，请直接备份整个数据文件夹。');
    }
    const serialized = JSON.stringify({ ...workspace, attachments });
    if (Buffer.byteLength(serialized) > MAX_BACKUP_BYTES) throw new Error('含图片的备份超过 160 MB，请直接备份整个数据文件夹。');
    return serialized;
  }
  async importAttachments(value: unknown) {
    const assets = z.record(assetIdSchema, z.string().max(Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4)).parse(value ?? {});
    const validated = Object.entries(assets).map(([id, text]) => {
      const data = Buffer.from(text, 'base64');
      if (`${hash(data)}.${imageType(data)}` !== id) throw new Error('备份图片校验失败，任务数据未改变。');
      return data;
    });
    for (const data of validated) await this.cacheImage(data);
  }
}
