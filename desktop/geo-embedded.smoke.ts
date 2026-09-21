// Real Electron host + real GEO plugin + real bridge + synthetic HTTPS pages only.
// Every request in the fixture sessions is intercepted; no real platform is contacted.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, session, BrowserWindow } from 'electron';
import { GeoPublishBridge } from './geo-publish-bridge.ts';
import { startEmbeddedGeo } from './geo-embedded-host.ts';
import { SOCIAL_PLATFORMS } from '../shared/social-publish.ts';
import type { GeoVideoJob } from './geo-video-adapter.ts';

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'aicut-embedded-geo-smoke-'));
  app.setPath('userData', directory);
  // Closing the first host's last window must not end Electron before restart assertions run.
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const watchdog = setTimeout(() => { console.error('embedded GEO smoke timed out'); app.exit(1); }, 50_000);
  let host: { close(): void } | undefined;
  const token = GeoPublishBridge.createToken();
  const bridge = new GeoPublishBridge({ token, internal: true, port: 0 });
  let xhsChecks = 0;
  let stalledResources = 0;
  try {
    const video = join(directory, 'fixture.mp4');
    await writeFile(video, 'synthetic bytes, not a real video');
    for (const platform of SOCIAL_PLATFORMS) {
      const profile = session.fromPartition(`persist:aicut-publisher-${platform.id}`);
      profile.protocol.handle('http', () => new Response('blocked fixture protocol', { status: 403 }));
      profile.protocol.handle('https', request => {
        if (request.url === 'https://creator.douyin.com/web/api/media/user/info/') {
          assert.equal(request.headers.get('origin'), 'https://creator.douyin.com');
          assert.equal(request.headers.get('referer'), 'https://creator.douyin.com/');
          return new Response(JSON.stringify({ status_code: 0, user: { sec_uid: 'fixture-user', nickname: '抖音内置测试账号' } }));
        }
        if (request.url === `https://${platform.host}/aicut-fixture-pending.png`) {
          stalledResources++;
          return new Promise<Response>(() => {}); // DOM is usable while an unrelated resource never finishes.
        }
        if (request.url === 'https://creator.xiaohongshu.com/api/galaxy/user/info') {
          xhsChecks++;
          assert.equal(request.headers.get('origin'), 'https://creator.xiaohongshu.com');
          return new Response(JSON.stringify({ success: true, data: { userId: 'synthetic', userName: '内置测试账号', userAvatar: '' } }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (!request.url.startsWith(`https://${platform.host}/`)) return new Response('blocked external fixture URL', { status: 403 });
        const title = platform.id === 'douyin' ? '填写作品标题' : '填写标题';
        const bodyClass = platform.id === 'douyin' ? 'zone-container' : 'tiptap';
        const button = '发布';
        return new Response(`<!doctype html><meta charset="utf-8"><title>AI-cut 离线内置桥接测试</title>
          <input type="file" accept="video/mp4" onchange="document.getElementById('state').textContent='上传成功'">
          <input placeholder="${title}"><div class="${bodyClass}" contenteditable="true"></div>
          <span id="state">请选择视频</span><button onclick="document.getElementById('state').textContent='发布成功'">${button}</button><button onclick="document.getElementById('state').textContent='草稿保存成功'">保存草稿</button><img src="/aicut-fixture-pending.png">`,
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      });
    }
    await session.fromPartition('persist:aicut-publisher-douyin').cookies.set({ url: 'https://creator.douyin.com', domain: '.douyin.com', name: 'passport_assist_user', value: 'synthetic-only' });
    await bridge.start();
    host = await startEmbeddedGeo({ bridgeUrl: bridge.pairingUrl(), token, userData: directory });
    assert.equal(bridge.isConnected(), true);
    const capability = await bridge.request<{ videoPlatforms: string[] }>('aicut.capabilities');
    assert.equal(capability.videoPlatforms.length, 2);
    const dy = await bridge.request<{ isAuthenticated: boolean; username: string }>('checkAuth', { platform: 'douyin' });
    assert.equal(dy.isAuthenticated, true);
    assert.equal(dy.username, '抖音内置测试账号');
    const xhs = await bridge.request<{ isAuthenticated: boolean; username: string }>('checkAuth', { platform: 'xiaohongshu' });
    assert.equal(xhs.isAuthenticated, true);
    assert.equal(xhs.username, '内置测试账号');
    assert.equal(xhsChecks, 1);
    for (const platform of SOCIAL_PLATFORMS) {
      const jobId = `embedded-${platform.id}`;
      await bridge.request('aicut.prepareVideo', { jobId, platform: platform.id, path: video, title: '内置桥接测试视频标题', description: 'This page is synthetic and intercepted locally.' });
      const waitFor = async (phase: string) => {
        const deadline = Date.now() + 10_000;
        let status: GeoVideoJob;
        do {
          status = await bridge.request<GeoVideoJob>('aicut.videoStatus', { jobId });
          if (status.phase === phase) return;
          if (['failed', 'unknown'].includes(status.phase)) throw new Error(`${platform.id}: ${status.phase}: ${status.detail}`);
          await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        throw new Error(`${platform.id}: expected ${phase}, got ${status.phase}: ${status.detail}`);
      };
      await waitFor('review');
      const fixtureWindow = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith(`https://${platform.host}/`));
      assert.equal((await bridge.request<GeoVideoJob>('aicut.videoStatus', { jobId })).windowOpened, true);
      assert.ok(fixtureWindow?.isVisible(), 'window-open acknowledgement requires a visible platform page');
      assert.ok(fixtureWindow?.webContents.isLoading(), 'fixture must still be loading a resource during review');
      await assert.rejects(bridge.request('aicut.submitVideo', { jobId }));
      await bridge.request('aicut.saveDraft', { jobId });
      await waitFor('drafted');
      console.log(`${platform.id}: actual embedded GEO upload/review/save-draft passed on synthetic page`);
    }
    assert.equal(stalledResources, 2, 'each synthetic platform must exercise pending resource loading');
    host.close(); await bridge.close();
    const stored = await readFile(join(directory, 'geo-runtime-store.json'), 'utf8');
    assert.equal(stored.includes(token), false, 'internal pairing credential must not be persisted');
    assert.equal(stored.includes('synthetic-only'), false, 'session cookies must not be copied to runtime storage');
    assert.equal(stored.includes('tabId'), false, 'window IDs must not survive host restart');
    const restarted = new GeoPublishBridge({ token: GeoPublishBridge.createToken(), internal: true, port: 0 });
    try {
      await restarted.start();
      host = await startEmbeddedGeo({ bridgeUrl: restarted.pairingUrl(), token: new URL(restarted.pairingUrl()).searchParams.get('token')!, userData: directory });
      assert.equal(restarted.isConnected(), true, 'fresh bridge must connect without manual pairing');
      assert.equal((await restarted.request<{ isAuthenticated: boolean }>('checkAuth', { platform: 'douyin' })).isAuthenticated, true);
      const previous = await restarted.request<GeoVideoJob>('aicut.videoStatus', { jobId: 'embedded-douyin' });
      assert.equal(previous.phase, 'drafted');
      assert.equal(previous.tabId, undefined);
      await assert.rejects(restarted.request('aicut.reviewVideo', { jobId: previous.id }));
      await assert.rejects(restarted.request('aicut.saveDraft', { jobId: previous.id }));
    } finally { host.close(); await restarted.close(); }
    console.log('Built-in GEO startup/restart, existing session access, XHS headers and two local end-to-end fixtures passed; no Chrome installation/pairing');
    clearTimeout(watchdog); app.exit(0);
  } catch (error) { console.error(error); host?.close(); await bridge.close(); clearTimeout(watchdog); app.exit(1); }
}
void run().catch(error => { console.error(error); app.exit(1); });
