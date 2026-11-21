import { app, BrowserWindow, type KeyboardInputEvent } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

assert.ok(process.env.GTODO_DATA_DIR?.startsWith(path.resolve('.qa') + path.sep), 'Only isolated data');
app.getAppPath = () => path.resolve('.'); app.getVersion = () => require(path.resolve('package.json')).version;
require(path.resolve('dist-electron/main.cjs'));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  for (let i = 0; i < 280; i++) { const value = await read(); if (value) return value as NonNullable<T>; await pause(25); }
  throw new Error(`Timeout: ${label}`);
}
const evaluate = <T = any>(window: BrowserWindow, code: string): Promise<T> => window.webContents.executeJavaScript(code);
const source = (window: BrowserWindow) => evaluate<string>(window, 'document.querySelector(".document-source").value');
async function key(window: BrowserWindow, keyCode: string, modifiers: KeyboardInputEvent['modifiers'] = []) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await pause(30);
}
async function click(window: BrowserWindow, selector: string) {
  const point = await evaluate(window, `(()=>{const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'center'});const r=element.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause(60);
}
void (async () => {
  await app.whenReady();
  const main = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('index.html')), 'main');
  main.show(); main.focus(); main.setContentSize(1120, 850);
  const errors: string[] = [];
  main.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  await until(() => evaluate(main, '!!document.querySelector(".composer")'), 'main rendered');
  await evaluate(main, `window.gtodo.command({type:'task.add',title:'实时 Markdown 编辑',listId:'inbox',myDay:new Date().toLocaleDateString('sv-SE')})`);
  const taskId = await evaluate(main, 'window.gtodo.getState().then(s=>s.workspace.tasks[0].id)');
  const imageBytes = [...await readFile(path.resolve('assets/icon.png'))];
  const image = await evaluate(main, `window.gtodo.insertDocumentImage({target:{kind:'task',id:${JSON.stringify(taskId)}},name:'演示图片.png',bytes:new Uint8Array(${JSON.stringify(imageBytes)})})`);
  const initial = `# 实时编辑\n\n这是一段 **加粗**、*斜体* 和 ~~删除线~~。\n\n- [ ] 完成一件小事\n- 普通列表\n\n> 保持专注\n\n| 项目 | 状态 |\n| --- | --- |\n| A | B |\n\n\`\`\`js\nconst answer = 42;\n\`\`\`\n\n![演示图片](${image.path})\n\n[不执行](javascript:alert(1))\n<script>window.markdownExecuted = true</script>\n`;
  await evaluate(main, `window.gtodo.command({type:'task.update',id:${JSON.stringify(taskId)},patch:{notes:${JSON.stringify(initial)}}})`);
  await evaluate(main, 'document.querySelector(".task-body").click()');
  await until(() => evaluate(main, '!!document.querySelector(".cm-content")'), 'live editor');
  await until(() => evaluate(main, '!!document.querySelector(".cm-md-table table")'), 'rendered table');
  assert.equal(await source(main), initial, 'Rendering must not rewrite Markdown');
  assert.equal(await evaluate(main, 'document.querySelector(".cm-md-h1").textContent'), '实时编辑');
  assert.equal(await evaluate(main, 'document.querySelector(".cm-md-strong").textContent'), '加粗');
  assert.equal(await evaluate(main, '!!window.markdownExecuted || !!document.querySelector(".cm-content script") || !!document.querySelector(".cm-content [href^=javascript]")'), false);
  await until(() => evaluate(main, 'document.querySelector(".cm-md-image img")?.naturalWidth > 0'), 'local image');
  await evaluate(main, 'document.querySelector(".note-card").scrollIntoView({block:"start"}); document.querySelector(".cm-scroller").scrollTop=0; new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await writeFile(path.join(__dirname, 'live-task.png'), (await main.webContents.capturePage()).toPNG());

  await evaluate(main, 'document.querySelector(".cm-content").focus()'); await key(main, 'End', ['control']);
  await main.webContents.insertText('\n中文实时输入');
  await until(async () => (await source(main)).endsWith('中文实时输入'), 'typed text');
  await key(main, 'z', ['control']); await until(async () => await source(main) === initial, 'undo');
  await key(main, 'y', ['control']); await until(async () => (await source(main)).endsWith('中文实时输入'), 'redo');
  main.webContents.debugger.attach('1.3');
  await main.webContents.debugger.sendCommand('Input.imeSetComposition', { text: '拼音候选', selectionStart: 4, selectionEnd: 4 });
  await main.webContents.debugger.sendCommand('Input.insertText', { text: '中文输入确认' });
  main.webContents.debugger.detach();
  await until(async () => (await source(main)).endsWith('中文实时输入中文输入确认'), 'IME commit');
  await main.webContents.insertText('格式');
  const beforeBold = await source(main);
  await key(main, 'Left', ['shift']); await key(main, 'Left', ['shift']); await key(main, 'b', ['control']);
  assert.equal(await source(main), beforeBold.slice(0, -2) + '**格式**');
  await key(main, 'z', ['control']); assert.equal(await source(main), beforeBold, 'formatting is independently undoable');
  await key(main, 'End', ['control']);
  await main.webContents.insertText('字'.repeat(100001));
  await until(() => evaluate(main, 'document.querySelector(".document-error")?.textContent.includes("100000")'), 'length limit feedback');
  assert.equal(await source(main), beforeBold, 'oversized paste must leave content intact');
  await evaluate(main, 'document.querySelector("[aria-label=任务名称]").focus()');
  await click(main, '.cm-md-checkbox');
  await until(async () => (await source(main)).includes('- [x] 完成一件小事'), 'checkbox edits source');
  await click(main, '.cm-md-table tr:nth-child(2) td');
  await until(() => evaluate(main, '!!document.querySelector(".cm-md-table-source")'), 'table source editing');
  await key(main, 'Delete'); await main.webContents.insertText('更新');
  await until(async () => (await source(main)).includes('| 更新 | B |'), 'edited table cell');

  const beforeModes = await source(main);
  await evaluate(main, 'document.querySelector("[aria-label=源码编辑备注]").click()');
  await until(() => evaluate(main, 'document.querySelector(".document-editor").dataset.mode === "source"'), 'source mode');
  assert.equal(await source(main), beforeModes);
  await evaluate(main, 'document.querySelector("[aria-label=实时编辑备注]").click()');
  await evaluate(main, 'document.querySelector("[aria-label=预览备注]").click()');
  await until(() => evaluate(main, '!!document.querySelector(".markdown-preview table")'), 'read-only preview');
  await evaluate(main, 'document.querySelector("[aria-label=编辑备注]").click()');
  assert.equal(await source(main), beforeModes);

  await evaluate(main, 'document.querySelector(".cm-content").focus()'); await key(main, 'End', ['control']);
  const beforePaste = await source(main);
  await evaluate(main, `(()=>{const files=new DataTransfer();files.items.add(new File([new Uint8Array(${JSON.stringify(imageBytes)})],'粘贴.png',{type:'image/png'}));document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:files}));})()`);
  await until(async () => (await source(main)).includes('![粘贴.png]'), 'paste image in live editor');
  const afterPaste = await source(main);
  await key(main, 'z', ['control']); assert.equal(await source(main), beforePaste, 'image insertion participates in undo');
  await key(main, 'y', ['control']); assert.equal(await source(main), afterPaste, 'image insertion participates in redo');
  await key(main, 's', ['control']);
  const noteId = await evaluate(main, `window.gtodo.createLinkedNote(${JSON.stringify(taskId)})`);
  const note = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes(`note=${noteId}`)), 'linked note');
  await until(() => evaluate(note, '!!document.querySelector(".cm-content")'), 'live note');
  note.show(); note.focus();
  await evaluate(note, 'document.querySelector(".cm-content").focus()'); await key(note, 'End', ['control']);
  await note.webContents.insertText('\n从便签实时修改'); await key(note, 's', ['control']);
  await until(async () => (await source(main)).endsWith('从便签实时修改'), 'linked update');
  note.setContentSize(600, 760); await evaluate(note, 'document.querySelector(".sticky-title").focus(); document.querySelector(".cm-scroller").scrollTop=0; new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await writeFile(path.join(__dirname, 'live-note.png'), (await note.webContents.capturePage()).toPNG());
  note.setContentSize(280, 320);
  const overflow = await evaluate(note, 'document.documentElement.scrollWidth - innerWidth'); assert.ok(overflow <= 1);
  main.setContentSize(720, 720); await evaluate(main, 'window.gtodo.setZoom(150)');
  assert.ok(await evaluate(main, 'document.documentElement.scrollWidth - innerWidth <= 1'));
  await evaluate(main, 'window.gtodo.setZoom(100)');
  assert.deepEqual(errors, [], 'No renderer errors');
  await evaluate(note, 'document.querySelector(".cm-content").focus()'); await key(note, 'End', ['control']);
  await note.webContents.insertText('退出前最后一个字');
  await writeFile(path.join(__dirname, 'result.json'), JSON.stringify({ passed: true, checks: ['single-pane rendering without source conversion', 'typing and IME', 'formatting, undo and redo', 'length limit preserves source', 'checkboxes and tables', 'local images, paste and undo', 'source and preview', 'linked live edits', 'small windows and zoom', 'final input saved on exit'] }, null, 2));
  await evaluate(main, 'window.gtodo.quit()');
})().catch(async error => { await writeFile(path.join(__dirname, 'result.json'), JSON.stringify({ passed: false, error: String(error), stack: error.stack }, null, 2)); app.exit(1); });
