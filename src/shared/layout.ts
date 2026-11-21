import { z } from 'zod';

export const paneLimits = { sidebar: { min: 180, max: 420 }, details: { min: 260, max: 640 } } as const;
export const defaultPaneLayout = { sidebar: 224, details: 322 };
export const paneLayoutSchema = z.object({
  sidebar: z.number().int().min(paneLimits.sidebar.min).max(paneLimits.sidebar.max),
  details: z.number().int().min(paneLimits.details.min).max(paneLimits.details.max),
});
export type PaneLayout = z.infer<typeof paneLayoutSchema>;
export const dividerWidth = 6;
export const minimumTaskWidth = 300;
export function fitPaneLayout(preferred: PaneLayout, width: number, detailsVisible: boolean, sidebarVisible = true): PaneLayout {
  const available = Math.max(0, width - minimumTaskWidth - dividerWidth * (Number(detailsVisible) + Number(sidebarVisible)));
  const sidebar = sidebarVisible ? Math.min(preferred.sidebar, Math.max(paneLimits.sidebar.min, available - (detailsVisible ? paneLimits.details.min : 0))) : preferred.sidebar;
  const details = detailsVisible ? Math.min(preferred.details, Math.max(paneLimits.details.min, available - (sidebarVisible ? sidebar : 0))) : preferred.details;
  return { sidebar, details };
}
