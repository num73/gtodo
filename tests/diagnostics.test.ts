import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Diagnostics } from '../electron/diagnostics';
import { temporaryDirectory } from './helpers';

test('local diagnostics serialize failures and retain only the current and previous log', async t => {
  const directory = await temporaryDirectory(t); const log = new Diagnostics(directory, 150);
  for (let attempt = 1; attempt <= 5; attempt++) log.report('note-load-failed', { attempt, error: 'ERR_FAILED' });
  await log.flush();
  assert.deepEqual((await readdir(directory)).sort(), ['diagnostics.log', 'diagnostics.log.previous']);
  assert.equal(JSON.parse((await readFile(log.file, 'utf8')).trim()).attempt, 5);
  assert.equal(JSON.parse((await readFile(`${log.file}.previous`, 'utf8')).trim()).attempt, 4);
});
