import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { BrowserWindow, session, type Cookie, type Session } from 'electron';
import { WebSocket } from 'ws';
import { SOCIAL_PLATFORMS, allowedPublishNavigation, type SocialPlatform } from '../shared/social-publish.ts';
import { loadPublishCreator } from './social-publish-navigation.ts';

type HeaderRule = { id: number; condition: { urlFilter: string }; action: { requestHeaders?: { header: string; operation: string; value: string }[] } };
const silentEvent = () => ({ addListener() {}, removeListener() {} });

/** Runs the pinned GEO plugin inside the app. Only local trusted bundle code enters this VM.
 * Remote creator pages stay sandboxed and never receive a Node preload or the pairing token.
 */
export async function startEmbeddedGeo(options: { bridgeUrl: string; token: string; userData: string }): Promise<{ close(): void }> {
  const windows = new Map<number, { window: BrowserWindow; platform: SocialPlatform; documentReady: boolean; error?: string }>();
  const detachListeners = new Set<(target: { tabId: number }) => void>();
  const rules = new Map<number, HeaderRule>();
  const timeouts = new Set<ReturnType<typeof setTimeout>>();
  const intervals = new Set<ReturnType<typeof setInterval>>();
  const sockets = new Set<WebSocket>();
  let disposed = false;
  const storePath = join(options.userData, 'geo-runtime-store.json');
  let stored: Record<string, unknown> = {};
  try {
    const raw = await readFile(storePath, 'utf8');
    if (raw.length > 4 * 1024 * 1024) throw new Error('GEO 本机记录过大');
    stored = JSON.parse(raw);
    if (!stored || Array.isArray(stored) || typeof stored !== 'object') throw new Error('GEO 本机记录损坏');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('GEO 本机记录读取失败，原文件已保留'); }
  const volatile: Record<string, unknown> = {};
  const pairing = { mcpEnabled: true, mcpToken: options.token, mcpServerUrl: options.bridgeUrl };
  let writes: Promise<void> = Promise.resolve();
  const storage = (record: Record<string, unknown>, persistent: boolean) => ({
    async get(keys: string | string[] | Record<string, unknown> | null) {
      const values = persistent ? { ...record, ...pairing } : record;
      const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? values);
      return Object.fromEntries(names.map(key => [key, values[key] ?? (keys && typeof keys === 'object' && !Array.isArray(keys) ? keys[key] : undefined)]));
    },
    async set(values: Record<string, unknown>) {
      if (disposed) throw new Error('内置插件已停止');
      for (const [key, value] of Object.entries(values)) if (!Object.hasOwn(pairing, key) && !['__proto__', 'constructor', 'prototype'].includes(key)) record[key] = value;
      if (!persistent) return;
      const raw = JSON.stringify(record);
      const next = writes.then(async () => {
        await mkdir(dirname(storePath), { recursive: true });
        await writeFile(`${storePath}.tmp`, raw, { mode: 0o600 });
        await rename(`${storePath}.tmp`, storePath);
      });
      writes = next.catch(() => undefined);
      await next;
    },
    async remove(keys: string | string[]) {
      for (const key of typeof keys === 'string' ? [keys] : keys) delete record[key];
      if (persistent) await localStore.set({});
    },
  });
  const localStore = storage(stored, true);
  const sessions = new Map<SocialPlatform, Session>();
  function platformSession(id: SocialPlatform) {
    let profile = sessions.get(id);
    if (!profile) {
      // Reuse the user's existing AI-cut account sessions, without exporting/copying any cookies.
      profile = session.fromPartition(`persist:aicut-publisher-${id}`);
      profile.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      profile.setPermissionCheckHandler(() => false);
      sessions.set(id, profile);
    }
    return profile;
  }
  function owned(id: number) {
    if (disposed) throw new Error('内置插件已停止');
    const row = windows.get(id);
    if (!row || row.window.isDestroyed()) throw new Error('平台窗口已关闭');
    return row;
  }
  function inspectTab(id: number) {
    const row = owned(id);
    if (row.error) throw new Error(row.error);
    // Creator pages may keep analytics/media resources pending after the form is usable.
    // The adapter checks form readiness separately; resource loading is not document readiness.
    return { id, url: row.window.webContents.getURL(), status: row.documentReady ? 'complete' : 'loading' };
  }
  const chrome = {
    runtime: { id: 'aicut-internal-geo', getURL: (path: string) => `aicut-geo://bundled/${path}`,
      getManifest: () => ({ version: '2.0.9' }), onMessage: silentEvent(), onStartup: silentEvent(), onInstalled: silentEvent(), sendMessage: async () => undefined },
    storage: { local: localStore, session: storage(volatile, false) },
    contextMenus: { onClicked: silentEvent() },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    cookies: { async getAll(filter: { domain: string; name?: string }): Promise<Cookie[]> {
      const id = filter.domain === '.douyin.com' ? 'douyin' : filter.domain === '.xiaohongshu.com' ? 'xiaohongshu' : null;
      if (!id) throw new Error('内置 GEO 不读取此域名的登录信息');
      return platformSession(id).cookies.get(filter);
    } },
    declarativeNetRequest: {
      RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' }, HeaderOperation: { SET: 'set' },
      getDynamicRules: async () => [...rules.values()],
      updateDynamicRules: async (value: { addRules?: HeaderRule[]; removeRuleIds?: number[] }) => {
        for (const id of value.removeRuleIds ?? []) rules.delete(id);
        for (const rule of value.addRules ?? []) { if (rules.size >= 100) throw new Error('请求规则过多'); rules.set(rule.id, rule); }
      },
    },
    tabs: {
      onUpdated: silentEvent(),
      async create(value: { url: string; active: boolean }) {
        if (disposed) throw new Error('内置插件已停止');
        const platform = SOCIAL_PLATFORMS.find(p => allowedPublishNavigation(p.id, value.url));
        if (!platform) throw new Error('不支持的平台地址');
        const win = new BrowserWindow({ width: 1120, height: 800, show: value.active, title: `AI-cut · ${platform.name}`,
          webPreferences: { session: platformSession(platform.id), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
        win.setMenu(null);
        const row = { window: win, platform: platform.id, documentReady: false, error: undefined as string | undefined };
        windows.set(win.id, row);
        win.webContents.on('did-start-navigation', details => {
          if (details.isMainFrame && !details.isSameDocument) row.documentReady = false;
        });
        win.webContents.on('dom-ready', () => {
          row.documentReady = allowedPublishNavigation(platform.id, win.webContents.getURL());
        });
        win.webContents.on('render-process-gone', () => { row.documentReady = false; row.error = '平台页面进程已退出，请重新打开'; });
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        const guard = (event: { preventDefault(): void }, url: string) => { if (!allowedPublishNavigation(platform.id, url)) event.preventDefault(); };
        win.webContents.on('will-navigate', guard);
        win.webContents.on('will-redirect', guard);
        win.webContents.on('will-attach-webview', event => event.preventDefault());
        win.webContents.debugger.on('detach', () => { detachListeners.forEach(listener => listener({ tabId: win.id })); });
        win.on('closed', () => { windows.delete(win.id); });
        // Navigation settles through GEO's tab polling. Account windows also open the creator upload/login page.
        void loadPublishCreator(platform.id, win).catch(error => {
          // The navigation helper returns sanitized errors without account URLs or cookies.
          row.error = error instanceof Error ? error.message : '平台页面加载失败，请关闭此窗口后重试';
          if (!win.isDestroyed()) win.show(); // A failed hidden page must remain inspectable by the user.
        });
        return { id: win.id, url: platform.url, status: 'loading' };
      },
      async get(id: number) { return inspectTab(id); },
      async query() { return [...windows.keys()].map(inspectTab); },
      async update(id: number, value: { active: boolean }) { const row = owned(id); if (value.active) { row.window.show(); row.window.focus(); } return inspectTab(id); },
      async remove(id: number) { owned(id).window.close(); },
    },
    debugger: {
      onDetach: { addListener(listener: (target: { tabId: number }) => void) { detachListeners.add(listener); } },
      async attach(target: { tabId: number }, version: string) { owned(target.tabId).window.webContents.debugger.attach(version); },
      async detach(target: { tabId: number }) { const debuggerApi = owned(target.tabId).window.webContents.debugger; if (debuggerApi.isAttached()) debuggerApi.detach(); },
      async sendCommand(target: { tabId: number }, method: string, params: object) {
        const row = owned(target.tabId);
        if (!allowedPublishNavigation(row.platform, row.window.webContents.getURL())) throw new Error('平台窗口已离开受信页面');
        if (!['Runtime.evaluate', 'DOM.getDocument', 'DOM.querySelector', 'DOM.setFileInputFiles'].includes(method)) throw new Error('不支持的内置插件指令');
        return row.window.webContents.debugger.sendCommand(method, params);
      },
    },
  };
  const code = await readFile(fileURLToPath(new URL('./geo-embedded-runtime.js', import.meta.url)), 'utf8');
  const sandbox: Record<string, unknown> = {
    chrome, URL, URLSearchParams, TextEncoder, TextDecoder, crypto: webcrypto, AbortController, AbortSignal, Headers, Request, Response, Blob, atob, btoa,
    navigator: { userAgent: 'AI-cut embedded GEO runtime' },
    console: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
    setTimeout(callback: () => void, delay: number) { const timer = setTimeout(() => { timeouts.delete(timer); if (!disposed) callback(); }, delay); timeouts.add(timer); return timer; },
    clearTimeout(timer: ReturnType<typeof setTimeout>) { timeouts.delete(timer); clearTimeout(timer); },
    setInterval(callback: () => void, delay: number) { const timer = setInterval(() => { if (!disposed) callback(); }, delay); intervals.add(timer); return timer; },
    clearInterval(timer: ReturnType<typeof setInterval>) { intervals.delete(timer); clearInterval(timer); },
    WebSocket: class extends WebSocket {
      constructor(url: string) {
        if (disposed || url !== options.bridgeUrl) throw new Error('内置插件只能连接当前应用桥接');
        super(url, { origin: 'aicut-internal://geo' });
        sockets.add(this); this.on('close', () => sockets.delete(this));
      }
    },
    async fetch(value: string, init: RequestInit = {}) {
      const id = value === 'https://creator.douyin.com/web/api/media/user/info/' ? 'douyin'
        : value === 'https://creator.xiaohongshu.com/api/galaxy/user/info' ? 'xiaohongshu' : null;
      if (disposed || !id || (init.method && init.method !== 'GET') || init.body) throw new Error('内置 GEO 请求超出账号检查范围');
      const headers = new Headers(init.headers);
      for (const rule of rules.values()) {
        const glob = rule.condition.urlFilter;
        const expression = '^' + glob.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$';
        if (!new RegExp(expression).test(value)) continue;
        for (const header of rule.action.requestHeaders ?? []) if (['origin', 'referer'].includes(header.header.toLowerCase()) && header.operation === 'set') headers.set(header.header, header.value);
      }
      if (id === 'douyin') {
        headers.set('Origin', 'https://creator.douyin.com');
        headers.set('Referer', 'https://creator.douyin.com/');
      }
      return platformSession(id).fetch(value, { ...init, method: 'GET', credentials: 'include', headers, redirect: 'error' });
    },
  };
  function close() {
    if (disposed) return;
    disposed = true;
    (sandbox.aicutGeoEmbedded as { geoMcpClient?: { disconnect(): void } } | undefined)?.geoMcpClient?.disconnect();
    sockets.forEach(socket => socket.terminate());
    timeouts.forEach(timer => clearTimeout(timer)); intervals.forEach(timer => clearInterval(timer));
    windows.forEach(row => { if (!row.window.isDestroyed()) row.window.destroy(); });
    windows.clear(); detachListeners.clear();
  }
  try {
    runInNewContext(code, sandbox, { timeout: 5000 });
    const deadline = Date.now() + 5000;
    while (!disposed && Date.now() < deadline) {
      if ([...sockets].some(socket => socket.readyState === WebSocket.OPEN)) return { close };
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('内置 GEO 插件启动超时');
  } catch (error) { close(); throw error; }
}
