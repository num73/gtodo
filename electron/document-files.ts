import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { z } from 'zod';
import { assetIdSchema, documentFileName, documentParts, isAssetPath, sharedAssetId, MAX_IMAGE_BYTES, normalizeAssetPath, type AssetMap, type DocumentFormat, type DocumentTarget } from '../src/shared/documents';
import type { Workspace } from '../src/shared/model';
import type { WorkspaceEngine } from '../src/shared/engine';
import { linkedTaskForNote, linkedTasksByNote } from '../src/shared/note-links';
import { boardAssetIds } from '../src/shared/board';
import { atomicWrite } from './storage';
import { FileReadCache } from './file-io';

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
export function workspaceAssetIds(workspace: Workspace) {
  return new Set([...entries(workspace).flatMap(entry => Object.values(entry.assets)), ...(workspace.documentRevisions ?? []).flatMap(revision => Object.values(revision.assets)), ...boardAssetIds(workspace)]);
}
export const workspaceDocuments = entries;
export function needsMarkdownFile(entry: Pick<Entry, 'kind' | 'content'>) { return entry.kind === 'note' || entry.content.trim().length > 0; }
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
function patch(engine: Pick<WorkspaceEngine, 'state' | 'apply'>, entry: Entry, content: string, assets: AssetMap) {
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
async function optionalRead(root: string, parts: string[], maximum: number, cache: FileReadCache) {
  try {
    const file = await safePath(root, parts);
    return await cache.read(file, maximum);
  } catch (error) { if (missing(error)) return null; throw error; }
}
type Scan = { protected: Set<string>; observed: Map<string, string | null>; changed: Set<string> };
function imageParts(entry: DocumentTarget, relative: string) { const id = sharedAssetId(relative); return id ? ['assets', id] : [...documentParts(entry), 'assets', relative.slice(7)]; }
export class DocumentFiles {
  readonly files = new FileReadCache(64 * 1024 * 1024);
  private written = new Map<string, string>();
  private read(root: string, parts: string[], maximum: number) { return optionalRead(root, parts, maximum, this.files); }
  private baseline: Record<string, string> = {};
  private serialized = '{}';
  private initialized = false;
  private pending = new Map<string, { hash: string; since: number }>();
  private stagedBoardImages = new Set<string>();
  notice: string | null = null;
  constructor(readonly directory: string, private options: { settleMs?: number; now?: () => number; assetRoot?: string; assertAvailable?: () => Promise<void> } = {}) {}
  private get mediaDirectory() { return this.options.assetRoot ? path.join(this.options.assetRoot, 'assets') : path.join(this.directory, 'media'); }
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
    const file = await safePath(root, [...documentParts(entry), 'conflicts', `${hash(content)}.md`], true);
    await atomicWrite(file, content);
    this.notice = '检测到同时编辑，已在文档旁的 conflicts 文件夹保留另一份内容。';
  }
  async cacheImage(bytes: Uint8Array) {
    await this.options.assertAvailable?.();
    const id = `${hash(bytes)}.${imageType(bytes)}`;
    const cache = this.mediaDirectory; await mkdir(cache, { recursive: true });
    const file = await safePath(cache, [id]);
    const verified = Buffer.from(bytes);
    if (!(await this.read(cache, [id], MAX_IMAGE_BYTES))?.equals(verified)) await atomicWrite(file, verified);
    return id;
  }
  async stageBoardImage(bytes: Uint8Array) {
    const id = await this.cacheImage(bytes);
    this.stagedBoardImages.add(id);
    if (this.stagedBoardImages.size > 50) this.stagedBoardImages.delete(this.stagedBoardImages.values().next().value!);
    return id;
  }
  private async cached(id: string) {
    assetIdSchema.parse(id);
    const bytes = await this.read(this.mediaDirectory, [id], MAX_IMAGE_BYTES);
    if (bytes && `${hash(bytes)}.${imageType(bytes)}` !== id) throw new Error('本机图片校验失败，请保留图片文件并检查备份。');
    return bytes;
  }
  async readChanges(root: string, engine: Pick<WorkspaceEngine, 'state' | 'apply'>, known: Workspace[]): Promise<Scan> {
    await this.initialize();
    for (const id of workspaceAssetIds(engine.state)) {
      if (await this.cached(id)) continue;
      const bytes = await this.read(root, ['assets', id], MAX_IMAGE_BYTES) ?? await this.read(root, ['board', 'assets', id], MAX_IMAGE_BYTES);
      if (bytes) {
        if (`${hash(bytes)}.${imageType(bytes)}` !== id) throw new Error('看板图片尚未完整同步或校验失败，请稍后重试。');
        await this.cacheImage(bytes);
      }
    }
    const scan: Scan = { protected: new Set(), observed: new Map(), changed: new Set() };
    const knownEntries = new Map<string, Entry[]>();
    for (const entry of known.flatMap(entries)) { const key = `${entry.kind}:${entry.id}`, values = knownEntries.get(key) ?? []; values.push(entry); knownEntries.set(key, values); }
    for (const original of entries(engine.state).filter(item => !item.deleted)) {
      const parts = [...documentParts(original), documentFileName(original.format)];
      const key = this.key(root, parts);
      let bytes = await this.read(root, parts, MAX_TEXT_BYTES);
      let baselineKey = key;
      const markdownMissing = bytes === null;
      if (markdownMissing) {
        const legacyParts = [...documentParts(original), 'note.txt'];
        bytes = await this.read(root, legacyParts, MAX_TEXT_BYTES);
        baselineKey = this.key(root, legacyParts);
      }
      let content = original.content;
      let diskContent = content;
      if (bytes) {
        const disk = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\ufeff/, '');
        diskContent = disk;
        if (disk.length > 100000) throw new Error('备注文件不能超过 100000 个字符。');
        const diskHash = hash(disk); scan.observed.set(key, markdownMissing ? null : diskHash);
        if (this.baseline[baselineKey] !== diskHash || markdownMissing) scan.changed.add(key);
        const related = knownEntries.get(`${original.kind}:${original.id}`) ?? [];
        const knownBodies = related.map(item => item.content);
        if (disk !== content && this.baseline[baselineKey] !== diskHash && !knownBodies.includes(disk)) {
          if (!this.settled(key, diskHash)) scan.protected.add(key);
          else {
            if (this.baseline[baselineKey] !== hash(content)) await this.conflict(root, original, content);
            content = disk;
          }
        }
      } else { scan.observed.set(key, null); scan.changed.add(key); }
      const assets = { ...original.assets };
      const paths = new Set([...Object.keys(assets), ...referencedImages(content), ...referencedImages(diskContent)]);
      for (const relative of paths) {
        const assetParts = imageParts(original, relative);
        const assetKey = this.key(root, assetParts);
        const data = await this.read(root, assetParts, MAX_IMAGE_BYTES);
        scan.observed.set(assetKey, data ? hash(data) : null);
        if (!data) { scan.changed.add(key); continue; }
        const id = await this.cacheImage(data); const actual = hash(data);
        if (sharedAssetId(relative) && sharedAssetId(relative) !== id) throw new Error('共享图片校验失败，请保留原文件并检查备份。');
        if (this.baseline[assetKey] !== actual) scan.changed.add(key);
        const knownAsset = (knownEntries.get(`${original.kind}:${original.id}`) ?? []).some(item => item.assets[relative] === id);
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
    for (const id of workspaceAssetIds(workspace)) {
      const bytes = await this.cached(id); if (!bytes) continue;
      const parts = ['assets', id];
      const old = await this.read(root, parts, MAX_IMAGE_BYTES);
      if (!old) await atomicWrite(await safePath(root, parts, true), bytes);
      else if (!old.equals(bytes)) throw new Error('看板图片校验失败，请保留文件并检查备份。');
    }
    for (const entry of entries(workspace).filter(item => !item.deleted)) {
      const parts = [...documentParts(entry), documentFileName(entry.format)]; const key = this.key(root, parts);
      const signature = hash(entry.content + '\n' + JSON.stringify(entry.assets));
      if (this.written.get(key) === signature && !scan.changed.has(key) && !scan.protected.size) continue;
      if (!scan.protected.has(key)) {
        const old = await this.read(root, parts, MAX_TEXT_BYTES);
        const oldText = old ? new TextDecoder('utf-8', { fatal: true }).decode(old).replace(/^\ufeff/, '') : null;
        if (scan.observed.get(key) === (oldText === null ? null : hash(oldText)) && (oldText !== null || needsMarkdownFile(entry))) {
          const file = await safePath(root, parts, true);
          if (oldText !== entry.content) {
            if (oldText !== null) await atomicWrite(await safePath(root, [...documentParts(entry), `${documentFileName(entry.format)}.bak`], true), oldText);
            await atomicWrite(file, entry.content);
          }
          this.baseline[key] = hash(entry.content); this.pending.delete(key);
          const otherParts = [...documentParts(entry), 'note.txt'];
          const other = await this.read(root, otherParts, MAX_TEXT_BYTES);
          if (other) {
            const otherText = new TextDecoder('utf-8', { fatal: true }).decode(other);
            if (otherText !== entry.content && this.baseline[this.key(root, otherParts)] !== hash(otherText)) await this.conflict(root, entry, otherText);
            await rename(await safePath(root, otherParts), await safePath(root, [...documentParts(entry), `${otherParts.at(-1)}.previous`], true));
          }
        }
      }
      for (const [relative, id] of Object.entries(entry.assets)) {
        const parts = imageParts(entry, relative); const key = this.key(root, parts);
        if (scan.protected.has(key)) continue;
        const bytes = await this.cached(id); if (!bytes) continue;
        const old = await this.read(root, parts, MAX_IMAGE_BYTES);
        if (scan.observed.get(key) !== (old ? hash(old) : null) && scan.observed.has(key)) continue;
        if (!old?.equals(bytes)) await atomicWrite(await safePath(root, parts, true), bytes);
        this.baseline[key] = hash(bytes); this.pending.delete(key);
      }
      if (!scan.protected.size) this.written.set(key, signature);
    }
    const next = JSON.stringify(this.baseline);
    if (next !== this.serialized) {
      await atomicWrite(path.join(this.directory, 'document-state.json.bak'), this.serialized);
      await atomicWrite(path.join(this.directory, 'document-state.json'), next); this.serialized = next;
    }
  }
  async filePath(root: string, workspace: Workspace, target: DocumentTarget) {
    const entry = documentEntry(workspace, target);
    const parts = [...documentParts(entry), documentFileName(entry.format)];
    if (!needsMarkdownFile(entry) && await this.read(root, parts, MAX_TEXT_BYTES) === null) throw new Error('备注为空，填写内容后才会生成 Markdown 文件。');
    return safePath(root, parts);
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
  async readImage(root: string, workspace: Workspace, target: DocumentTarget, relative: string, version?: string) {
    if (!isAssetPath(relative)) throw new Error('图片路径无效。');
    const entry = documentEntry(workspace, target);
    const id = version && workspace.documentRevisions.some(revision => revision.kind === entry.kind && revision.targetId === entry.id && revision.assets[relative] === version) ? version : entry.assets[relative];
    if (id) { const bytes = await this.cached(id); if (bytes) return { bytes, type: imageType(bytes) }; }
    const bytes = await this.read(root, imageParts(entry, relative), MAX_IMAGE_BYTES);
    if (!bytes) throw new Error('图片尚未同步或已移动。');
    return { bytes, type: imageType(bytes) };
  }
  async backup(workspace: Workspace) {
    const attachments: Record<string, string> = {};
    let size = Buffer.byteLength(JSON.stringify(workspace));
    for (const id of workspaceAssetIds(workspace)) {
      const data = await this.cached(id); if (!data) throw new Error('有图片尚未同步完成，请稍后再导出备份。');
      attachments[id] = data.toString('base64'); size += attachments[id].length;
      if (size > MAX_BACKUP_BYTES - 1024 * 1024) throw new Error('含图片的备份超过 160 MB，请直接备份整个数据文件夹。');
    }
    const serialized = JSON.stringify({ ...workspace, attachments });
    if (Buffer.byteLength(serialized) > MAX_BACKUP_BYTES) throw new Error('含图片的备份超过 160 MB，请直接备份整个数据文件夹。');
    return serialized;
  }
  async assetFile(id: string) {
    const data = await this.cached(id); if (!data) throw new Error('有图片尚未同步完成，请稍后再导出备份。');
    return { file: await safePath(this.mediaDirectory, [id]), size: data.length };
  }
  async readBoardImage(root: string, workspace: Workspace, value: string) {
    const id = assetIdSchema.parse(value);
    if (!boardAssetIds(workspace).includes(id) && !this.stagedBoardImages.has(id)) throw new Error('看板图片不存在。');
    const bytes = await this.cached(id) ?? await this.read(root, ['assets', id], MAX_IMAGE_BYTES) ?? await this.read(root, ['board', 'assets', id], MAX_IMAGE_BYTES);
    if (!bytes) throw new Error('图片尚未同步。');
    if (`${hash(bytes)}.${imageType(bytes)}` !== id) throw new Error('看板图片校验失败。');
    return { bytes, type: imageType(bytes) };
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
