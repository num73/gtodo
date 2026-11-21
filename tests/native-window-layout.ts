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
  const label = () => evaluate<string>('document.querySelector(".window-buttons button:nth-child(2)")?.getAttribute("aria-label")');
  const clickWindowButton = () => evaluate('document.querySelector(".window-buttons button:nth-child(2)").click()');
  const reports: unknown[] = [];
  async function measure(width: number, zoom = 100) {
    main.setContentSize(width, 700);
    await evaluate(`window.gtodo.setZoom(${zoom})`);
    const expectedWidth = Math.round(width * 100 / zoom);
    // Windows may round the client width down by one CSS pixel at the active
    // display DPI. Calibrate the requested size so the exact boundary is tested.
    await until(() => evaluate(`Math.abs(innerWidth - ${expectedWidth}) <= 1`), 'window resize');
    const actualWidth = await evaluate<number>('innerWidth');
    if (actualWidth !== expectedWidth) main.setContentSize(width + Math.round((expectedWidth - actualWidth) * zoom / 100), 700);
    const mode = expectedWidth >= 486 ? 'sidebar' : 'drawer';
    try {
      await until(() => evaluate(`Math.abs(innerWidth - ${expectedWidth}) <= 1 && document.querySelector('.app-shell').dataset.navigation === '${mode}' && ('${mode}' === 'drawer' || document.querySelector('.main-panel').getBoundingClientRect().width >= 299)`), `layout ${width} at ${zoom}%`);
    } catch (error) {
      throw new Error(`${error}; actual ${JSON.stringify(await evaluate(`({innerWidth, body:document.querySelector('.app-body').getBoundingClientRect().width, main:document.querySelector('.main-panel').getBoundingClientRect().width, sidebar:document.querySelector('.sidebar').getBoundingClientRect().width, mode:document.querySelector('.app-shell').dataset.navigation})`))}`);
    }
    const report = await evaluate(`(() => {
      const nav = document.querySelector('.sidebar'), main = document.querySelector('.main-panel');
      const navRect = nav.getBoundingClientRect(), mainRect = main.getBoundingClientRect();
      return {width: innerWidth, zoom: ${zoom}, mode: document.querySelector('.app-shell').dataset.navigation,
        visibility: getComputedStyle(nav).visibility, inert: nav.inert, sidebarWidth: navRect.width,
        sidebarRight: navRect.right, mainLeft: mainRect.left, mainWidth: mainRect.width,
        toggleDisplay: getComputedStyle(document.querySelector('.mobile-nav-toggle')).display,
        horizontalOverflow: document.documentElement.scrollWidth - innerWidth};
    })()`);
    assert.ok(report.horizontalOverflow <= 1, 'Layout must stay within the viewport');
    if (mode === 'sidebar') {
      assert.equal(report.visibility, 'visible'); assert.equal(report.inert, false);
      assert.ok(report.sidebarWidth >= 180 && report.mainWidth >= 299, JSON.stringify(report));
      assert.ok(report.mainLeft >= report.sidebarRight);
      assert.equal(report.toggleDisplay, 'none');
    } else {
      assert.equal(report.visibility, 'hidden'); assert.equal(report.inert, true);
      assert.notEqual(report.toggleDisplay, 'none');
    }
    reports.push(report);
  }

  await measure(640);
  await writeFile(path.join(__dirname, 'sidebar-640.png'), (await main.webContents.capturePage()).toPNG());
  await measure(500);
  await measure(486);
  await measure(485);
  await measure(420);
  await evaluate('document.querySelector(".mobile-nav-toggle").click()');
  await until(() => evaluate('!document.querySelector(".sidebar").inert && getComputedStyle(document.querySelector(".sidebar")).visibility === "visible"'), 'open navigation drawer');
  await evaluate('document.querySelector(".mobile-nav-toggle").click()');
  await until(() => evaluate('document.querySelector(".sidebar").inert'), 'close navigation drawer');
  await measure(640);
  await measure(960, 150);
  await measure(720, 200);
  await measure(720);

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
  await writeFile(path.join(__dirname, 'result.json'), JSON.stringify({ passed: true, reports, checks: ['native maximize and restore', 'initial maximized state', 'full-screen exit', 'navigation sizing and zoom', 'closed drawer returns on expansion'] }, null, 2));
  app.quit();
})().catch(async error => { await writeFile(path.join(__dirname, 'result.json'), JSON.stringify({ passed: false, error: String(error) })); app.exit(1); });
