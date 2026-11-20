import type { AppDetailsOptions } from 'electron';
import path from 'node:path';

// Keep this ID identical to build.appId and stable across application versions.
export const APP_USER_MODEL_ID = 'app.gtodo.desktop';

export function taskbarDetails(options: {
  platform: NodeJS.Platform;
  packaged: boolean;
  executable: string;
  portableExecutable?: string;
}): AppDetailsOptions | null {
  if (options.platform !== 'win32' || !options.packaged) return null;
  // electron-builder provides the outer launcher path. process.execPath points
  // into a disposable extraction directory in a single-file portable build.
  const portable = options.portableExecutable;
  const executable = portable && path.win32.isAbsolute(portable) && /\.exe$/i.test(portable) && !/["\r\n\0]/.test(portable)
    ? portable : options.executable;
  return {
    appId: APP_USER_MODEL_ID,
    appIconPath: executable,
    appIconIndex: 0,
    relaunchCommand: `"${executable}"`,
    relaunchDisplayName: 'GTodo',
  };
}
