import type { EventEmitter } from 'node:events';
import { allowedPublishNavigation, socialPlatform, type SocialPlatform } from '../shared/social-publish.ts';

interface NavigationEvents {
  on: EventEmitter['on'];
  removeListener: EventEmitter['removeListener'];
}
export interface PublishNavigationWindow extends NavigationEvents {
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  webContents: NavigationEvents & {
    getURL(): string;
    isLoadingMainFrame(): boolean;
    stop(): void;
  };
}

function isAborted(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; errno?: unknown; message?: unknown };
  return e.code === 'ERR_ABORTED' || e.errno === -3
    || (typeof e.message === 'string' && /^ERR_ABORTED \(-3\)(?:\s|$)/.test(e.message));
}

/** A client-side login redirect can reject loadURL while its replacement is loading.
 * An abort alone is never success: require a DOM-ready or finished allowlisted main document.
 * Creator SPAs may keep third-party resources loading after the upload form is usable;
 * do not stop that document at the initial navigation timeout once DOM-ready has fired.
 * No retry, widening of navigation permissions, or remote page scripting here.
 */
export function loadPublishCreator(
  platform: SocialPlatform,
  win: PublishNavigationWindow,
  timeoutMs = 45_000,
): Promise<void> {
  if (win.isDestroyed()) return Promise.reject(new Error('平台窗口已关闭，请重新打开'));
  return new Promise<void>((resolve, reject) => {
    const wc = win.webContents;
    let settled = false;
    let aborted = false;
    const cleanup = () => {
      clearTimeout(timer);
      wc.removeListener('did-finish-load', finished);
      wc.removeListener('dom-ready', domReady);
      wc.removeListener('did-fail-load', failed);
      wc.removeListener('render-process-gone', crashed);
      win.removeListener('closed', closed);
    };
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve();
    };
    const closed = () => settle(new Error('平台窗口已关闭，请重新打开'));
    const crashed = () => settle(new Error('平台页面进程已退出，请重新打开'));
    const domReady = () => {
      if (settled) return;
      if (win.isDestroyed()) return closed();
      if (!allowedPublishNavigation(platform, wc.getURL())) {
        settle(new Error('平台跳转到了未授权的地址，已停止加载'));
        return;
      }
      // This only accepts the document. The video adapter separately waits for its upload form.
      settle();
    };
    const finished = () => {
      if (settled) return;
      if (win.isDestroyed()) return closed();
      if (wc.isLoadingMainFrame()) return;
      if (!allowedPublishNavigation(platform, wc.getURL())) {
        settle(new Error('平台跳转到了未授权的地址，已停止加载'));
        return;
      }
      settle();
    };
    const failed = (_event: unknown, code: number, _description: string, _url: string, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      if (code === -3) { aborted = true; return; }
      settle(new Error(`平台页面加载失败（${code}），请检查网络后重试`));
    };
    const timer = setTimeout(() => {
      settle(new Error(aborted
        ? '平台登录跳转未完成，请重新打开登录窗口；如果仍然失败，请检查网络'
        : '平台页面加载超时，请检查网络后重试'));
      // Settle first so stop() cannot replace the useful error with ERR_ABORTED.
      if (!win.isDestroyed()) wc.stop();
    }, timeoutMs);
    wc.on('did-finish-load', finished);
    wc.on('dom-ready', domReady);
    wc.on('did-fail-load', failed);
    wc.on('render-process-gone', crashed);
    win.on('closed', closed);
    try {
      void win.loadURL(socialPlatform(platform).url).then(finished, error => {
        if (settled) return;
        if (win.isDestroyed()) return closed();
        if (isAborted(error)) { aborted = true; return; }
        settle(new Error('无法加载平台页面，请检查网络后重新打开'));
      });
    } catch {
      settle(new Error('无法打开平台窗口，请重新尝试'));
    }
  });
}
