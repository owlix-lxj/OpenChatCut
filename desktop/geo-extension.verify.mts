import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { WebSocket } from 'ws';
import { GeoPublishBridge } from './geo-publish-bridge.ts';

// Run the real, pinned GEO client/adapters in a synthetic Chrome host. No platform is contacted.
const token = GeoPublishBridge.createToken();
const bridge = new GeoPublishBridge({ token, port: 0 });
const extensionId = 'b'.repeat(32);
const events = () => ({ addListener() {}, removeListener() {} });
const listeners: Array<(message: unknown, sender: unknown, response: (value: unknown) => void) => unknown> = [];
const storage: Record<string, unknown> = {};
let profileStatus = 200;
let coreClient: { disconnect(): void } | undefined;
const cookieCalls: string[] = [];
const networkCalls: string[] = [];
const storageApi = {
  async get(keys: string | string[] | Record<string, unknown>) {
    const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? storage);
    return Object.fromEntries(names.filter(key => key in storage).map(key => [key, storage[key]]));
  },
  async set(values: Record<string, unknown>) { Object.assign(storage, values); },
  async remove(keys: string[]) { keys.forEach(key => { delete storage[key]; }); },
};
try {
  await bridge.start();
  storage.mcpToken = token;
  storage.mcpServerUrl = bridge.pairingUrl();
  storage.mcpEnabled = true;
  const output = await build({
    stdin: { contents: `export { geoMcpClient } from './desktop-dist/geo-publish-extension/assets/index.ts-Bw-475TG.js'; import './desktop-dist/geo-publish-extension/service-worker-loader.js';`, resolveDir: process.cwd() },
    bundle: true, format: 'iife', globalName: 'fixture', write: false, define: { 'import.meta': '{}' },
  });
  const sandbox: Record<string, unknown> = {
    setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, TextEncoder, TextDecoder,
    crypto: webcrypto, AbortController, AbortSignal, Headers, Request, Response, Blob, atob, btoa,
    navigator: { userAgent: 'Synthetic Chrome Fixture' },
    console: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
    WebSocket: class extends WebSocket {
      constructor(url: string) {
        assert.equal(url, bridge.pairingUrl(), 'Only the local test bridge may be contacted');
        super(url, { origin: `chrome-extension://${extensionId}` });
      }
    },
    fetch: async (url: string, init: RequestInit) => {
      networkCalls.push(String(url));
      if (String(url) === 'https://creator.douyin.com/web/api/media/user/info/') {
        assert.equal(init.credentials, 'include');
        assert.equal(init.redirect, 'error');
        return new Response(JSON.stringify({ status_code: 0, user: { sec_uid: 'fixture-user', nickname: '抖音合成昵称' } }), { status: profileStatus });
      }
      assert.equal(String(url), 'https://creator.xiaohongshu.com/api/galaxy/user/info');
      return new Response(JSON.stringify({ success: true, data: { userId: 'fixture-id', userName: '合成测试账号', userAvatar: '' } }));
    },
    chrome: {
      runtime: {
        id: extensionId, getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
        getManifest: () => ({ version: '2.0.9' }),
        onMessage: { addListener: (listener: typeof listeners[number]) => listeners.push(listener) },
        onStartup: events(), onInstalled: events(),
        sendMessage: async () => undefined,
      },
      storage: { local: storageApi, session: storageApi },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      contextMenus: { onClicked: events() },
      cookies: { getAll: async ({ domain }: { domain: string }) => {
        cookieCalls.push(domain);
        return [{ name: 'passport_assist_user', value: 'synthetic-cookie-not-a-real-credential' }];
      } },
      declarativeNetRequest: { getDynamicRules: async () => [], updateDynamicRules: async () => {},
        RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' }, HeaderOperation: { SET: 'set' } },
      tabs: { onUpdated: events(), query: async () => [], create: async () => ({ id: 1 }) },
      debugger: { onDetach: events() },
    },
  };
  runInNewContext(output.outputFiles[0].text, sandbox, { timeout: 3000 });
  coreClient = (sandbox.fixture as { geoMcpClient: typeof coreClient }).geoMcpClient;
  const deadline = Date.now() + 3000;
  while (!bridge.isConnected() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(bridge.isConnected(), true, 'real GEO client connects with configured credentials');
  const capabilities = await bridge.request<{ implementation: string }>('aicut.capabilities');
  assert.equal(capabilities.implementation, 'geo-wechatsync-2.0.9');
  await assert.rejects(bridge.request('checkAuth', { platform: 'channels' }));
  await assert.rejects(bridge.request('aicut.openAccount', { platform: 'channels' }));
  assert.equal(networkCalls.length, 0, 'no automatic external telemetry/auth requests on startup');
  assert.equal(cookieCalls.length, 0, 'no automatic scan of unrelated accounts');
  const loggedIn = await bridge.request<{ isAuthenticated: boolean; verified: boolean; username: string }>('checkAuth', { platform: 'douyin' });
  assert.equal(loggedIn.isAuthenticated, true);
  assert.equal(loggedIn.verified, true);
  assert.equal(loggedIn.username, '抖音合成昵称');
  assert.deepEqual(cookieCalls, [], 'profile lookup does not export session cookies');
  profileStatus = 401;
  const loggedOut = await bridge.request<{ isAuthenticated: boolean }>('checkAuth', { platform: 'douyin' });
  assert.equal(loggedOut.isAuthenticated, false);
  const xhs = await bridge.request<{ isAuthenticated: boolean; username: string }>('checkAuth', { platform: 'xiaohongshu' });
  assert.equal(xhs.isAuthenticated, true);
  assert.equal(xhs.username, '合成测试账号');
  assert.equal(networkCalls.length, 3);
  // Original GEO listener must not race the AI-cut pairing response.
  assert.equal(listeners[0]({ type: 'AICUT_STATUS' }, {}, () => assert.fail('GEO swallowed pairing message')), false);
  let denied: unknown;
  listeners[1]({ type: 'AICUT_PAIR', url: bridge.pairingUrl() }, { id: extensionId, url: 'https://evil.example' }, value => { denied = value; });
  assert.equal((denied as { ok: boolean }).ok, false);
  const original = await readFile(`${process.env.GEO_EXTENSION_SOURCE || '/Users/lxj/GEO-local/GEO/apps/wechatsync-extension-dist'}/assets/index.ts-Bw-475TG.js`);
  assert.equal(createHash('sha256').update(original).digest('hex'), 'c1b0bcd91b72305d173bb6fa526d93002d01ab7bf011fbeb7bb6ad60b8b433ce');
  console.log('geo-extension: actual GEO client + Douyin/XHS auth adapters verified with synthetic credentials; original untouched');
} finally {
  coreClient?.disconnect();
  await bridge.close();
}
