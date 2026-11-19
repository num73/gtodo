import { z } from 'zod';

export const documentFormatSchema = z.enum(['text', 'markdown']);
export type DocumentFormat = z.infer<typeof documentFormatSchema>;
export const assetIdSchema = z.string().regex(/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/);
export function isAssetPath(value: string): boolean {
  return /^assets\/[^/\\\x00-\x1f:*?"<>|]{1,120}\.(png|jpe?g|gif|webp)$/i.test(value) && !/^assets\/(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(value);
}
export function normalizeAssetPath(value: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { decoded = value; }
  decoded = decoded.replace(/^\.\//, '');
  return isAssetPath(decoded) ? decoded : null;
}
export const assetMapSchema = z.record(z.string().refine(isAssetPath), assetIdSchema)
  .refine(value => Object.keys(value).length <= 200, '图片数量超过 200 张');
export type AssetMap = z.infer<typeof assetMapSchema>;
export const documentTargetSchema = z.object({ kind: z.enum(['task', 'note']), id: z.string().min(1).max(160).regex(/^[a-zA-Z0-9@._:-]+$/) });
export type DocumentTarget = z.infer<typeof documentTargetSchema>;
export interface CreateNoteInput { title?: string; content?: string; format?: DocumentFormat; source?: DocumentTarget }
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export function documentParts(target: DocumentTarget) {
  return ['documents', target.kind === 'task' ? 'tasks' : 'notes', `${target.kind}-${encodeURIComponent(target.id).replaceAll('.', '%2E')}`];
}
export function documentFileName(format: DocumentFormat) { return format === 'markdown' ? 'note.md' : 'note.txt'; }
export function assetURL(target: DocumentTarget, relative: string, assetId?: string) {
  if (!isAssetPath(relative)) return '';
  return `gtodo://app/media/${target.kind}/${encodeURIComponent(target.id)}/${encodeURIComponent(relative.slice(7))}?v=${assetId ?? ''}`;
}
