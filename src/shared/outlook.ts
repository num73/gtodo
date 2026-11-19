export interface OutlookCalendarOption { id: string; name: string }
export interface OutlookTarget { storeId: string; folderId: string; name: string }
export interface OutlookSyncResult { created: number; updated: number; removed: number; unchanged: number }
export interface OutlookStatus {
  enabled: boolean;
  targetName: string | null;
  phase: 'off' | 'idle' | 'syncing' | 'error';
  lastSyncedAt: string | null;
  result: OutlookSyncResult | null;
  error: string | null;
}
export const emptyOutlookStatus = (): OutlookStatus => ({ enabled: false, targetName: null, phase: 'off', lastSyncedAt: null, result: null, error: null });
