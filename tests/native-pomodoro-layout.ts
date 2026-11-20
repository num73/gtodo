import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

// Run the real built application with an isolated profile supplied by the runner.
assert.ok(process.env.GTODO_DATA_DIR?.startsWith(path.resolve('.qa') + path.sep));
// The test entry lives in .qa; resolve application resources from the repository.
app.getAppPath = () => path.resolve('.');
require(path.resolve('dist-electron/main.cjs'));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor<T>(read: () => Promise<T> | T, label: string): Promise<NonNullable<T>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read(); if (value) return value;
    await pause(25);
  }
  throw new Error(`Timed out: ${label}`);
}

void (async () => {
  await app.whenReady();
  const main = await waitFor(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('index.html') && !window.webContents.getURL().includes('window=')), 'main window');
  await waitFor(() => main.webContents.executeJavaScript('!!document.querySelector(".sidebar")'), 'main rendered');
  await main.webContents.executeJavaScript('window.gtodo.openPomodoro()');
  main.hide();
  const timer = await waitFor(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('window=pomodoro')), 'timer window');
  const evaluate = <T = any>(code: string): Promise<T> => timer.webContents.executeJavaScript(code);
  await waitFor(() => evaluate('!!document.querySelector(".pomodoro-time")'), 'timer rendered');
  await evaluate('window.gtodo.pomodoroCommand({type:"configure",settings:{focusMinutes:180,shortBreakMinutes:5,longBreakMinutes:15,longBreakEvery:4}})');
  await waitFor(() => evaluate('document.querySelector(".pomodoro-time").textContent === "180:00"'), 'longest countdown');

  const reports: any[] = [];
  async function measure(width: number, height: number, settings = false) {
    timer.setSize(width, height);
    await pause(100);
    const report = await evaluate(`(() => {
      const content = document.querySelector('.pomodoro-content');
      const selectors = ['.pomodoro-modes', '.pomodoro-time', '.pomodoro-controls', '.pomodoro-task', '.pomodoro-stats', '.pomodoro-settings-toggle'];
      return {
        width: innerWidth, height: innerHeight,
        timeFont: parseFloat(getComputedStyle(document.querySelector('.pomodoro-time')).fontSize),
        controlFont: parseFloat(getComputedStyle(document.querySelector('.pomodoro-controls .primary')).fontSize),
        horizontalOverflow: Math.max(document.documentElement.scrollWidth - innerWidth, content.scrollWidth - content.clientWidth),
        verticalOverflow: content.scrollHeight - content.clientHeight,
        elements: selectors.map(selector => {
          const element = document.querySelector(selector), rect = element.getBoundingClientRect();
          return {selector, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, overflow: element.scrollWidth - element.clientWidth};
        })
      };
    })()`);
    assert.ok(report.horizontalOverflow <= 1, `${width}x${height}: horizontal overflow`);
    for (const element of report.elements) {
      assert.ok(element.width > 0 && element.height > 0, `${element.selector} has no visible area`);
      assert.ok(element.x >= 0 && element.right <= report.width + 1, `${width}x${height}: ${element.selector} outside window`);
      if (!settings) assert.ok(element.y >= 34 && element.bottom <= report.height + 1, `${width}x${height}: ${element.selector} needs scrolling`);
      if (element.selector === '.pomodoro-time') assert.ok(element.overflow <= 1, `${width}x${height}: countdown clipped`);
    }
    if (!settings) assert.ok(report.verticalOverflow <= 1, `${width}x${height}: collapsed panel needs scrolling`);
    reports.push({requested: [width, height], settings, ...report});
    return report;
  }
  const normal = await measure(360, 530);
  const large = await measure(720, 900);
  assert.ok(large.timeFont > normal.timeFont * 1.4, 'Countdown should grow with the window');
  assert.ok(large.controlFont > normal.controlFont, 'Controls should grow with the window');
  const narrow = await measure(300, 530);
  const wider = await measure(420, 530);
  assert.ok(wider.timeFont > narrow.timeFont, 'Width-only resize should grow countdown');
  const short = await measure(360, 400);
  const taller = await measure(360, 700);
  assert.ok(taller.timeFont > short.timeFont, 'Height-only resize should grow countdown');
  for (const [width, height] of [[280, 320], [800, 320], [900, 600], [280, 850], [1280, 900]]) await measure(width, height);

  // A live session must survive changing layout, including the wide/portrait breakpoint.
  await evaluate('window.gtodo.pomodoroCommand({type:"start"})');
  const started = await evaluate('window.gtodo.getPomodoro()');
  await measure(800, 360);
  await measure(280, 320);
  const resized = await evaluate('window.gtodo.getPomodoro()');
  assert.equal(resized.session.status, 'running');
  assert.deepEqual(resized.session, started.session);
  await evaluate('window.gtodo.pomodoroCommand({type:"pause"})');
  await evaluate('window.gtodo.pomodoroCommand({type:"reset"})');

  await evaluate('document.querySelector(".pomodoro-settings-toggle").click()');
  await waitFor(() => evaluate('!!document.querySelector(".pomodoro-settings")'), 'settings open');
  await evaluate(`(() => {
    const input = document.querySelector('[aria-label="专注分钟数"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '45');
    input.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  for (const [width, height] of [[280, 320], [900, 600], [360, 530]]) {
    await measure(width, height, true);
    assert.equal(await evaluate('document.querySelector("[aria-label=专注分钟数]").value'), '45', 'Resize lost the settings draft');
  }
  await measure(280, 320, true);
  await evaluate('document.querySelector(".pomodoro-settings button").scrollIntoView({block:"end"})');
  await pause(50);
  const saveBounds = await evaluate(`(() => {const r = document.querySelector('.pomodoro-settings button').getBoundingClientRect(); return {top: r.top, bottom: r.bottom, height: innerHeight};})()`);
  assert.ok(saveBounds.top >= 33 && saveBounds.bottom <= saveBounds.height + 1, `Settings save button should remain reachable: ${JSON.stringify(saveBounds)}`);
  await evaluate('document.querySelector(".pomodoro-settings").requestSubmit()');
  await waitFor(() => evaluate('document.querySelector(".pomodoro-time").textContent === "45:00"'), 'settings saved after resize');
  await writeFile(path.join(__dirname, 'result.json'), JSON.stringify({passed: true, reports}, null, 2));
  console.log('Pomodoro layout scales, stays usable at minimum size and preserves live timing/settings across resizes.');
})().then(() => app.quit()).catch(async error => {
  console.error(error);
  await writeFile(path.join(__dirname, 'result.json'), JSON.stringify({passed: false, error: String(error)}));
  app.exit(1);
});
