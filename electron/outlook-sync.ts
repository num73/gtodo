import { createHash } from 'node:crypto';
import type { Workspace } from '../src/shared/model';
import { emptyOutlookStatus, type OutlookCalendarOption, type OutlookStatus } from '../src/shared/outlook';
import type { PreferencesStore } from './preferences';
import type { OutlookBridge, OutlookParent } from './outlook-bridge';
import { outlookEvents } from './outlook-events';

export class OutlookSync {
  private status = emptyOutlookStatus();
  private parents = new Map<string, OutlookParent>();
  private timer?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private queue: Promise<unknown> = Promise.resolve();
  private controller?: AbortController;
  private stopped = false;
  private pending = false;
  private needsSync = false;
  private workspaceSignature = '';
  constructor(private preferences: PreferencesStore, private workspace: () => Workspace,
    private bridge: OutlookBridge, private publish: () => void) {}
  snapshot(): OutlookStatus {
    const config = this.preferences.value.outlook;
    return { ...this.status, enabled: config.enabled, targetName: config.target?.name ?? null,
      phase: config.enabled ? this.status.phase === 'off' ? 'idle' : this.status.phase : 'off' };
  }
  start() {
    this.interval = setInterval(() => this.schedule(), 60000); this.interval.unref(); this.workspaceChanged();
  }
  workspaceChanged() {
    if (this.stopped || !this.preferences.value.outlook.enabled) return;
    const workspace = this.workspace();
    const signature = createHash('sha256').update(JSON.stringify([workspace.tasks, workspace.steps, workspace.lists])).digest('hex');
    if (signature === this.workspaceSignature) return;
    this.workspaceSignature = signature; this.schedule();
  }
  schedule() {
    if (this.stopped || !this.preferences.value.outlook.enabled || this.timer) return;
    if (this.pending) { this.needsSync = true; return; }
    this.timer = setTimeout(() => { this.timer = undefined; void this.sync(); }, 1500); this.timer.unref();
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(() => { if (this.stopped) throw new Error('应用正在退出。'); return action(); });
    this.queue = operation.catch(() => {}); return operation;
  }
  list(): Promise<OutlookCalendarOption[]> {
    return this.serialize(async () => {
      this.controller = new AbortController();
      try {
        const parents = await this.bridge.list(this.controller.signal);
        this.parents = new Map(parents.map(parent => [createHash('sha256').update(`${parent.storeId}:${parent.folderId}`).digest('hex'), parent]));
        return [...this.parents].map(([id, parent]) => ({ id, name: parent.name }));
      } finally { this.controller = undefined; }
    });
  }
  configure(enabled: boolean, calendarId?: string): Promise<void> {
    if (!enabled) { this.controller?.abort(); if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
    return this.serialize(async () => {
      let target = this.preferences.value.outlook.target;
      if (enabled && calendarId) {
        if (this.preferences.value.outlook.enabled) throw new Error('请先停止同步，再更换日历。');
        const parent = this.parents.get(calendarId); if (!parent) throw new Error('请重新读取 Outlook 日历并选择账户。');
        this.controller = new AbortController();
        try { target = await this.bridge.connect(parent, this.controller.signal); } finally { this.controller = undefined; }
      }
      if (enabled && !target) throw new Error('请先选择 Outlook 日历。');
      await this.preferences.update(value => { value.outlook = { enabled, target }; });
      this.status = { ...emptyOutlookStatus(), phase: enabled ? 'idle' : 'off' }; this.publish();
      if (enabled) { this.workspaceSignature = ''; this.workspaceChanged(); }
    });
  }
  sync(): Promise<void> {
    if (this.pending || this.stopped) return this.queue.then(() => {});
    this.pending = true;
    return this.serialize(async () => {
      const config = this.preferences.value.outlook;
      if (!config.enabled || !config.target) return;
      this.status.phase = 'syncing'; this.status.error = null; this.publish();
      this.controller = new AbortController();
      try {
        const events = outlookEvents(this.workspace());
        const result = await this.bridge.sync(config.target, events, this.controller.signal);
        this.status = { ...this.status, phase: 'idle', lastSyncedAt: new Date().toISOString(), result, error: null };
      } catch (error) {
        this.status.phase = 'error'; this.status.error = error instanceof Error ? error.message : 'Outlook 同步失败。';
      } finally { this.controller = undefined; if (!this.stopped) this.publish(); }
    }).catch(error => { if (!this.stopped) throw error; }).finally(() => {
      this.pending = false;
      if (this.needsSync) { this.needsSync = false; this.schedule(); }
    });
  }
  stop() {
    this.stopped = true; this.controller?.abort();
    if (this.timer) clearTimeout(this.timer); if (this.interval) clearInterval(this.interval);
  }
}
