import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { PomodoroTimer } from '../electron/pomodoro';
import { atomicWrite } from '../electron/storage';
import { defaultPomodoroSettings, formatCountdown, remainingTime, type PomodoroCommand, type PomodoroData } from '../src/shared/pomodoro';
import { localDate } from '../src/shared/model';
import { temporaryDirectory } from './helpers';

test('pause, resume and reset preserve elapsed focus without counting partial sessions', async t => {
  let now = new Date(2026, 10, 19, 10).getTime();
  const timer = new PomodoroTimer({ directory: await temporaryDirectory(t), task: () => null, now: () => now });
  await timer.initialize();
  await timer.command({ type: 'start' }); now += 65_500;
  assert.equal(formatCountdown(remainingTime(timer.snapshot().session, now)), '23:55');
  await timer.pause(); assert.equal(timer.snapshot().session.remainingMs, 1_434_500);
  now += 8 * 60_000;
  assert.equal(remainingTime(timer.snapshot().session, now), 1_434_500);
  await timer.command({ type: 'start' }); now += 500;
  assert.equal(remainingTime(timer.snapshot().session, now), 1_434_000);
  await timer.command({ type: 'reset' });
  assert.equal(timer.snapshot().session.status, 'idle');
  assert.equal(timer.snapshot().session.remainingMs, 1_500_000);
  assert.equal(timer.snapshot().today.completed, 0);
});

test('a delayed background tick completes once and waits for a manually started break', async t => {
  let now = new Date(2026, 10, 19, 10).getTime(); const completed: unknown[] = [];
  const timer = new PomodoroTimer({ directory: await temporaryDirectory(t), task: () => null, now: () => now, completed: value => completed.push(value) });
  await timer.initialize();
  await Promise.all([timer.command({ type: 'start' }), timer.command({ type: 'start' })]);
  now += 3 * 60 * 60_000;
  await Promise.all([timer.tick(), timer.tick(), timer.pause()]);
  assert.equal(completed.length, 1);
  assert.equal(timer.snapshot().today.completed, 1); assert.equal(timer.snapshot().today.minutes, 25);
  assert.equal(timer.snapshot().session.phase, 'shortBreak'); assert.equal(timer.snapshot().session.status, 'idle');
  now += 60 * 60_000; await timer.tick(); assert.equal(completed.length, 1);
});

test('four completed focuses select the long break and its completion starts a new cycle', async t => {
  let now = new Date(2026, 10, 19, 10).getTime();
  const timer = new PomodoroTimer({ directory: await temporaryDirectory(t), task: () => null, now: () => now }); await timer.initialize();
  for (let cycle = 1; cycle <= 4; cycle++) {
    await timer.command({ type: 'start' }); now += 25 * 60_000; await timer.tick();
    assert.equal(timer.snapshot().cycleCompleted, cycle);
    assert.equal(timer.snapshot().session.phase, cycle === 4 ? 'longBreak' : 'shortBreak');
    await timer.command({ type: 'start' }); now += (cycle === 4 ? 15 : 5) * 60_000; await timer.tick();
    assert.equal(timer.snapshot().session.phase, 'focus');
  }
  assert.equal(timer.snapshot().today.completed, 4); assert.equal(timer.snapshot().today.minutes, 100);
  assert.equal(timer.snapshot().cycleCompleted, 0);
});

test('quit/suspend pauses survive restart and do not count offline time', async t => {
  const directory = await temporaryDirectory(t); let now = new Date(2026, 10, 19, 10).getTime();
  const options = { directory, task: () => null, now: () => now };
  const first = new PomodoroTimer(options); await first.initialize();
  await first.command({ type: 'start' }); now += 42_000; await first.pause();
  now += 24 * 60 * 60_000;
  const restarted = new PomodoroTimer(options); await restarted.initialize(); await restarted.tick();
  assert.equal(restarted.snapshot().session.status, 'paused');
  assert.equal(restarted.snapshot().session.remainingMs, 1_458_000);
  assert.equal(restarted.snapshot().today.completed, 0);
  await restarted.command({ type: 'start' }); now += 1_458_000; await restarted.tick();
  assert.equal(restarted.snapshot().today.completed, 1);
});

test('unexpected restart recovers a running deadline and does not repeat a committed completion', async t => {
  const directory = await temporaryDirectory(t); let now = new Date(2026, 10, 19, 10).getTime(); let notifications = 0;
  const options = { directory, task: () => null, now: () => now, completed: () => { notifications++; } };
  const first = new PomodoroTimer(options); await first.initialize(); await first.command({ type: 'start' });
  now += 20 * 60_000;
  const recovered = new PomodoroTimer(options); await recovered.initialize();
  assert.equal(remainingTime(recovered.snapshot().session, now), 5 * 60_000);
  now += 5 * 60_000; await recovered.tick();
  const again = new PomodoroTimer(options); await again.initialize(); await again.tick();
  assert.equal(again.snapshot().today.completed, 1); assert.equal(notifications, 1);
});

test('tasks resolve on the main process and cannot be switched mid-session', async t => {
  let title = '准备演示'; let exists = true;
  const timer = new PomodoroTimer({ directory: await temporaryDirectory(t), task: id => id === 'task-1' && exists ? { id, title } : null }); await timer.initialize();
  await assert.rejects(timer.command({ type: 'select', taskId: 'missing' }), /已完成或删除/);
  await timer.command({ type: 'select', taskId: 'task-1' }); title = '修改后的演示';
  await timer.command({ type: 'start' }); assert.equal(timer.snapshot().session.task?.title, title);
  await timer.pause();
  await assert.rejects(timer.command({ type: 'select', phase: 'longBreak' }), /重置/);
  await assert.rejects(timer.command({ type: 'configure', settings: { ...defaultPomodoroSettings, focusMinutes: 50 } }), /重置/);
  await timer.command({ type: 'reset' }); exists = false;
  await timer.command({ type: 'start' }); assert.equal(timer.snapshot().session.task, null);
});

test('custom durations persist, enforce bounds and determine completed minutes', async t => {
  const directory = await temporaryDirectory(t); let now = new Date(2026, 10, 19, 10).getTime();
  const options = { directory, task: () => null, now: () => now };
  const timer = new PomodoroTimer(options); await timer.initialize();
  const settings = { focusMinutes: 50, shortBreakMinutes: 10, longBreakMinutes: 20, longBreakEvery: 3 };
  assert.throws(() => timer.command({ type: 'configure', settings: { ...settings, focusMinutes: 0 } }));
  assert.throws(() => timer.command({ type: 'select', phase: 'unknown' } as unknown as PomodoroCommand));
  await timer.command({ type: 'configure', settings }); await timer.command({ type: 'start' });
  now += 50 * 60_000; await timer.tick();
  const restarted = new PomodoroTimer(options); await restarted.initialize();
  assert.deepEqual(restarted.snapshot().settings, settings);
  assert.equal(restarted.snapshot().session.remainingMs, 10 * 60_000);
  assert.equal(restarted.snapshot().today.minutes, 50);
});

test('daily totals use the completion date and roll over without a running timer', async t => {
  let now = new Date(2026, 10, 19, 23, 50).getTime();
  const timer = new PomodoroTimer({ directory: await temporaryDirectory(t), task: () => null, now: () => now }); await timer.initialize();
  await timer.command({ type: 'start' }); now += 25 * 60_000; await timer.tick();
  assert.equal(timer.snapshot().today.date, localDate(new Date(2026, 10, 20)));
  assert.equal(timer.snapshot().today.completed, 1);
  now += 24 * 60 * 60_000; await timer.tick(); assert.equal(timer.snapshot().today.completed, 0);
});

test('failed disk write leaves timer and totals unchanged; retry only completes once', async t => {
  let fail = false; let now = new Date(2026, 10, 19, 10).getTime(); let completed = 0;
  const timer = new PomodoroTimer({ directory: await temporaryDirectory(t), task: () => null, now: () => now, completed: () => { completed++; },
    write: async (file, content) => { if (fail && file.endsWith('pomodoro.json')) throw new Error('Disk full'); await atomicWrite(file, content); } });
  await timer.initialize(); await timer.command({ type: 'start' }); now += 25 * 60_000; fail = true;
  await assert.rejects(timer.tick(), /未能保存/);
  assert.equal(timer.snapshot().today.completed, 0); assert.equal(completed, 0);
  assert.equal(timer.snapshot().session.status, 'running');
  fail = false; await timer.tick(); await timer.tick();
  assert.equal(timer.snapshot().today.completed, 1); assert.equal(completed, 1); assert.equal(timer.snapshot().error, null);
});

test('timer file corruption recovers a valid backup without touching task data', async t => {
  const directory = await temporaryDirectory(t); const options = { directory, task: () => null };
  const timer = new PomodoroTimer(options); await timer.initialize(); await timer.command({ type: 'start' }); await timer.pause();
  const backup = JSON.parse(await readFile(`${timer.file}.bak`, 'utf8')) as PomodoroData;
  await writeFile(timer.file, '{broken', 'utf8');
  const recovered = new PomodoroTimer(options); await recovered.initialize();
  assert.deepEqual(recovered.snapshot().session, backup.session); assert.equal(recovered.snapshot().unavailable, false);
  await writeFile(timer.file, '{broken', 'utf8'); await writeFile(`${timer.file}.bak`, '{broken', 'utf8');
  const unavailable = new PomodoroTimer(options); await unavailable.initialize();
  assert.equal(unavailable.snapshot().unavailable, true);
  await assert.rejects(unavailable.command({ type: 'start' }), /番茄钟数据无法读取/);
  assert.equal(await readFile(timer.file, 'utf8'), '{broken');
});
