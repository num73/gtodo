import { mkdir, readFile, rename, stat, open, unlink, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export async function atomicWrite(file: string, content: string | Uint8Array) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
export async function safePath(root: string, parts: string[], create = false) {
  let current = await realpath(root);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (!part || part === '.' || part === '..' || /[\\/\x00]/.test(part)) throw new Error('文件路径无效。');
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (index < parts.length - 1 && create) { await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; }); info = await lstat(current); }
      else if (index < parts.length - 1) throw error;
    }
    if (info?.isSymbolicLink()) throw new Error('数据路径不能是符号链接或目录联接。');
    if (info && (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw new Error('数据路径被其他文件占用。');
  }
  return current;
}
export class FileReadCache {
  private entries = new Map<string, { stamp: string; bytes: Buffer; checked: number }>();
  reads = 0;
  hits = 0;
  private size = 0;
  constructor(private maximumCacheBytes = 32 * 1024 * 1024, private verifyAfterMs = 60000) {}
  invalidate(file?: string) { if (!file) { this.entries.clear(); this.size = 0; } else { const old = this.entries.get(file); if (old) this.size -= old.bytes.length; this.entries.delete(file); } }
  async read(file: string, maximum: number) {
    const info = await stat(file);
    if (!info.isFile() || info.size > maximum) throw new Error('数据文件超过大小限制或不是普通文件。');
    const stamp = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
    const prior = this.entries.get(file), now = Date.now();
    if (prior?.stamp === stamp && now - prior.checked < this.verifyAfterMs) { this.hits++; return prior.bytes; }
    const bytes = await readFile(file); this.reads++;
    if (bytes.length > maximum) throw new Error('数据文件超过大小限制。');
    this.invalidate(file);
    while (this.size + bytes.length > this.maximumCacheBytes && this.entries.size) this.invalidate(this.entries.keys().next().value!);
    if (bytes.length <= this.maximumCacheBytes) { this.entries.set(file, { stamp, bytes, checked: now }); this.size += bytes.length; }
    return bytes;
  }
}
