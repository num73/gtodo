import { readFile, readdir, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { atomicWrite, safePath } from './file-io';
import { contentHash, isRecordManifest, snapshotManifestSchema, recordParts, SnapshotFiles } from './snapshot-files';

export const RECORD_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const candidatesSchema = z.record(z.string().regex(/^[a-f0-9]{64}$/), z.object({ since: z.number(), stamp: z.string() }));
const activeWrites = new Map<string, { count: number; ready: Promise<void> }>();
async function names(root: string, parts: string[]) {
  try { return await readdir(path.dirname(await safePath(root, [...parts, 'placeholder']))); }
  catch (error) { if (missing(error)) return []; throw error; }
}
export async function recordReferences(root: string) {
  const files = (await readdir(root)).filter(name => /^device-[^\\/]+\.json$/i.test(name)).map(name => [name]);
  for (const device of await names(root, ['.gtodo', 'devices'])) {
    if (!/^[a-z0-9-]+$/i.test(device)) throw new Error('设备数据目录名称无效，已停止清理。');
    const base = ['.gtodo', 'devices', device];
    for (const name of await names(root, base)) if (/^workspace\.json(\.bak)?$/.test(name)) files.push([...base, name]);
    for (const name of await names(root, [...base, 'history'])) if (/^(hour-|day-|migration-).*\.json$/.test(name)) files.push([...base, 'history', name]);
  }
  const used = new Set<string>(), stamps: string[] = [];
  for (const parts of files.sort((a, b) => a.join('/').localeCompare(b.join('/')))) {
    const bytes = await readFile(await safePath(root, parts));
    const parsed = JSON.parse(bytes.toString('utf8'));
    const value = parsed.workspace ?? parsed;
    if (isRecordManifest(value)) for (const hashes of Object.values(snapshotManifestSchema.parse(value).records)) for (const hash of hashes) used.add(hash);
    else await new SnapshotFiles().decode(value, root);
    stamps.push(`${parts.join('/')}:${contentHash(bytes)}`);
  }
  // A missing referenced block means a sync is still arriving. Do not sweep.
  for (const hash of used) await stat(await safePath(root, recordParts(hash)));
  return { used, signature: contentHash(stamps.join('\n')) };
}
async function writing(root: string, now: number) {
  for (const name of await names(root, ['.gtodo', 'writes'])) {
    if (!name.endsWith('.json')) continue;
    const file = await safePath(root, ['.gtodo', 'writes', name]);
    if (activeWrites.has(file)) return true;
    const info = await stat(file);
    if (now - info.mtimeMs < 24 * 60 * 60 * 1000) return true;
  }
  return false;
}
export async function withRecordWrite<T>(root: string, device: string, action: () => Promise<T>) {
  const file = await safePath(root, ['.gtodo', 'writes', `${device}.json`], true);
  let entry = activeWrites.get(file);
  if (!entry) { entry = { count: 0, ready: atomicWrite(file, JSON.stringify({ startedAt: Date.now() })) }; activeWrites.set(file, entry); }
  entry.count++;
  try { await entry.ready; return await action(); }
  finally { if (--entry.count === 0) { activeWrites.delete(file); await unlink(await safePath(root, ['.gtodo', 'writes', `${device}.json`])).catch(() => {}); } }
}
// A two-pass grace period starts when this device first observes an orphan,
// never from the original file timestamp (sync clients can preserve old dates).
export async function collectRecordGarbage(root: string, device: string, options: { now?: number; graceMs?: number; remove?: boolean } = {}) {
  const now = options.now ?? Date.now(), grace = options.graceMs ?? RECORD_GRACE_MS;
  const result = { freedBytes: 0, eligibleBytes: 0, eligibleFiles: 0, pendingFiles: 0 };
  if (await writing(root, now)) return result;
  const before = await recordReferences(root);
  const ledgerFile = await safePath(root, ['.gtodo', 'devices', device, 'record-gc.json'], true);
  let old: z.infer<typeof candidatesSchema> = {};
  try { old = candidatesSchema.parse(JSON.parse(await readFile(ledgerFile, 'utf8'))); }
  catch (error) { if (!missing(error)) { /* A damaged ledger restarts the grace period; it never authorizes deletion. */ } }
  const next: typeof old = {}, eligible: { hash: string; bytes: number; stamp: string }[] = [];
  for (const prefix of await names(root, ['records'])) {
    if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
    for (const name of await names(root, ['records', prefix])) {
      if (!/^[a-f0-9]{64}\.json$/.test(name) || name.slice(0, 2) !== prefix) continue;
      const hash = name.slice(0, -5); if (before.used.has(hash)) continue;
      const info = await stat(await safePath(root, recordParts(hash))), stamp = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      const prior = old[hash]; next[hash] = prior?.stamp === stamp && prior.since <= now ? prior : { since: now, stamp };
      if (now - next[hash].since >= grace && now - info.mtimeMs >= grace) eligible.push({ hash, bytes: info.size, stamp });
      else result.pendingFiles++;
    }
  }
  result.eligibleBytes = eligible.reduce((sum, item) => sum + item.bytes, 0); result.eligibleFiles = eligible.length;
  if (options.remove !== false && eligible.length) {
    const after = await recordReferences(root);
    if (after.signature !== before.signature || await writing(root, now)) return result;
    for (const item of eligible) {
      // Check writers between unlinks as well; new publishers announce first.
      if (await writing(root, now)) break;
      const file = await safePath(root, recordParts(item.hash)), info = await stat(file);
      if (`${info.size}:${info.mtimeMs}:${info.ctimeMs}` !== item.stamp) continue;
      await unlink(await safePath(root, recordParts(item.hash))); result.freedBytes += info.size; delete next[item.hash];
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(old)) await atomicWrite(ledgerFile, JSON.stringify(next));
  if (options.remove !== false && !await writing(root, now)) for (const prefix of await names(root, ['records'])) if (/^[a-f0-9]{2}$/.test(prefix)) {
    try { await rmdir(await safePath(root, ['records', prefix], false, true)); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
  return result;
}

export async function retainedDirectoryWorkspaces(root: string) {
  // Used for attachment protection too, including other devices' retained backups.
  const { SnapshotFiles } = await import('./snapshot-files');
  const snapshots = new SnapshotFiles(), workspaces = [];
  for (const device of await names(root, ['.gtodo', 'devices'])) {
    const base = ['.gtodo', 'devices', device];
    const files = (await names(root, base)).filter(name => /^workspace\.json(\.bak)?$/.test(name)).map(name => [...base, name]);
    files.push(...(await names(root, [...base, 'history'])).filter(name => /^(hour-|day-|migration-).*\.json$/.test(name)).map(name => [...base, 'history', name]));
    for (const parts of files) { const value = JSON.parse(await readFile(await safePath(root, parts), 'utf8')); workspaces.push(await snapshots.decode(value.workspace, root)); }
  }
  return workspaces;
}
