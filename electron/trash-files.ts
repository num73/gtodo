import { lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { assetIdSchema, documentParts } from '../src/shared/documents';
import type { Workspace } from '../src/shared/model';
import type { TrashItem, TrashSnapshot } from '../src/shared/trash';
import { trashRecords } from '../src/shared/trash';
import { boardAssetIds } from '../src/shared/board';

type FileEntry = { root: string; parts: string[]; bytes: number };
type Plan = { files: FileEntry[]; directories: { root: string; parts: string[] }[] };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

// Never follow junctions, accept renderer paths, or recursively remove a tree.
// Revalidate every path immediately before each unlink/rmdir as well as scanning.
async function checked(root: string, parts: string[]) {
  const base = await realpath(root);
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || /[\\/\x00]/.test(part))) throw new Error('清理路径无效。');
  const target = path.resolve(base, ...parts); const relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('清理路径超出数据目录。');
  let current = base;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('清理路径包含符号链接或目录联接，已停止清理。');
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error('清理路径不是文件夹。');
  }
  return { file: target, info: await lstat(target) };
}
async function scan(root: string, parts: string[], plan: Plan) {
  let value;
  try { value = await checked(root, parts); } catch (error) { if (missing(error)) return; throw error; }
  if (value.info.isFile()) plan.files.push({ root, parts, bytes: value.info.size });
  else if (value.info.isDirectory()) {
    for (const name of await readdir(value.file)) await scan(root, [...parts, name], plan);
    plan.directories.push({ root, parts }); // children before parents
  } else throw new Error('文档目录中存在无法清理的特殊文件。');
  if (plan.files.length + plan.directories.length > 100000) throw new Error('待清理文件过多，请分批清理。');
}
const newPlan = (): Plan => ({ files: [], directories: [] });
const bytes = (plan: Plan) => plan.files.reduce((total, file) => total + file.bytes, 0);
function referencedAssets(workspaces: Workspace[]) {
  return new Set(workspaces.flatMap(workspace => [
    ...workspace.tasks.flatMap(item => Object.values(item.values.notesAssets)),
    ...workspace.notes.flatMap(item => Object.values(item.values.assets)),
    ...boardAssetIds(workspace),
  ]));
}
async function cleanupPlan(root: string, localRoot: string, workspace: Workspace, backup: Workspace) {
  const plan = newPlan();
  for (const marker of workspace.purged) if (marker.kind === 'task' || marker.kind === 'note') await scan(root, documentParts({ kind: marker.kind, id: marker.id }), plan);
  const used = referencedAssets([workspace, backup]);
  try {
    const cache = await checked(localRoot, ['media']);
    if (!cache.info.isDirectory()) throw new Error('图片缓存路径不是文件夹。');
    for (const name of await readdir(cache.file)) {
      if (assetIdSchema.safeParse(name).success && !used.has(name)) {
        const value = await checked(localRoot, ['media', name]);
        if (!value.info.isFile()) throw new Error('图片缓存被其他文件占用。');
        await scan(localRoot, ['media', name], plan);
      }
    }
  } catch (error) { if (!missing(error)) throw error; }
  try {
    const assets = await checked(root, ['board', 'assets']);
    if (!assets.info.isDirectory()) throw new Error('看板图片路径不是文件夹。');
    for (const name of await readdir(assets.file)) {
      if (assetIdSchema.safeParse(name).success && !used.has(name)) {
        const value = await checked(root, ['board', 'assets', name]);
        if (!value.info.isFile()) throw new Error('看板图片被其他文件占用。');
        await scan(root, ['board', 'assets', name], plan);
      }
    }
  } catch (error) { if (!missing(error)) throw error; }
  return plan;
}
export async function inspectTrash(root: string, localRoot: string, workspace: Workspace, backup: Workspace): Promise<TrashSnapshot> {
  const items: TrashItem[] = trashRecords(workspace);
  for (const item of items) if (item.kind === 'task' || item.kind === 'note') {
    const plan = newPlan(); await scan(root, documentParts({ kind: item.kind, id: item.id }), plan); item.bytes = bytes(plan);
  }
  const residual = await cleanupPlan(root, localRoot, workspace, backup);
  return { items, residualBytes: bytes(residual), residualFiles: residual.files.length + residual.directories.length, error: null };
}
export async function cleanTrashFiles(root: string, localRoot: string, workspace: Workspace, backup: Workspace) {
  // Build and validate the complete plan before the first filesystem deletion.
  const plan = await cleanupPlan(root, localRoot, workspace, backup);
  let freedBytes = 0;
  try {
    for (const item of plan.files) {
      try {
        const value = await checked(item.root, item.parts);
        if (!value.info.isFile()) throw new Error('待清理文件已变化，请重试。');
        await unlink(value.file); freedBytes += value.info.size;
      } catch (error) { if (!missing(error)) throw error; }
    }
    for (const item of plan.directories) {
      try { const value = await checked(item.root, item.parts); await rmdir(value.file); }
      catch (error) { if (!missing(error) && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error; }
    }
    return { freedBytes, error: null };
  } catch (error) { return { freedBytes, error: error instanceof Error ? error.message : '部分文件无法清理，请重试。' }; }
}
