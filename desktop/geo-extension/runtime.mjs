import { GeoVideoAdapter } from './video-adapter.mjs';
import { readDouyinAccount } from './douyin-account.mjs';
/** Extends the actual GEO MCP client, not a second implementation of its auth adapters. */
export function installAiCutBridge(core, chromeApi) {
  const original = core.handleMethod.bind(core);
  const video = new GeoVideoAdapter(chromeApi);
  core.handleMethod = async (method, params) => {
    if (method === 'checkAuth' && !['douyin', 'xiaohongshu'].includes(params?.platform)) throw new Error('不支持的平台');
    if (method === 'checkAuth' && params?.platform === 'douyin') return readDouyinAccount();
    if (method === 'aicut.ping') return { ok: true };
    if (method === 'aicut.capabilities') return {
      protocol: 1, implementation: 'geo-wechatsync-2.0.9',
      accountPlatforms: ['douyin', 'xiaohongshu'], videoPlatforms: ['douyin', 'xiaohongshu'],
    };
    if (method === 'aicut.submitVideo') throw new Error('自动发布已禁用，仅支持保存草稿');
    if (['aicut.prepareVideo', 'aicut.videoStatus', 'aicut.reviewVideo', 'aicut.saveDraft', 'aicut.cancelVideo'].includes(method)) return video.handle(method, params);
    if (method === 'aicut.openAccount') {
      const urls = {
        douyin: 'https://creator.douyin.com/creator-micro/home',
        xiaohongshu: 'https://creator.xiaohongshu.com/',
      };
      if (!Object.hasOwn(urls, params?.platform)) throw new Error('不支持的平台');
      const tab = await chromeApi.tabs.create({ url: urls[params.platform], active: true });
      return { tabId: tab.id };
    }
    // Keep the remaining GEO account adapters/listPlatforms intact.
    return original(method, params);
  };
  const pageUrl = chromeApi.runtime.getURL('aicut-options.html');
  chromeApi.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message?.type?.startsWith('AICUT_')) return false;
    if (sender.id !== chromeApi.runtime.id || sender.url !== pageUrl) {
      respond({ ok: false, error: '仅插件配对页面可以修改连接' });
      return false;
    }
    (async () => {
      if (message.type === 'AICUT_STATUS') return { ok: true, connected: core.isConnected() };
      if (message.type === 'AICUT_PAIR') {
        const url = new URL(message.url);
        const token = url.searchParams.get('token');
        if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/aicut'
          || url.username || url.password || url.hash || url.searchParams.size !== 1 || !/^[a-f0-9]{64}$/.test(token ?? ''))
          throw new Error('请粘贴 AI-cut 提供的本机配对地址');
        core.disconnect();
        await chromeApi.storage.local.set({ mcpEnabled: true, mcpToken: token, mcpServerUrl: url.href });
        core.setToken(token);
        core.setServerUrl(url.href);
        core.resetReconnect();
        return { ok: true };
      }
      if (message.type === 'AICUT_UNPAIR') {
        await chromeApi.storage.local.set({ mcpEnabled: false });
        core.disconnect();
        core.clearToken();
        await chromeApi.storage.local.remove(['mcpToken', 'mcpServerUrl']);
        return { ok: true };
      }
      throw new Error('未知操作');
    })().then(respond).catch(() => respond({ ok: false, error: '配对操作失败，请检查地址后重试' }));
    return true;
  });
}
