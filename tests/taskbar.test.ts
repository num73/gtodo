import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { APP_USER_MODEL_ID, taskbarDetails } from '../electron/taskbar';

test('taskbar pins the outer portable launcher instead of the disposable process executable', () => {
  const launcher = 'E:\\我的软件 & tools\\GTodo-v0.1.2-Windows-x64.exe';
  const first = taskbarDetails({platform: 'win32', packaged: true, executable: 'C:\\Temp\\nsc123.tmp\\app\\GTodo.exe', portableExecutable: launcher});
  const next = taskbarDetails({platform: 'win32', packaged: true, executable: 'C:\\Temp\\nsc999.tmp\\app\\GTodo.exe', portableExecutable: launcher});
  assert.deepEqual(first, next);
  assert.equal(first?.relaunchCommand, `"${launcher}"`);
  assert.equal(first?.appIconPath, launcher);
  assert.equal(first?.relaunchDisplayName, 'GTodo');
});

test('ZIP builds use their installed executable and ignore malformed launcher paths', () => {
  const executable = 'D:\\Apps\\GTodo\\GTodo.exe';
  for (const portableExecutable of [undefined, '', 'GTodo.exe', 'D:\\tools\\GTodo.exe" --flag.exe', 'D:\\bad\nGTodo.exe', 'https://example.com/GTodo.exe']) {
    const details = taskbarDetails({platform: 'win32', packaged: true, executable, portableExecutable});
    assert.equal(details?.relaunchCommand, `"${executable}"`);
    assert.equal(details?.appIconPath, executable);
  }
});

test('taskbar identity matches packaging and never creates development Electron relaunch entries', async () => {
  const config = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(APP_USER_MODEL_ID, config.build.appId);
  assert.equal(taskbarDetails({platform: 'win32', packaged: false, executable: 'electron.exe'}), null);
  assert.equal(taskbarDetails({platform: 'linux', packaged: true, executable: '/usr/bin/gtodo'}), null);
});
