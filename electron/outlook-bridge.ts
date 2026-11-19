import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import type { OutlookTarget, OutlookSyncResult } from '../src/shared/outlook';
import type { OutlookEvent } from './outlook-events';

const entryId = z.string().min(1).max(16384).regex(/^[a-f\d]+$/i);
export const outlookTargetSchema = z.object({ storeId: entryId, folderId: entryId, name: z.string().min(1).max(1000) });
export interface OutlookParent { storeId: string; folderId: string; name: string }
export type OutlookRequest = { action: 'list' } | { action: 'connect'; parent: OutlookParent } | { action: 'sync'; target: OutlookTarget; tasks: OutlookEvent[] };
export interface OutlookBridge {
  list(signal?: AbortSignal): Promise<OutlookParent[]>;
  connect(parent: OutlookParent, signal?: AbortSignal): Promise<OutlookTarget>;
  sync(target: OutlookTarget, tasks: OutlookEvent[], signal?: AbortSignal): Promise<OutlookSyncResult>;
}
const countsSchema = z.object({ created: z.number().int().nonnegative(), updated: z.number().int().nonnegative(), removed: z.number().int().nonnegative(), unchanged: z.number().int().nonnegative() });

export function createOutlookBridge(script: string): OutlookBridge {
  const request = (input: OutlookRequest, signal?: AbortSignal): Promise<unknown> => new Promise((resolve, reject) => {
    if (process.platform !== 'win32') { reject(new Error('Outlook 本地同步仅支持 Windows。')); return; }
    if (signal?.aborted) { reject(new Error('日历同步已停止。')); return; }
    const data = JSON.stringify(input);
    if (Buffer.byteLength(data) > 32 * 1024 * 1024) { reject(new Error('待同步内容超过 32 MB，请减少任务备注或步骤后重试。')); return; }
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => { child.kill(); finish(new Error('日历同步已停止。')); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Outlook 响应超时。请打开经典 Outlook，处理登录或提示窗口后重试。')); }, 90000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > 1024 * 1024) { child.kill(); finish(new Error('Outlook 返回的数据过大。')); }
    });
    // COM errors are returned in a bounded JSON envelope; never log task text or account data.
    child.stderr.resume();
    child.on('error', () => finish(new Error('无法启动 Outlook 同步组件，请检查 Windows PowerShell 是否可用。')));
    child.stdin.on('error', () => {});
    child.on('close', () => {
      if (settled) return;
      try {
        const reply = z.object({ ok: z.boolean(), data: z.unknown().optional(), error: z.string().max(2000).optional() }).parse(JSON.parse(output.replace(/^\uFEFF/, '').trim()));
        if (!reply.ok) finish(new Error(reply.error || 'Outlook 同步失败。')); else finish(undefined, reply.data);
      } catch { finish(new Error('无法读取 Outlook 同步结果，请打开经典 Outlook 后重试。')); }
    });
    child.stdin.end(data, 'utf8');
  });
  return {
    list: async signal => z.array(outlookTargetSchema).max(100).parse(await request({ action: 'list' }, signal)),
    connect: async (parent, signal) => outlookTargetSchema.parse(await request({ action: 'connect', parent }, signal)),
    sync: async (target, tasks, signal) => countsSchema.parse(await request({ action: 'sync', target, tasks }, signal)),
  };
}
