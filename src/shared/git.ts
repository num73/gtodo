import { z } from 'zod';
export const gitConfigureSchema = z.object({
  enabled: z.boolean(), initialize: z.boolean().optional(),
  remote: z.string().trim().max(2000).refine(value => !/[\r\n\0]/.test(value) && !value.startsWith('-'), '远程地址无效').optional(),
  userName: z.string().trim().max(200).refine(value => !/[\r\n\0]/.test(value), '用户名无效').optional(),
  userEmail: z.string().trim().max(254).refine(value => !/[\r\n\0]/.test(value), '邮箱无效').optional(),
});
export type GitConfigure = z.infer<typeof gitConfigureSchema>;
export const gitActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add') }), z.object({ type: z.literal('commit'), message: z.string().trim().min(1, '请填写提交说明').max(4000).refine(value => !value.includes('\0')) }),
  z.object({ type: z.literal('pull') }), z.object({ type: z.literal('push') }),
]);
export type GitAction = z.infer<typeof gitActionSchema>;
export interface GitStatus {
  installed: boolean; repository: boolean; enabled: boolean; branch: string; remote: string; userName: string; userEmail: string;
  ahead: number; behind: number; files: { path: string; index: string; worktree: string }[]; error: string | null;
}
export const emptyGitStatus = (): GitStatus => ({ installed: false, repository: false, enabled: false, branch: '', remote: '', userName: '', userEmail: '', ahead: 0, behind: 0, files: [], error: null });
