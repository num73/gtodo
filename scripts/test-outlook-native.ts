import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createOutlookBridge, type OutlookParent } from '../electron/outlook-bridge';
import { outlookEvents } from '../electron/outlook-events';
import { WorkspaceEngine } from '../src/shared/engine';

if (process.platform !== 'win32') throw new Error('Native Outlook test requires Windows and configured classic Outlook.');
await mkdir('.qa', { recursive: true });
const storePath = path.resolve('.qa', `outlook-integration-${randomUUID()}.pst`);
const fixturePath = path.resolve('.qa/outlook-test-fixture.ps1');
await writeFile(fixturePath, '\ufeff' + await readFile('scripts/outlook-test-fixture.ps1', 'utf8'));
function fixture<T>(action: string, input: Record<string, string> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', fixturePath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', text => { output += text; }); child.stderr.resume();
    const timer = setTimeout(() => { child.kill(); reject(new Error('Native fixture timed out.')); }, 90000);
    child.on('error', error => { clearTimeout(timer); reject(error); }); child.stdin.on('error', () => {});
    child.on('close', () => { clearTimeout(timer); try { const reply = JSON.parse(output.replace(/^\uFEFF/, '')); if (!reply.ok) reject(new Error(reply.error)); else resolve(reply.data); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify({ action, storePath, ...input }), 'utf8');
  });
}
interface EventRow { entryId: string; subject: string; body: string; date: string; endDate: string; allDay: boolean; reminder: boolean }
const bridge = createOutlookBridge(path.resolve('dist-electron/outlook-bridge.ps1'));
try {
  const parent = await fixture<OutlookParent>('setup');
  const target = await bridge.connect(parent);
  assert.match(target.name, /GTodo \(2\)$/); // The existing unmarked calendar is not adopted.
  const marked = await fixture<{ description: string }>('inspect-folder', { folderId: target.folderId });
  assert.equal(marked.description, 'GTodoCalendar {1ADCF3C8-8F33-4499-A7A5-3FC2DC9DF0AD} app.gtodo.desktop.v1');
  const reopened = await bridge.connect(parent); assert.equal(reopened.folderId, target.folderId);
  await assert.rejects(bridge.sync(parent, []), /标记/);
  await fixture('seed', { folderId: target.folderId });
  const engine = new WorkspaceEngine('native-calendar-test');
  for (const title of ['中文日程 🙂', '待删除', '待清除日期']) engine.apply({ type: 'task.add', title, listId: 'inbox', dueDate: '2028-02-29' });
  const [first, second, third] = engine.state.tasks.map(task => task.id);
  engine.apply({ type: 'task.update', id: first, patch: { notes: '换行\n引号 " ; $(literal) <tag>', important: true } });
  engine.apply({ type: 'step.add', taskId: first, title: '步骤一' });
  let result = await bridge.sync(target, outlookEvents(engine.state)); assert.equal(result.created, 3);
  result = await bridge.sync(target, outlookEvents(engine.state));
  if (result.unchanged !== 3) console.log(JSON.stringify({ result, desired: outlookEvents(engine.state), actual: await fixture('inspect', { folderId: target.folderId }) }, null, 2));
  assert.equal(result.unchanged, 3); assert.equal(result.created, 0);
  let rows = await fixture<EventRow[]>('inspect', { folderId: target.folderId });
  assert.equal(rows.length, 4);
  const firstEvent = rows.find(row => row.subject === '中文日程 🙂')!;
  assert.equal(firstEvent.date, '2028-02-29'); assert.equal(firstEvent.endDate, '2028-03-01'); assert.equal(firstEvent.allDay, true); assert.equal(firstEvent.reminder, false);
  assert.match(firstEvent.body, /\$\(literal\)/); assert.match(firstEvent.body, /步骤一/);
  await fixture('edit', { folderId: target.folderId, entryId: firstEvent.entryId });
  result = await bridge.sync(target, outlookEvents(engine.state)); assert.equal(result.updated, 1);
  engine.apply({ type: 'task.update', id: first, patch: { title: '已更新', dueDate: '2028-03-02', completed: true } });
  engine.apply({ type: 'task.update', id: second, patch: { deleted: true } });
  engine.apply({ type: 'task.update', id: third, patch: { dueDate: null } });
  result = await bridge.sync(target, outlookEvents(engine.state)); assert.equal(result.updated, 1); assert.equal(result.removed, 2);
  rows = await fixture<EventRow[]>('inspect', { folderId: target.folderId });
  assert.equal(rows.length, 2); assert.ok(rows.some(row => row.subject === 'Unmanaged fixture event'));
  assert.equal(rows.find(row => row.subject === '✓ 已更新')!.date, '2028-03-02');
  // A record absent from this workspace must never be pruned.
  await bridge.sync(target, [{ id: 'another-device-task', event: { ...outlookEvents(engine.state)[0].event!, subject: 'Other workspace task' } }]);
  result = await bridge.sync(target, outlookEvents(engine.state)); assert.equal(result.removed, 0);
  rows = await fixture<EventRow[]>('inspect', { folderId: target.folderId }); assert.equal(rows.length, 3);
  await fixture('tamper-marker', { folderId: target.folderId });
  await assert.rejects(bridge.sync(target, outlookEvents(engine.state)), /标记/);
  rows = await fixture<EventRow[]>('inspect', { folderId: target.folderId }); assert.equal(rows.length, 3);
  await fixture('legacy-marker', { folderId: target.folderId });
  assert.equal((await bridge.connect(parent)).folderId, target.folderId);
  result = await bridge.sync(target, outlookEvents(engine.state)); assert.equal(result.unchanged, 1);
  assert.equal((await fixture<{ description: string }>('inspect-folder', { folderId: target.folderId })).description, 'Preserve legacy calendar description');
  console.log('Native Outlook PASS: standard and legacy folder markers, tamper protection, Unicode, all-day dates, idempotence, updates, completion, explicit deletion, unmanaged event protection, no missing-record pruning.');
} finally {
  await fixture('cleanup');
  console.log('Detached isolated local test PST.');
}
