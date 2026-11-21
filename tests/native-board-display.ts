import { app, BrowserWindow, dialog, session } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

assert.ok(process.env.GTODO_DATA_DIR?.startsWith(path.resolve('.qa') + path.sep), 'Use isolated board test data');
app.getAppPath = () => path.resolve('.');
const permissionHandlers: { check: Parameters<Electron.Session['setPermissionCheckHandler']>[0] } = { check: null };
app.once('ready', () => {
  const current = session.defaultSession;
  const install = current.setPermissionCheckHandler.bind(current);
  current.setPermissionCheckHandler = handler => { permissionHandlers.check = handler; install(handler); };
});
require(path.resolve('dist-electron/main.cjs'));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  for (let i = 0; i < 240; i++) { const value = await read(); if (value) return value as NonNullable<T>; await pause(25); }
  throw new Error(`Timeout: ${label}`);
}

void (async () => {
  await app.whenReady();
  const main = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('index.html')), 'main window');
  main.setTitle('GTodo — 看板显示测试（独立数据）');
  main.setContentSize(1200, 800);
  const evaluate = async <T = any>(code: string): Promise<T> => {
    try { return await main.webContents.executeJavaScript(code, true); }
    catch (error) { throw new Error(`${String(error)} in ${code.slice(0, 280)}`); }
  };
  const click = async (label: string) => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const query = `[...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === ${JSON.stringify(label)} || button.textContent.trim() === ${JSON.stringify(label)})`;
    await until(() => evaluate(`(()=>{const button=${query};const dialog=document.querySelector('dialog[open]');return !!button && !button.disabled && (!dialog || dialog.contains(button));})()`), `enabled button: ${label}`);
    await evaluate(`(${query}).click()`);
  };
  const screenshot = async (name: string) => {
    main.show(); main.focus();
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await writeFile(path.join(__dirname, name), (await main.webContents.capturePage()).toPNG());
  };
  const cardState = () => evaluate('window.gtodo.getState().then(s => s.workspace.boardCards.find(c => c.values.content.kind === "text").values)');
  await until(() => evaluate('!!document.querySelector(".composer")'), 'main rendered');
  await evaluate(`(async () => {
    await window.gtodo.setZoom(100);
    await window.gtodo.command({type:'board.card.add',content:{kind:'text',text:'每天前进一点点'},layout:{x:40,y:40,width:340,height:180}});
    await window.gtodo.command({type:'board.source.add',kind:'task',title:'完成今天最重要的事',content:'',layout:{x:430,y:40,width:290,height:200}});
    document.querySelector('.board-nav').click();
  })()`);
  await until(() => evaluate('!!document.querySelector(".board-kind-text")'), 'board rendered');
  assert.equal(await evaluate('document.querySelector(".board-kind-text .board-card-header")'), null);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".board-kind-text")).borderTopWidth'), '0px');
  assert.equal(await evaluate('!!document.querySelector(".board-kind-task .board-card-header")'), true);

  async function point(selector: string, end = false) {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    return evaluate<{ x: number; y: number }>(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.${end ? 'right' : 'left'} ${end ? '-' : '+'} 12), y:Math.round(r.${end ? 'bottom' : 'top'} ${end ? '-' : '+'} 12)}; })()`);
  }
  async function drag(selector: string, dx: number, dy: number, end = false) {
    const start = await point(selector, end);
    main.focus(); main.webContents.focus();
    main.webContents.sendInputEvent({ type: 'mouseMove', ...start }); await pause(60);
    assert.equal(await evaluate(`!!document.elementFromPoint(${start.x}, ${start.y})?.closest(${JSON.stringify(selector)})`), true, 'Pointer must hit the intended board control');
    main.webContents.sendInputEvent({ type: 'mouseDown', ...start, button: 'left', clickCount: 1 });
    await until(() => evaluate(`document.activeElement?.matches(${JSON.stringify(selector)})`), 'drag control focused');
    main.webContents.sendInputEvent({ type: 'mouseMove', x: start.x + dx, y: start.y + dy, button: 'left', modifiers: ['leftbuttondown'] });
    await until(() => evaluate('!!document.querySelector(".board-kind-text.moving")'), 'drag preview rendered');
    main.webContents.sendInputEvent({ type: 'mouseUp', x: start.x + dx, y: start.y + dy, button: 'left', clickCount: 1 });
  }
  await drag('.board-card-text', 50, 30);
  await until(async () => (await cardState()).layout.x === 90, 'drag text directly');
  assert.equal((await cardState()).layout.y, 70);
  await drag('.board-kind-text .board-resize', 40, 20, true);
  await until(async () => (await cardState()).layout.width === 380, 'resize text without header');
  const textPoint = await point('.board-card-text');
  for (const clickCount of [1, 2]) {
    main.webContents.sendInputEvent({ type: 'mouseDown', ...textPoint, button: 'left', clickCount });
    main.webContents.sendInputEvent({ type: 'mouseUp', ...textPoint, button: 'left', clickCount });
  }
  await until(() => evaluate('!!document.querySelector("dialog[open]")'), 'double click edits text');
  assert.equal(await evaluate('document.querySelectorAll(".board-color-options button").length'), 8);
  await screenshot('colors.png');
  await click('薄荷绿背景'); await click('保存修改');
  await until(async () => (await cardState()).color === '#d3f9d8', 'preset color saved');

  const normalBounds = main.getBounds();
  await click('全屏看板');
  await until(() => evaluate('document.fullscreenElement === document.querySelector(".board-panel")'), 'board fullscreen');
  const fullBounds = await evaluate(`(() => {const r=document.fullscreenElement.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight};})()`);
  assert.equal(fullBounds.x, 0); assert.equal(fullBounds.y, 0);
  assert.equal(fullBounds.width, fullBounds.viewportWidth); assert.equal(fullBounds.height, fullBounds.viewportHeight);
  assert.ok(await evaluate('document.fullscreenElement.contains(document.elementFromPoint(10,10))'), 'App navigation must not cover the fullscreen board');
  await evaluate('[...document.fullscreenElement.querySelectorAll("button")].at(-1).focus()');
  main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' }); main.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  await pause(50);
  assert.equal(await evaluate('document.fullscreenElement.contains(document.activeElement)'), true, 'Tab must stay within the fullscreen board');
  await click('贴纸样式');
  await until(() => evaluate('document.querySelector("dialog[open]")?.contains(document.activeElement)'), 'fullscreen modal focus');
  assert.equal(await evaluate('document.fullscreenElement.contains(document.querySelector("dialog[open]"))'), true);
  await click('浅蓝背景'); await click('保存修改');
  await until(async () => (await cardState()).color === '#dbeafe', 'edit in fullscreen');
  await click('从看板移除');
  await until(() => evaluate('!!document.querySelector(".board-panel > .toast")'), 'fullscreen undo notice');
  await click('撤销'); await until(async () => !(await cardState()).deleted, 'undo in fullscreen');
  await click('退出看板全屏');
  await until(() => evaluate('!document.fullscreenElement'), 'exit fullscreen button');
  await until(() => main.getBounds().width === normalBounds.width && main.getBounds().height === normalBounds.height, 'restore original window');

  // Check picture protocol and that a staged background is only applied on save.
  const bytes = await readFile(path.resolve('assets/icon.png'));
  await evaluate(`window.gtodo.insertBoardImage({destination:'card',name:'测试图片.png',bytes:new Uint8Array(${JSON.stringify([...bytes])}),layout:{x:430,y:290,width:240,height:200}})`);
  await until(() => evaluate('document.querySelector(".board-card-image img")?.naturalWidth > 0'), 'board image protocol');
  const fixture = path.join(__dirname, 'background.png'); await writeFile(fixture, bytes);
  const originalDialog = dialog.showOpenDialog;
  try {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [fixture] })) as typeof dialog.showOpenDialog;
    await click('背景'); await click('选择背景图片');
    await until(() => evaluate('document.querySelector(".board-background-preview img")?.naturalWidth > 0'), 'background preview');
    await click('取消');
    assert.equal(await evaluate('window.gtodo.getState().then(s => s.workspace.boards.length)'), 0);
  } finally { dialog.showOpenDialog = originalDialog; }

  for (const [width, height, zoom] of [[720, 700, 150], [420, 700, 100], [1200, 800, 100]]) {
    main.setContentSize(width, height); await evaluate(`window.gtodo.setZoom(${zoom})`); await pause(100);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true, 'board controls fit narrow windows');
  }
  await click('全屏看板');
  await until(() => evaluate('!!document.fullscreenElement'), 'reenter fullscreen');
  main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  main.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await until(() => evaluate('!document.fullscreenElement'), 'Escape exits fullscreen');
  await click('全屏看板'); await until(() => evaluate('!!document.fullscreenElement'), 'fullscreen task launch');
  await click('打开任务：完成今天最重要的事');
  await until(() => evaluate('!document.fullscreenElement && !!document.querySelector(".details")'), 'open task exits fullscreen');

  await click('关闭任务详情');
  await click('我的看板'); await until(() => evaluate('!!document.querySelector(".board-kind-text")'), 'return to board');
  const saved = await cardState();
  await new Promise<void>(resolve => { main.webContents.once('did-finish-load', () => resolve()); main.webContents.reload(); });
  await until(() => evaluate('!!document.querySelector(".board-nav")'), 'reload main');
  await click('我的看板'); await until(() => evaluate('!!document.querySelector(".board-kind-text")'), 'reload board');
  assert.deepEqual(await cardState(), saved);
  await screenshot('board.png');
  main.maximize(); await until(() => main.isMaximized(), 'maximize before board fullscreen');
  await click('全屏看板'); await until(() => evaluate('!!document.fullscreenElement'), 'fullscreen from maximized window');
  await click('退出看板全屏'); await until(async () => await evaluate('!document.fullscreenElement') && main.isMaximized(), 'restore maximized window');

  const noteId = await evaluate('window.gtodo.createNote({title:"权限检查便签"})');
  const note = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes(`note=${noteId}`)), 'note window');
  await until(() => note.webContents.executeJavaScript('!!document.querySelector(".document-source")'), 'note rendered');
  const checkPermission = permissionHandlers.check;
  assert.ok(checkPermission);
  assert.equal(checkPermission(note.webContents, 'fullscreen', 'gtodo://app', { isMainFrame: true, requestingUrl: note.webContents.getURL() }), false);
  assert.equal(checkPermission(main.webContents, 'fullscreen', 'gtodo://app', { isMainFrame: true, requestingUrl: main.webContents.getURL() }), true);
  assert.equal(checkPermission(main.webContents, 'fullscreen', 'gtodo://app', { isMainFrame: false, requestingUrl: main.webContents.getURL() }), false);
  assert.equal(checkPermission(main.webContents, 'media', 'gtodo://app', { isMainFrame: true, requestingUrl: main.webContents.getURL() }), false);
  await writeFile(path.join(__dirname, 'result.json'), JSON.stringify({ passed: true, fullBounds, checks: ['borderless text', 'pointer drag and resize', 'double click edit', 'eight preset colors', 'board fullscreen and Escape', 'fullscreen editing and undo', 'task navigation exits fullscreen', 'image protocol and background cancel', 'resize and zoom', 'reload preserves layout and color', 'fullscreen permission scope'] }, null, 2));
  app.quit();
})().catch(async error => { await writeFile(path.join(__dirname, 'result.json'), JSON.stringify({ passed: false, error: String(error) })); app.exit(1); });
