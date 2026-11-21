import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

assert.ok(process.env.GTODO_DATA_DIR?.startsWith(path.resolve('.qa') + path.sep), 'Use an isolated test profile');
app.getAppPath = () => path.resolve('.');
require(path.resolve('dist-electron/main.cjs'));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  for (let i = 0; i < 240; i++) { const value = await read(); if (value) return value as NonNullable<T>; await pause(25); }
  throw new Error(`Timeout: ${label}`);
}

void (async () => {
  await app.whenReady();
  const main = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('index.html')), 'main window');
  main.setTitle('GTodo — 窗口布局测试（独立数据）');
  const evaluate = <T = any>(code: string): Promise<T> => main.webContents.executeJavaScript(code);
  await until(() => evaluate('!!document.querySelector(".app-body")'), 'main rendered');
  main.show(); main.focus();
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const label = () => evaluate<string>('document.querySelector(".window-buttons button:nth-child(2)")?.getAttribute("aria-label")');
  const clickWindowButton = () => evaluate('document.querySelector(".window-buttons button:nth-child(2)").click()');
  const clickNavigation = async () => {
    // Let focus restoration from closing the previous panel finish first.
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const expanded = await evaluate('document.querySelector(".navigation-toggle").getAttribute("aria-expanded")');
    const zoom = main.webContents.getZoomFactor();
    const point = await evaluate(`(() => {
      const button = document.querySelector('.navigation-toggle'), rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      if (button.getAttribute('aria-disabled') === 'true' || !button.contains(document.elementFromPoint(x, y))) throw Error('Navigation toggle is not reachable');
      return {x: Math.round(x * ${zoom}), y: Math.round(y * ${zoom})};
    })()`);
    main.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    main.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await until(() => evaluate(`document.querySelector('.navigation-toggle').getAttribute('aria-disabled') !== 'true' && document.querySelector('.navigation-toggle').getAttribute('aria-expanded') !== '${expanded}'`), 'navigation toggled');
    if (await evaluate('document.querySelector(".app-shell").dataset.navigation !== "drawer"')) {
      assert.equal(await evaluate('document.activeElement === document.querySelector(".navigation-toggle")'), true, 'Wide toggle retains keyboard focus: ' + await evaluate('document.activeElement?.outerHTML.slice(0, 400)'));
    }
  };
  const reports: unknown[] = [];
  async function measure(width: number, zoom = 100, sidebarVisible = true) {
    main.setContentSize(width, 700);
    await evaluate(`window.gtodo.setZoom(${zoom})`);
    const expectedWidth = Math.round(width * 100 / zoom);
    // Windows may round the client width down by one CSS pixel at the active
    // display DPI. Calibrate the requested size so the exact boundary is tested.
    await until(() => evaluate(`Math.abs(innerWidth - ${expectedWidth}) <= 1`), 'window resize');
    const actualWidth = await evaluate<number>('innerWidth');
    if (actualWidth !== expectedWidth) main.setContentSize(width + Math.round((expectedWidth - actualWidth) * zoom / 100), 700);
    const mode = expectedWidth >= 486 ? sidebarVisible ? 'sidebar' : 'hidden' : 'drawer';
    try {
      await until(() => evaluate(`Math.abs(innerWidth - ${expectedWidth}) <= 1 && document.querySelector('.app-shell').dataset.navigation === '${mode}' && ('${mode}' === 'drawer' || document.querySelector('.main-panel').getBoundingClientRect().width >= 299)`), `layout ${width} at ${zoom}%`);
    } catch (error) {
      throw new Error(`${error}; actual ${JSON.stringify(await evaluate(`({innerWidth, body:document.querySelector('.app-body').getBoundingClientRect().width, main:document.querySelector('.main-panel').getBoundingClientRect().width, sidebar:document.querySelector('.sidebar').getBoundingClientRect().width, mode:document.querySelector('.app-shell').dataset.navigation})`))}`);
    }
    const report = await evaluate(`(() => {
      const nav = document.querySelector('.sidebar'), main = document.querySelector('.main-panel');
      const navRect = nav.getBoundingClientRect(), mainRect = main.getBoundingClientRect();
      return {width: innerWidth, zoom: ${zoom}, mode: document.querySelector('.app-shell').dataset.navigation,
        visibility: getComputedStyle(nav).visibility, display: getComputedStyle(nav).display, inert: nav.inert, sidebarWidth: navRect.width,
        sidebarRight: navRect.right, mainLeft: mainRect.left, mainWidth: mainRect.width,
        toggleDisplay: getComputedStyle(document.querySelector('.navigation-toggle')).display,
        toggleExpanded: document.querySelector('.navigation-toggle').getAttribute('aria-expanded'),
        horizontalOverflow: document.documentElement.scrollWidth - innerWidth};
    })()`);
    assert.ok(report.horizontalOverflow <= 1, 'Layout must stay within the viewport');
    assert.notEqual(report.toggleDisplay, 'none', 'Navigation must be available at every width');
    assert.equal(report.toggleExpanded, mode === 'sidebar' ? 'true' : 'false');
    if (mode === 'sidebar') {
      assert.equal(report.visibility, 'visible'); assert.equal(report.inert, false);
      assert.ok(report.sidebarWidth >= 180 && report.mainWidth >= 299, JSON.stringify(report));
      assert.ok(report.mainLeft >= report.sidebarRight);
    } else if (mode === 'hidden') {
      assert.equal(report.display, 'none'); assert.equal(report.inert, true);
      assert.equal(report.mainLeft, 0); assert.equal(report.sidebarWidth, 0);
      assert.equal(await evaluate('!!document.querySelector("[aria-label=调整清单栏宽度]")'), false);
    } else {
      assert.equal(report.visibility, 'hidden'); assert.equal(report.inert, true);
    }
    reports.push(report);
    return report;
  }

  await measure(640);
  await writeFile(path.join(__dirname, 'sidebar-640.png'), (await main.webContents.capturePage()).toPNG());
  await measure(500);
  await measure(486);
  await measure(485);
  await measure(420);
  await clickNavigation();
  await until(() => evaluate('!document.querySelector(".sidebar").inert && getComputedStyle(document.querySelector(".sidebar")).visibility === "visible"'), 'open navigation drawer');
  await clickNavigation();
  await until(() => evaluate('document.querySelector(".sidebar").inert'), 'close navigation drawer');
  await measure(640);
  await measure(960, 150);
  await measure(720, 200);
  await measure(720);

  main.show(); main.focus();
  await evaluate('window.gtodo.setPaneLayout({sidebar:400,details:600})');
  await measure(1280);
  await evaluate('window.gtodo.command({type:"task.add",title:"隐藏导航时保留编辑",listId:"inbox"})');
  await evaluate('document.querySelector(".smart-nav button:nth-child(4)").click()');
  await until(() => evaluate('!!document.querySelector(".task-body")'), 'test task');
  await evaluate('document.querySelector(".task-body").click()');
  await until(() => evaluate('!!document.querySelector(".cm-content")'), 'live task editor');
  await evaluate('window.navigationEditor = document.querySelector(".cm-content"); window.navigationEditor.focus()');
  await main.webContents.insertText('## 隐藏侧栏\n\n这段编辑应保留。');
  const shown = await measure(1280);
  await clickNavigation();
  const hidden = await measure(1280, 100, false);
  assert.ok(hidden.mainWidth > shown.mainWidth + 100, 'Task area receives the released space');
  assert.equal(await evaluate('document.querySelector(".cm-content") === window.navigationEditor'), true, 'Editor is not remounted');
  assert.equal(await evaluate('document.querySelector(".document-source").value'), '## 隐藏侧栏\n\n这段编辑应保留。');
  assert.equal(await evaluate('document.querySelector("[aria-label=调整任务详情宽度]").getAttribute("aria-valuenow")'), '600');
  await writeFile(path.join(__dirname, 'sidebar-hidden.png'), (await main.webContents.capturePage()).toPNG());
  await clickNavigation();
  await measure(1280);
  assert.equal(await evaluate('document.querySelector(".cm-content") === window.navigationEditor'), true);
  assert.equal(await evaluate('document.querySelector(".sidebar").getBoundingClientRect().width'), 400);
  await evaluate('document.querySelector("[aria-label=关闭任务详情]").click()');
  await until(() => evaluate('!document.querySelector("#task-details")'), 'close saved task');
  await clickNavigation();
  await measure(1280, 100, false);
  for (const mode of ['sidebar', 'hidden']) {
    main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    main.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    main.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await until(() => evaluate(`document.querySelector('.app-shell').dataset.navigation === '${mode}' && document.querySelector('.navigation-toggle').getAttribute('aria-disabled') !== 'true'`), 'consecutive keyboard toggles');
    assert.equal(await evaluate('document.activeElement === document.querySelector(".navigation-toggle")'), true);
  }
  await new Promise<void>(resolve => { main.webContents.once('did-finish-load', () => resolve()); main.webContents.reload(); });
  await until(() => evaluate('document.querySelector(".app-shell")?.dataset.navigation === "hidden"'), 'hidden preference after reload');
  await measure(960, 150, false);
  await measure(720, 200, false);
  await clickNavigation();
  await until(() => evaluate('document.querySelector(".navigation-toggle").getAttribute("aria-expanded") === "true"'), 'drawer with hidden preference');
  await clickNavigation();
  await measure(1280, 100, false);
  assert.equal((await evaluate('window.gtodo.getState()')).preferences.sidebarVisible, false);
  main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'k', modifiers: ['control'] });
  main.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'k', modifiers: ['control'] });
  await until(() => evaluate('document.activeElement?.getAttribute("aria-label") === "搜索任务"'), 'search reveals hidden navigation');
  await measure(1280);
  assert.equal((await evaluate('window.gtodo.getState()')).workspace.tasks[0].values.notes, '## 隐藏侧栏\n\n这段编辑应保留。');

  assert.equal(await label(), '最大化');
  await clickWindowButton();
  await until(async () => main.isMaximized() && await label() === '还原窗口', 'maximize button state');
  assert.equal(await evaluate('!!document.querySelector(".window-buttons .lucide-copy")'), true);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".sidebar")).visibility'), 'visible');
  await writeFile(path.join(__dirname, 'maximized.png'), (await main.webContents.capturePage()).toPNG());
  await clickWindowButton();
  await until(async () => !main.isMaximized() && await label() === '最大化', 'restore button state');
  // Native changes also cover title-bar double click and Windows window actions.
  main.maximize();
  await until(async () => await label() === '还原窗口', 'native maximize notification');
  await new Promise<void>(resolve => { main.webContents.once('did-finish-load', () => resolve()); main.webContents.reload(); });
  await until(async () => await label() === '还原窗口', 'initial state after renderer reload');
  main.unmaximize();
  await until(async () => await label() === '最大化', 'native restore notification');
  main.setFullScreen(true);
  await until(async () => main.isFullScreen() && await label() === '退出全屏', 'full-screen notification');
  await clickWindowButton();
  await until(async () => !main.isFullScreen() && await label() === '最大化', 'exit full screen');
  await writeFile(path.join(__dirname, 'result.json'), JSON.stringify({ passed: true, reports, checks: ['native maximize and restore', 'initial maximized state', 'full-screen exit', 'navigation sizing and zoom', 'closed drawer returns on expansion', 'manual hide releases width and preserves live editor', 'hidden preference survives resize, zoom and reload', 'search restores navigation'] }, null, 2));
  app.quit();
})().catch(async error => { await writeFile(path.join(__dirname, 'result.json'), JSON.stringify({ passed: false, error: String(error) })); app.exit(1); });
