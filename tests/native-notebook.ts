import { app, BrowserWindow, type KeyboardInputEvent } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

assert.ok(process.env.GTODO_DATA_DIR?.startsWith(path.resolve('.qa') + path.sep), 'Only isolated test data');
const phase = process.env.GTODO_NOTEBOOK_PHASE ?? 'seed';
app.getAppPath = () => path.resolve('.'); app.getVersion = () => require(path.resolve('package.json')).version;
require(path.resolve('dist-electron/main.cjs'));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  for (let i = 0; i < 400; i++) { const value = await read(); if (value) return value as NonNullable<T>; await pause(25); }
  throw new Error(`Timeout: ${label}`);
}
const evaluate = <T = any>(window: BrowserWindow, code: string): Promise<T> => window.webContents.executeJavaScript(code).catch(error => { throw new Error(`${error}\nScript: ${code}`); });
const state = (window: BrowserWindow) => evaluate(window, 'window.gtodo.getState()');
const source = (window: BrowserWindow) => evaluate<string>(window, 'document.querySelector(".document-source").value');
async function key(window: BrowserWindow, keyCode: string, modifiers: KeyboardInputEvent['modifiers'] = []) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await pause(40);
}
async function click(window: BrowserWindow, selector: string) { await evaluate(window, `document.querySelector(${JSON.stringify(selector)}).click()`); await pause(80); }
async function button(window: BrowserWindow, text: string, scope = 'document') {
  await evaluate(window, `(()=>{const b=[...${scope}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw Error('Button unavailable: '+${JSON.stringify(text)});b.click()})()`); await pause(80);
}
async function fill(window: BrowserWindow, selector: string, text: string) {
  await evaluate(window, `document.querySelector(${JSON.stringify(selector)}).focus()`); await key(window, 'a', ['control']); await window.webContents.insertText(text); await key(window, 'End');
}
async function select(window: BrowserWindow, selector: string, value: string) {
  await evaluate(window, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('change',{bubbles:true}));})()`); await pause(80);
}
async function shot(window: BrowserWindow, name: string) {
  await evaluate(window, 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await writeFile(path.join(__dirname, name + '.png'), (await window.webContents.capturePage()).toPNG());
}
void (async () => {
  await app.whenReady();
  const main = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('index.html')), 'main window');
  main.show(); main.focus(); main.setContentSize(1280, 850);
  const errors: string[] = [];
  main.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  await until(() => evaluate(main, '!!document.querySelector(".sidebar")'), 'main rendered');
  if (phase === 'restore') {
    const saved = await state(main);
    assert.equal(saved.workspace.noteFolders.length, 2); assert.equal(saved.gitEnabled, true);
    assert.deepEqual(saved.workspace.boards[0].values.size, { width: 900, height: 600 });
    assert.ok(saved.workspace.notes.some((note: any) => note.values.content.endsWith('退出前最后一笔')));
    assert.ok(await evaluate(main, `!!document.querySelector('button[aria-label="Git 同步菜单"]')`));
    await writeFile(path.join(__dirname, phase + '.json'), JSON.stringify({ passed: true }));
    await evaluate(main, 'window.gtodo.quit()'); return;
  }
  assert.ok(await evaluate(main, `(()=>{const buttons=[...document.querySelectorAll('.sidebar button')];return buttons.findIndex(b=>b.textContent.startsWith('笔记'))===buttons.findIndex(b=>b.textContent.startsWith('桌面便签'))+1})()`), 'Notebook follows sticky notes');
  await button(main, '笔记');
  await until(() => evaluate(main, '!!document.querySelector(".notebook")'), 'notebook page');
  await button(main, '新建目录'); await fill(main, '[aria-label=目录名称]', '项目'); await button(main, '保存目录');
  await until(async () => (await state(main)).workspace.noteFolders.length === 1, 'parent folder');
  await until(() => evaluate(main, 'document.querySelector(".notebook-folder-row.selected")?.textContent === "项目" && !document.querySelector("dialog[open]")'), 'parent folder selected');
  await button(main, '新建目录'); await fill(main, '[aria-label=目录名称]', '资料'); await button(main, '保存目录');
  await until(async () => (await state(main)).workspace.noteFolders.length === 2, 'child folder');
  await until(() => evaluate(main, 'document.querySelector(".notebook-folder-row.selected")?.textContent === "资料" && !document.querySelector("dialog[open]")'), 'child folder selected');
  const folders = (await state(main)).workspace.noteFolders;
  const childFolder = folders.find((folder: any) => folder.values.name === '资料'), parentFolder = folders.find((folder: any) => folder.values.name === '项目');
  assert.equal(childFolder.values.parentId, parentFolder.id);
  await button(main, '新建笔记'); await until(() => evaluate(main, '!!document.querySelector(".cm-content")'), 'notebook editor');
  await fill(main, '[aria-label=笔记标题]', '项目笔记');
  await evaluate(main, 'document.querySelector(".cm-content").focus()'); await main.webContents.insertText('标题\n\n待替换内容\n\n- [ ] 整理资料');
  await key(main, 'Home', ['control']); await key(main, 'End', ['shift']);
  await click(main, '[aria-label=设置笔记内容格式]'); await button(main, '二级标题');
  await until(async () => (await source(main)).startsWith('## 标题'), 'format toolbar');
  await evaluate(main, 'document.querySelector(".cm-content").focus()'); await key(main, 'h', ['control']);
  await until(() => evaluate(main, '!!document.querySelector(".cm-search input[name=search]")'), 'search panel');
  await fill(main, '.cm-search input[name=search]', '待替换'); await fill(main, '.cm-search input[name=replace]', '更新后的');
  await button(main, '全部替换', 'document.querySelector(".cm-search")');
  await until(async () => (await source(main)).includes('更新后的内容'), 'replace all'); await key(main, 'Escape');
  await click(main, '[aria-label=展开笔记内容编辑器]');
  const rect = await evaluate(main, '(()=>{const r=document.querySelector(".document-expanded").getBoundingClientRect();return {width:r.width,height:r.height,innerWidth,innerHeight}})()');
  assert.ok(rect.width >= rect.innerWidth - 10 && rect.height >= rect.innerHeight - 45, JSON.stringify(rect));
  await shot(main, 'expanded-editor'); await click(main, '[aria-label=收起笔记内容编辑器]');
  await shot(main, 'notebook');
  const id = (await state(main)).workspace.notes[0].id;
  assert.equal((await state(main)).workspace.notes[0].values.folderId, childFolder.id);
  await button(main, '关联便签');
  let sticky = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes(`note=${id}`)), 'linked sticky window');
  await until(() => evaluate(sticky, '!!document.querySelector(".cm-content")'), 'sticky editor'); sticky.show(); sticky.focus();
  await evaluate(sticky, 'document.querySelector(".cm-content").focus()'); await key(sticky, 'End', ['control']); await sticky.webContents.insertText('\n便签同步修改');
  await key(sticky, 's', ['control']); await until(async () => (await source(main)).endsWith('便签同步修改'), 'shared body');
  await evaluate(main, `window.gtodo.deleteNote(${JSON.stringify(id)})`);
  assert.equal((await state(main)).workspace.notes[0].values.deleted, false);
  assert.equal((await state(main)).workspace.notes[0].values.desktop, 'removed');
  assert.equal((await evaluate(main, 'window.gtodo.getTrash()')).items.length, 0);
  main.focus(); await button(main, '关联便签');
  sticky = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes(`note=${id}`)), 'reopened sticky');
  await until(() => evaluate(sticky, '!!document.querySelector(".cm-content")'), 'reopened editor');
  await click(main, '[aria-label=删除当前笔记]'); await button(main, '删除笔记');
  assert.equal((await state(main)).workspace.notes[0].values.deleted, false);
  assert.equal((await state(main)).workspace.notes[0].values.notebook, 'removed');
  await evaluate(main, `window.gtodo.deleteNote(${JSON.stringify(id)})`);
  const trash = await evaluate(main, 'window.gtodo.getTrash()'); assert.equal(trash.items.length, 1);
  await evaluate(main, `window.gtodo.restoreTrash(${JSON.stringify(trash.items[0])})`);
  assert.equal((await state(main)).workspace.notes[0].values.notebook, 'visible');
  const convertId = await evaluate(main, `window.gtodo.createNote({title:'便签转笔记',content:'保留原文'})`);
  const convertWindow = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes(`note=${convertId}`)), 'convert sticky');
  await until(() => evaluate(convertWindow, '!!document.querySelector(".cm-content")'), 'convert editor');
  await click(convertWindow, '[aria-label=便签编辑选项]'); await click(convertWindow, 'button[aria-label=转为笔记]');
  await until(() => evaluate(main, 'document.querySelector("[aria-label=笔记标题]")?.value === "便签转笔记"'), 'convert opens notebook');
  assert.equal((await state(main)).workspace.notes.find((note: any) => note.id === convertId).values.desktop, 'none');
  await until(() => convertWindow.isDestroyed(), 'converted sticky closes');
  await evaluate(main, 'document.querySelector(".board-nav").click()');
  await until(() => evaluate(main, '!!document.querySelector(".board-panel")'), 'board');
  await evaluate(main, `window.gtodo.command({type:'board.card.add',content:{kind:'text',text:'边缘贴纸保留'},layout:{x:1300,y:700,width:300,height:300}})`);
  await click(main, '[title=设置看板尺寸]'); await select(main, '[aria-label=看板参考尺寸]', '紧凑'); await button(main, '应用尺寸');
  await until(async () => (await state(main)).workspace.boards[0]?.values.size.width === 1280, 'preset size');
  await click(main, '[title=设置看板尺寸]'); await select(main, '[aria-label=看板参考尺寸]', 'custom');
  assert.equal(await evaluate(main, 'document.querySelector("[aria-label=看板参考尺寸]").value'), 'custom');
  await fill(main, '[aria-label=看板宽度]', '900'); await fill(main, '[aria-label=看板高度]', '600'); await button(main, '应用尺寸');
  await until(async () => (await state(main)).workspace.boards[0]?.values.size.width === 900, 'custom size');
  const card = (await state(main)).workspace.boardCards[0]; assert.ok(card.values.layout.x + card.values.layout.width <= 900 && card.values.layout.y + card.values.layout.height <= 600);
  await shot(main, 'custom-board');
  await click(main, '[aria-label=打开设置]'); await click(main, '#settings-tab-3');
  await until(() => evaluate(main, '[...document.querySelectorAll("button")].some(b=>b.textContent === "初始化 Git 并启用" && !b.disabled)'), 'git installed');
  await fill(main, '[aria-label="Git 提交用户名"]', 'GTodo QA'); await fill(main, '[aria-label="Git 提交邮箱"]', 'qa@example.invalid');
  await button(main, '初始化 Git 并启用'); await until(async () => (await state(main)).gitEnabled, 'git enabled');
  await until(() => evaluate(main, `!!document.querySelector('button[aria-label="Git 同步菜单"]') && !document.querySelector('[aria-label=关闭对话框]').disabled`), 'git configuration published and controls enabled');
  await shot(main, 'git-settings'); await click(main, '[aria-label=关闭对话框]'); await click(main, 'button[aria-label="Git 同步菜单"]');
  await until(() => evaluate(main, '[...document.querySelectorAll(".git-popover button")].some(b=>b.textContent === "Add · 暂存" && !b.disabled)'), 'git status');
  await button(main, 'Add · 暂存'); await until(() => evaluate(main, 'document.querySelector(".git-popover [role=status]")?.textContent === "暂存完成"'), 'git add');
  await fill(main, '[aria-label="Git 提交说明"]', '保存笔记与看板'); await button(main, 'Commit · 提交');
  await until(() => evaluate(main, 'document.querySelector(".git-popover [role=status]")?.textContent === "提交完成"'), 'git commit');
  assert.equal((await evaluate(main, 'window.gtodo.getGitStatus()')).files.length, 0);
  await shot(main, 'git-menu'); await click(main, '[aria-label="关闭 Git 菜单"]');
  await evaluate(main, `window.gtodo.showNotebook(${JSON.stringify(id)})`);
  await until(() => evaluate(main, 'document.querySelector("[aria-label=笔记标题]")?.value === "项目笔记"'), 'return to notebook');
  main.setContentSize(720, 720); await evaluate(main, 'window.gtodo.setZoom(150)');
  assert.ok(await evaluate(main, 'document.documentElement.scrollWidth <= innerWidth + 1'), 'no horizontal overflow');
  await shot(main, 'compact-notebook'); await evaluate(main, 'window.gtodo.setZoom(100)'); main.setContentSize(1280, 850);
  assert.deepEqual(errors, [], 'No renderer errors');
  main.focus(); await evaluate(main, 'document.querySelector(".cm-content").focus()'); await key(main, 'End', ['control']); await main.webContents.insertText('退出前最后一笔');
  await writeFile(path.join(__dirname, phase + '.json'), JSON.stringify({ passed: true, checks: ['nested notebook folders', 'live formatting and replace', 'expanded editing', 'shared sticky content', 'remove either view and restore', 'convert sticky', 'board preset and custom dimensions', 'Git settings and titlebar add/commit', 'compact layout', 'final draft on quit'] }, null, 2));
  await evaluate(main, 'window.gtodo.quit()');
})().catch(async error => { await writeFile(path.join(__dirname, phase + '.json'), JSON.stringify({ passed: false, error: String(error), stack: error.stack }, null, 2)); app.exit(1); });
