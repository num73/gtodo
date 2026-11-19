import { z } from 'zod';

export const captureSelectionSchema = z.object({
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1),
}).refine(rect => rect.x + rect.width <= 1.000001 && rect.y + rect.height <= 1.000001, '截图区域超出屏幕。');
export type CaptureSelection = z.infer<typeof captureSelectionSchema>;
export interface CapturePreview { image: string; width: number; height: number }
export interface CaptureAPI {
  getPreview(): Promise<CapturePreview>;
  ready(): Promise<void>;
  select(rect: CaptureSelection): Promise<void>;
  cancel(): Promise<void>;
}
export function capturePixels(input: unknown, size: { width: number; height: number }) {
  const rect = captureSelectionSchema.parse(input);
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1) throw new Error('屏幕图像尺寸无效。');
  const x = Math.min(size.width - 1, Math.floor(rect.x * size.width + 1e-7));
  const y = Math.min(size.height - 1, Math.floor(rect.y * size.height + 1e-7));
  const right = Math.min(size.width, Math.ceil((rect.x + rect.width) * size.width - 1e-7));
  const bottom = Math.min(size.height, Math.ceil((rect.y + rect.height) * size.height - 1e-7));
  if (right - x < 2 || bottom - y < 2) throw new Error('截图区域太小，请重新框选。');
  return { x, y, width: right - x, height: bottom - y };
}
