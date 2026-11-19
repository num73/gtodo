import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

test('calendar marker works without named folder properties, preserves legacy ownership and fails closed on permission errors', { skip: process.platform !== 'win32' }, async () => {
  const result = await promisify(execFile)(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/test-outlook-markers.ps1')],
    { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.match(result.stdout, /Calendar marker regression PASS/);
});
