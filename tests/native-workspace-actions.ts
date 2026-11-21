import { app, BrowserWindow, dialog, session } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { SnapshotFiles } from '../electron/snapshot-files';
import { withBackupArchive } from '../electron/backup-archive';

assert.ok(process.env.GTODO_DATA_DIR?.startsWith(path.resolve('.qa') + path.sep), 'Only isolated test profiles are allowed');
app.getAppPath = () => path.resolve('.');
require(path.resolve('dist-electron/main.cjs'));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  for (let i = 0; i < 300; i++) { const value = await read(); if (value) return value as NonNullable<T>; await pause(25); }
  throw new Error(`Timeout: ${label}`);
}
const changeTextarea = (label: string, value: string) => `(() => { const el = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)}); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', {bubbles:true})); })()`;
void (async () => {
  await app.whenReady();
  const main = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('index.html')), 'main window');
  main.setTitle('GTodo — 保存与备份测试（独立数据）');
  const evaluate = (code: string) => main.webContents.executeJavaScript(code);
  await until(() => evaluate('!!document.querySelector(".composer")'), 'main UI');
  assert.equal(app.commandLine.hasSwitch('disable-http-cache'), true);
  assert.equal(await session.defaultSession.getCacheSize(), 0, 'rendered content must not leave an HTTP cache in AppData');
  await evaluate(`window.gtodo.command({type:'task.add',title:'原任务名称',listId:'inbox',myDay:new Date().toLocaleDateString('sv-SE')})`);
  await until(() => evaluate('!!document.querySelector(".task-body")'), 'created task');
  await evaluate(`document.querySelector('.task-body').click()`);
  await until(() => evaluate('!!document.querySelector("[aria-label=任务名称]")'), 'task editor');
  const exportFile = path.join(__dirname, 'backup.json');
  dialog.showSaveDialog = (async () => ({ canceled: false, filePath: exportFile })) as typeof dialog.showSaveDialog;
  const attempt = (method: string) => evaluate(`window.gtodo.${method}().then(() => ({ok:true}), error => ({ok:false,error:String(error)}))`);
  await evaluate(changeTextarea('任务名称', ''));
  const rejectedExport = await attempt('exportBackup');
  assert.equal(rejectedExport.ok, false, 'export must fail when an editor cannot save');
  assert.match(rejectedExport.error, /尚未保存/);
  await assert.rejects(stat(exportFile), 'failed export must not create a stale backup');

  await evaluate(changeTextarea('任务名称', '备份中的最新名称'));
  const noteId = await evaluate(`window.gtodo.createNote({title:'独立便签',content:'初始内容'})`);
  const note = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes(`note=${noteId}`)), 'note window');
  await until(() => note.webContents.executeJavaScript('!!document.querySelector(".document-source")'), 'note editor');
  await note.webContents.executeJavaScript(`(() => { const el=document.querySelector('.document-source'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'便签尚未自动保存的最后一个字'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  assert.equal((await attempt('exportBackup')).ok, true);
  const backup = JSON.parse(await readFile(exportFile, 'utf8'));
  assert.equal(backup.tasks[0].values.title, '备份中的最新名称');
  assert.equal(backup.notes.find((value: any) => value.id === noteId).values.content, '便签尚未自动保存的最后一个字');
  assert.equal(note.isEnabled(), true, 'export must restore note interaction');

  const destination = path.join(__dirname, 'new-folder'); await mkdir(destination);
  const originalPath = await evaluate('window.gtodo.getState().then(s=>s.dataPath)');
  dialog.showOpenDialog = (async (...args: any[]) => ({ canceled: false, filePaths: [args.at(-1).properties.includes('openDirectory') ? destination : exportFile] })) as typeof dialog.showOpenDialog;
  await evaluate(changeTextarea('任务名称', ''));
  for (const method of ['chooseDataFolder', 'importBackup']) {
    const rejected = await attempt(method); assert.equal(rejected.ok, false, `${method} must wait for valid drafts`); assert.match(rejected.error, /尚未保存/);
    assert.equal(await evaluate('window.gtodo.getState().then(s=>s.dataPath)'), originalPath);
    assert.equal(note.isEnabled(), true);
  }
  await evaluate(changeTextarea('任务名称', '切换目录前的最后一个字'));
  assert.equal((await attempt('chooseDataFolder')).ok, true);
  let state = await evaluate('window.gtodo.getState()');
  assert.equal(state.dataPath, destination); assert.equal(state.workspace.tasks.length, 0); assert.equal(state.workspace.notes.length, 0);
  assert.equal(note.isDestroyed(), true, 'old sticky windows cannot keep editing another directory');
  const snapshot = await new SnapshotFiles().decode(JSON.parse(await readFile(path.join(originalPath, `device-${state.deviceId}.json`), 'utf8')), originalPath);
  assert.equal(snapshot.tasks[0].values.title, '切换目录前的最后一个字');
  assert.equal(snapshot.notes[0].values.content, '便签尚未自动保存的最后一个字');
  assert.equal((await attempt('importBackup')).ok, true);
  state = await evaluate('window.gtodo.getState()');
  await until(() => evaluate('!!document.querySelector(".task-body")'), 'imported task');
  await evaluate(`document.querySelector('.task-body').click()`);
  await until(() => evaluate('!!document.querySelector("textarea[aria-label=备注]")'), 'imported task editor');
  const taskId = state.workspace.tasks[0].id;
  for (const body of ['历史第一稿', '历史第二稿']) await evaluate(`window.gtodo.command({type:'task.update',id:${JSON.stringify(taskId)},patch:{notes:${JSON.stringify(body)}}})`);
  await until(() => evaluate('document.querySelector("textarea[aria-label=备注]").value === "历史第二稿"'), 'history draft refresh');
  await evaluate('document.querySelector("[aria-label=正文历史版本]").click()');
  await until(() => evaluate('document.querySelector("[aria-label=选择历史版本]")?.options.length >= 2'), 'history selector');
  await evaluate(`(()=>{const select=document.querySelector('[aria-label=选择历史版本]'); select.value=Array.from(select.options).find(option=>option.textContent.includes('历史第一稿')).value;select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await evaluate('Array.from(document.querySelectorAll("button")).find(button=>button.textContent === "还原此版本").click()');
  await evaluate('Array.from(document.querySelectorAll("button")).find(button=>button.textContent === "确认还原版本").click()');
  await until(() => evaluate('document.querySelector("textarea[aria-label=备注]").value === "历史第一稿"'), 'history restore');
  const zipFile = path.join(__dirname, 'backup.zip');
  dialog.showSaveDialog = (async () => ({ canceled: false, filePath: zipFile })) as typeof dialog.showSaveDialog;
  assert.equal((await attempt('exportBackup')).ok, true);
  await withBackupArchive(zipFile, path.join(destination, '.gtodo'), async workspace => {
    assert.equal(workspace.tasks[0].values.notes, '历史第一稿');
    assert.ok(workspace.documentRevisions.some(item => item.content === '历史第二稿'));
  });
  dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [zipFile] })) as typeof dialog.showOpenDialog;
  assert.equal((await attempt('importBackup')).ok, true);
  await writeFile(path.join(__dirname, 'result.json'), JSON.stringify({ passed: true, checks: ['failed export preserves file', 'export flushes task and note', 'failed import and relocation preserve workspace', 'relocation flushes drafts', 'note interaction restored'] }, null, 2));
  app.quit();
})().catch(async error => { await writeFile(path.join(__dirname, 'result.json'), JSON.stringify({ passed: false, error: String(error) })); app.exit(1); });
