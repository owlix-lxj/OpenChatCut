import type { BrowserWindowConstructorOptions } from 'electron';

type DesktopWindowFrameOptions = Pick<BrowserWindowConstructorOptions, 'frame' | 'titleBarStyle'>;

interface WindowButtonVisibilityHost {
  setWindowButtonVisibility(visible: boolean): void;
}

export function desktopWindowFrameOptions(
  platform: NodeJS.Platform = process.platform,
): DesktopWindowFrameOptions {
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset' };
  if (platform === 'win32') return { frame: false };
  return {};
}

export function applyDesktopWindowFrame(
  win: WindowButtonVisibilityHost,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'darwin') win.setWindowButtonVisibility(false);
}
