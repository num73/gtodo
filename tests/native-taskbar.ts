import { app, BrowserWindow, shell } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, link, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { APP_USER_MODEL_ID, taskbarDetails } from '../electron/taskbar';

app.setName('GTodo Taskbar Test'); app.setPath('userData', path.join(__dirname, 'profile'));
app.setAppUserModelId(APP_USER_MODEL_ID);
app.on('window-all-closed', () => {});
const exec = promisify(execFile);
void app.whenReady().then(async () => {
  const directory = path.join(__dirname, 'launchers with spaces & symbols'); await mkdir(directory);
  const regular = path.join(directory, 'GTodo.exe');
  const portable = path.join(directory, 'GTodo-Portable.exe');
  // Real PE icons, but never launch the installed app or read personal GTodo data.
  await link(process.execPath, regular); await link(process.execPath, portable);
  const reports = [];
  for (const outer of [undefined, portable]) {
    const expected = outer ?? regular;
    const details = taskbarDetails({platform: process.platform, packaged: true, executable: regular, portableExecutable: outer})!;
    const window = new BrowserWindow({show: false, webPreferences: {sandbox: true, contextIsolation: true}});
    try {
      window.setAppDetails(details);
      const handle = window.getNativeWindowHandle().readBigUInt64LE().toString();
      const {stdout} = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('tests/read-taskbar-properties.ps1'), '-WindowHandle', handle], {windowsHide: true, timeout: 20000});
      const native = JSON.parse(stdout.replace(/^\ufeff/, ''));
      assert.equal(native.appId, APP_USER_MODEL_ID);
      assert.equal(native.relaunchCommand, `"${expected}"`);
      assert.equal(native.relaunchDisplayName, 'GTodo');
      assert.equal(native.relaunchIcon, `${expected},0`);
      const shortcut = path.join(directory, outer ? 'portable.lnk' : 'zip.lnk');
      assert.ok(shell.writeShortcutLink(shortcut, {target: expected, cwd: path.dirname(expected), icon: expected, iconIndex: 0, appUserModelId: APP_USER_MODEL_ID}));
      const saved = shell.readShortcutLink(shortcut);
      assert.equal(saved.target, expected);
      assert.equal(saved.icon, expected);
      assert.equal(saved.appUserModelId, native.appId);
      reports.push({kind: outer ? 'portable' : 'zip', native, shortcut: saved});
    } finally {window.destroy();}
  }
  await writeFile(path.join(__dirname, 'result.json'), JSON.stringify({passed: true, reports}, null, 2));
  console.log('Native taskbar identity, stable relaunch target and matching shortcut properties passed.');
}).then(() => app.quit()).catch(async error => {
  console.error(error);
  await writeFile(path.join(__dirname, 'result.json'), JSON.stringify({passed: false, error: String(error)}));
  app.exit(1);
});
