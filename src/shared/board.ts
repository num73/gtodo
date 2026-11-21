import { z } from 'zod';
import { assetIdSchema } from './documents';
import type { RecordItem, Workspace } from './model';

export const BOARD_ID = 'main';
export const BOARD_SIZE = 6000;
const color = z.string().regex(/^#[\da-fA-F]{6}$/);
export const boardLayoutSchema = z.object({
  x: z.number().finite().min(0).max(BOARD_SIZE - 160), y: z.number().finite().min(0).max(BOARD_SIZE - 100),
  width: z.number().finite().min(160).max(1600), height: z.number().finite().min(100).max(1600),
}).refine(value => value.x + value.width <= BOARD_SIZE && value.y + value.height <= BOARD_SIZE, '卡片超出看板范围');
export const boardValuesSchema = z.object({
  backgroundId: assetIdSchema.nullable(), backgroundColor: color,
  backgroundFit: z.enum(['cover', 'contain']), backgroundDim: z.number().min(0).max(0.8),
});
export type BoardValues = z.infer<typeof boardValuesSchema>;
export type Board = RecordItem<BoardValues>;
export const defaultBoard: BoardValues = { backgroundId: null, backgroundColor: '#f1f3f6', backgroundFit: 'cover', backgroundDim: 0 };
export const boardContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), sourceId: z.string().min(1).max(160) }),
  z.object({ kind: z.literal('note'), sourceId: z.string().min(1).max(160) }),
  z.object({ kind: z.literal('text'), text: z.string().trim().min(1).max(10000) }),
  z.object({ kind: z.literal('image'), assetId: assetIdSchema, name: z.string().max(200) }),
]);
export const boardCardValuesSchema = z.object({
  content: boardContentSchema, layout: boardLayoutSchema, z: z.number().int().min(0).max(1e12),
  color, textColor: color, fontSize: z.number().int().min(14).max(96), align: z.enum(['left', 'center', 'right']),
  imageFit: z.enum(['contain', 'cover']), createdAt: z.string().datetime(), deleted: z.boolean(),
});
export const boardCardPatchSchema = boardCardValuesSchema.omit({ createdAt: true, content: true }).partial().extend({
  content: z.object({ kind: z.literal('text'), text: z.string().trim().min(1).max(10000) }).optional(),
});
export type BoardContent = z.infer<typeof boardContentSchema>;
export type BoardLayout = z.infer<typeof boardLayoutSchema>;
export type BoardCardValues = z.infer<typeof boardCardValuesSchema>;
export type BoardCard = RecordItem<BoardCardValues>;
export const defaultCardStyle = { color: '#fff3bf', textColor: '#253047', fontSize: 28, align: 'left' as const, imageFit: 'contain' as const };
export const textBackgrounds = [
  { name: '浅黄', color: '#fff3bf' }, { name: '浅粉', color: '#ffe3e3' },
  { name: '浅蓝', color: '#dbeafe' }, { name: '薄荷绿', color: '#d3f9d8' },
  { name: '淡紫', color: '#e5dbff' }, { name: '杏橙', color: '#ffe8cc' },
  { name: '浅灰', color: '#e9ecef' }, { name: '白色', color: '#ffffff' },
];
export const boardImageInputSchema = z.object({
  destination: z.enum(['card', 'background']), layout: boardLayoutSchema.optional(),
});
export type BoardImageInput = z.infer<typeof boardImageInputSchema>;
export function boardAssetIds(workspace: Workspace): string[] {
  return [...new Set([
    ...workspace.boards.flatMap(board => board.values.backgroundId ? [board.values.backgroundId] : []),
    ...workspace.boardCards.flatMap(card => card.values.content.kind === 'image' ? [card.values.content.assetId] : []),
  ])];
}
export const boardAssetURL = (id: string) => `gtodo://app/board-media/${encodeURIComponent(id)}`;
export function boardCardTitle(card: BoardCard, workspace: Workspace): string {
  const content = card.values.content;
  if (content.kind === 'text') return content.text.slice(0, 80);
  if (content.kind === 'image') return content.name || '图片';
  const item = (content.kind === 'task' ? workspace.tasks : workspace.notes).find(item => item.id === content.sourceId && !item.values.deleted);
  return item ? item.values.title || '无标题便签' : content.kind === 'task' ? '任务已删除' : '便签已删除';
}
export function clampBoardLayout(layout: BoardLayout): BoardLayout {
  const width = Math.round(Math.min(1600, Math.max(160, layout.width))), height = Math.round(Math.min(1600, Math.max(100, layout.height)));
  return { x: Math.round(Math.max(0, Math.min(BOARD_SIZE - width, layout.x))), y: Math.round(Math.max(0, Math.min(BOARD_SIZE - height, layout.y))), width, height };
}
export function resizeBoardLayout(layout: BoardLayout, width: number, height: number): BoardLayout {
  const origin = clampBoardLayout(layout);
  return { ...origin, width: Math.round(Math.min(1600, BOARD_SIZE - origin.x, Math.max(160, width))), height: Math.round(Math.min(1600, BOARD_SIZE - origin.y, Math.max(100, height))) };
}
