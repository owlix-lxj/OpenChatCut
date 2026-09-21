import assert from 'node:assert/strict';
import { GeoVideoAdapter, videoFailureDetail, type GeoVideoChrome, type GeoVideoJob } from './geo-video-adapter.ts';
import { runInNewContext } from 'node:vm';
import { SOCIAL_PLATFORMS } from '../shared/social-publish.ts';

function fixture() {
  const stored: Record<string, unknown> = {};
  const tabs = new Map<number, { id: number; url: string; status: string }>();
  const sent: { method: string; params?: object }[] = [];
  let uploaded = false, saved = false, clicks = 0, mismatch = false, ready = true, receipt = true;
  let nextId = 1;
  const chrome: GeoVideoChrome = {
    storage: { local: { get: async () => structuredClone(stored), set: async value => { Object.assign(stored, structuredClone(value)); } } },
    tabs: {
      create: async options => { const tab = { id: nextId++, url: options.url, status: 'complete' }; tabs.set(tab.id, tab); return tab; },
      get: async id => { const tab = tabs.get(id); if (!tab) throw new Error('tab closed'); return { ...tab, url: mismatch ? 'https://evil.example/' : tab.url }; },
      update: async id => tabs.get(id)!, remove: async id => { tabs.delete(id); },
    },
    debugger: {
      attach: async () => {}, detach: async () => {}, onDetach: { addListener() {} },
      sendCommand: async (_target, method, params) => {
        sent.push({ method, params });
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelector') return { nodeId: 2 };
        if (method === 'DOM.setFileInputFiles') { uploaded = true; return {}; }
        if (method === 'Runtime.evaluate') {
          const expression = (params as { expression: string }).expression;
          const config = JSON.parse(expression.match(/const c = (.+);\n/)![1]);
          if (config.action === 'save-draft') { clicks++; saved = true; return { result: { value: true } }; }
          if (config.action === 'fill') return { result: { value: true } };
          return { result: { value: { login: false, uploadSelector: uploaded ? null : 'input[type=file]', ready: uploaded && ready, success: false, draftSaved: saved && receipt, failed: false } } };
        }
        throw new Error(`unexpected command ${method}`);
      },
    },
  };
  return { chrome, sent, stored, clicks: () => clicks, mismatch: () => { mismatch = true; }, notReady: () => { ready = false; }, noReceipt: () => { receipt = false; } };
}
const foreignError: unknown = runInNewContext('new Error("Cannot find context with specified id")');
assert.equal(foreignError instanceof Error, false);
assert.equal(videoFailureDetail(foreignError), 'Cannot find context with specified id');
assert.equal(videoFailureDetail({ message: 'Failed https://example.invalid?token=secret' }), 'Failed [地址已隐藏]');
assert.equal(videoFailureDetail({ message: 'Missing /Users/synthetic/private.mp4' }), 'Missing [本机路径已隐藏]');
assert.equal(videoFailureDetail(null), '未返回具体错误');
async function waitFor(adapter: GeoVideoAdapter, jobId: string, phase: GeoVideoJob['phase']) {
  const deadline = Date.now() + 1500;
  let job: GeoVideoJob;
  do {
    job = await adapter.handle('aicut.videoStatus', { jobId });
    if (job.phase === phase) return job;
    await new Promise(resolve => setTimeout(resolve, 2));
  } while (Date.now() < deadline);
  assert.fail(`expected ${phase}, got ${job.phase}: ${job.detail}`);
}
for (const platform of SOCIAL_PLATFORMS) {
  const f = fixture();
  const adapter = new GeoVideoAdapter(f.chrome, { pollMs: 1, timeoutMs: 500 });
  const draft = { jobId: `fixture-${platform.id}`, platform: platform.id, path: '/synthetic/input.mp4', title: '合成测试视频标题', description: 'No real upload' };
  await adapter.handle('aicut.prepareVideo', draft);
  const review = await waitFor(adapter, draft.jobId, 'review');
  assert.equal(review.windowOpened, true, 'loaded platform window must be acknowledged');
  assert.equal(JSON.stringify(f.stored).includes('windowOpened'), false, 'window readiness is runtime-only');
  assert.equal(f.clicks(), 0, 'upload must never publish');
  await assert.rejects(adapter.handle('aicut.submitVideo', { jobId: draft.jobId }), /自动发布已禁用/);
  assert.equal(f.clicks(), 0, 'legacy publish requests must not click anything');
  const fileCalls = f.sent.filter(c => c.method === 'DOM.setFileInputFiles');
  assert.equal(fileCalls.length, 1);
  assert.deepEqual((fileCalls[0].params as { files: string[] }).files, ['/synthetic/input.mp4']);
  assert.equal(JSON.stringify(f.stored).includes('/synthetic/'), false, 'no local file paths persisted in extension');
  await adapter.handle('aicut.prepareVideo', draft);
  assert.equal(f.sent.filter(c => c.method === 'DOM.setFileInputFiles').length, 1, 'duplicate prepare does not upload again');
  await adapter.handle('aicut.saveDraft', { jobId: draft.jobId });
  await assert.rejects(adapter.handle('aicut.saveDraft', { jobId: draft.jobId }), /不能保存草稿/);
  await waitFor(adapter, draft.jobId, 'drafted');
  assert.equal(f.clicks(), 1);
}
{
  const f = fixture();
  const getTab = f.chrome.tabs.get;
  let loading = true;
  let shown = false;
  f.chrome.tabs.get = async id => ({ ...await getTab(id), status: loading ? 'loading' : 'complete' });
  f.chrome.tabs.update = async id => { shown = true; return getTab(id); };
  const adapter = new GeoVideoAdapter(f.chrome, { pollMs: 1, timeoutMs: 500 });
  const draft = { jobId: 'opening', platform: 'douyin', path: '/synthetic/input.mp4', title: '测试', description: '' };
  await adapter.handle('aicut.prepareVideo', draft);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await adapter.handle('aicut.videoStatus', draft)).windowOpened, undefined);
  assert.equal(shown, false, 'blank/loading windows must not dismiss the global loader');
  loading = false;
  assert.equal((await waitFor(adapter, draft.jobId, 'review')).windowOpened, true);
  assert.equal(shown, true);
}
{
  const f = fixture();
  f.chrome.tabs.update = async () => { throw new Error('窗口已关闭'); };
  const adapter = new GeoVideoAdapter(f.chrome, { pollMs: 1, timeoutMs: 500 });
  const draft = { jobId: 'open-failed', platform: 'douyin', path: '/synthetic/input.mp4', title: '测试', description: '' };
  await adapter.handle('aicut.prepareVideo', draft);
  assert.equal((await waitFor(adapter, draft.jobId, 'failed')).windowOpened, undefined);
  assert.equal(f.sent.length, 0, 'failed window opening must not start upload');
}
{
  const f = fixture();
  const adapter = new GeoVideoAdapter(f.chrome, { pollMs: 1, timeoutMs: 500 });
  const draft = { jobId: 'cancelled', platform: 'douyin', path: '/synthetic/input.mp4', title: '测试', description: '' };
  await adapter.handle('aicut.prepareVideo', draft);
  await adapter.handle('aicut.cancelVideo', { jobId: draft.jobId });
  await waitFor(adapter, draft.jobId, 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.sent.filter(c => c.method === 'DOM.setFileInputFiles').length, 0);
  await assert.rejects(adapter.handle('aicut.saveDraft', { jobId: draft.jobId }), /不能保存草稿/);
}
{
  const f = fixture();
  const adapter = new GeoVideoAdapter(f.chrome, { pollMs: 1, timeoutMs: 500 });
  const draft = { jobId: 'restart', platform: 'douyin', path: '/synthetic/input.mp4', title: '测试', description: '' };
  await adapter.handle('aicut.prepareVideo', draft);
  await waitFor(adapter, draft.jobId, 'review');
  assert.equal(JSON.stringify(f.stored).includes('tabId'), false, 'process-local window IDs must not be persisted');
  // Older records may still contain a reused window ID; restoration must discard it.
  (f.stored.aicutVideoJobs as GeoVideoJob[])[0].tabId = 1;
  const restarted = new GeoVideoAdapter(f.chrome);
  const restored = await restarted.handle('aicut.prepareVideo', draft);
  assert.equal(restored.phase, 'unknown');
  assert.equal(restored.tabId, undefined);
  await assert.rejects(restarted.handle('aicut.reviewVideo', { jobId: draft.jobId }), /原平台页面不存在/);
  await assert.rejects(restarted.handle('aicut.saveDraft', { jobId: draft.jobId }), /不能保存草稿/);
  assert.equal(f.sent.filter(c => c.method === 'DOM.setFileInputFiles').length, 1);
  f.mismatch();
  await assert.rejects(adapter.handle('aicut.reviewVideo', { jobId: draft.jobId }), /受信/);
  await adapter.handle('aicut.saveDraft', { jobId: draft.jobId });
  await waitFor(adapter, draft.jobId, 'unknown');
  assert.equal(f.clicks(), 0);
}
{
  const f = fixture();
  f.chrome.debugger.attach = async () => { throw foreignError; };
  const adapter = new GeoVideoAdapter(f.chrome, { pollMs: 1, timeoutMs: 500 });
  const draft = { jobId: 'cross-realm-error', platform: 'douyin', path: '/synthetic/input.mp4', title: '测试', description: '' };
  await adapter.handle('aicut.prepareVideo', draft);
  const failure = await waitFor(adapter, draft.jobId, 'failed');
  assert.match(failure.detail, /连接平台页面.*Cannot find context/);
  assert.equal(f.sent.filter(c => c.method === 'DOM.setFileInputFiles').length, 0);
}
{
  const f = fixture();
  f.noReceipt();
  const adapter = new GeoVideoAdapter(f.chrome, { pollMs: 1, timeoutMs: 100 });
  const draft = { jobId: 'no-draft-receipt', platform: 'douyin', path: '/synthetic/input.mp4', title: '测试', description: '' };
  await adapter.handle('aicut.prepareVideo', draft);
  await waitFor(adapter, draft.jobId, 'review');
  await adapter.handle('aicut.saveDraft', { jobId: draft.jobId });
  await waitFor(adapter, draft.jobId, 'unknown');
  assert.equal(f.clicks(), 1, 'no receipt must not cause retries');
  await assert.rejects(adapter.handle('aicut.saveDraft', { jobId: draft.jobId }), /不能保存草稿/);
}
{
  const f = fixture();
  f.stored.aicutVideoJobs = [{ id: 'retired-channels', platform: 'channels', phase: 'review', revision: 1, tabId: 19, detail: 'legacy record' }];
  const adapter = new GeoVideoAdapter(f.chrome);
  await assert.rejects(adapter.handle('aicut.videoStatus', { jobId: 'retired-channels' }));
  await assert.rejects(adapter.handle('aicut.prepareVideo', { jobId: 'channels-new', platform: 'channels', path: '/synthetic/input.mp4', title: '测试', description: '' }), /不支持/);
  const retired = (f.stored.aicutVideoJobs as Array<Record<string, unknown>>)[0];
  assert.equal(retired.id, 'retired-channels');
  assert.equal(retired.tabId, undefined);
  assert.equal(f.sent.length, 0, 'removed platform must never navigate or upload');
}
console.log('geo-video-adapter: draft-only lifecycle, retired-platform rejection, missing receipt, restart, origin guard and cross-realm error diagnostics passed');
