import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { build } from 'esbuild';
import { WebSocket } from 'ws';
import type { PublishFile, PublishSnapshot } from '../shared/social-publish.ts';

// Native boundary fixture + real WebSocket broker; no live accounts or platform requests.
const directory = await mkdtemp(join(tmpdir(), 'aicut-geo-ipc-'));
const video = join(directory, 'fixture.mp4');
await writeFile(video, 'synthetic file bytes');
const canonicalVideo = await realpath(video);
const retiredJob = { id: 'retired-channels', platform: 'channels', filename: 'old.mp4', title: '旧记录', detail: '保留历史', phase: 'review', engine: 'geo', createdAt: 1, updatedAt: 1 };
await writeFile(join(directory, 'social-publish-jobs.json'), JSON.stringify([retiredJob]));
const listeners: Record<string, () => void> = {};
let invoke: (event: unknown, request: unknown) => Promise<unknown>;
let copied = '', confirmations = 0, choice = 0;
const exports = ['app', 'BrowserWindow', 'clipboard', 'dialog', 'ipcMain', 'safeStorage', 'shell', 'session'];
const globals = globalThis as typeof globalThis & { __aicutGeoFixture?: object };
globals.__aicutGeoFixture = {
  app: { isPackaged: false, getPath: () => directory, once: (name: string, fn: () => void) => { listeners[name] = fn; } },
  BrowserWindow: { fromWebContents: () => ({}) },
  clipboard: { writeText: (value: string) => { copied = value; } },
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [video] }),
    showMessageBox: async () => { confirmations++; return { response: choice }; },
  },
  ipcMain: { handle: (_channel: string, fn: typeof invoke) => { invoke = fn; } },
  // Deterministic fake codec, not used in production. Real encrypted storage has its own regression.
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')) },
  shell: { openPath: async () => '' },
};
const frame = { url: 'http://127.0.0.1:5199/' };
const event = { senderFrame: frame, sender: { mainFrame: frame } };
const request = (value: unknown) => invoke(event, value);
let socket: WebSocket | undefined;
try {
  const bundled = join(directory, 'publisher.mjs');
  await build({ entryPoints: [resolve('desktop/geo-social-publish.ts')], outfile: bundled, bundle: true, platform: 'node', format: 'esm',
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    plugins: [{ name: 'native-fixture', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron-fixture', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `const e=globalThis.__aicutGeoFixture; ${exports.map(name => `export const ${name}=e.${name};`).join('\n')}`, loader: 'js' }));
    } }],
  });
  const { installSocialPublish } = await import(pathToFileURL(bundled).href);
  let token = '';
  const jobs = new Map<string, { id: string; platform: string; phase: string; revision: number; detail: string }>();
  let saved = 0, uploads = 0;
  let accountReply: object = { isAuthenticated: true, verified: true, username: 'fixture-user' };
  const startHost = async (options: { bridgeUrl: string; token: string }) => {
  copied = options.bridgeUrl; token = options.token;
  socket = new WebSocket(copied, { origin: 'aicut-internal://geo' });
  socket.on('message', raw => {
    const command = JSON.parse(raw.toString());
    assert.equal(command.token, token);
    const { method, params } = command;
    let result: unknown;
    if (method === 'aicut.capabilities') result = { protocol: 1, implementation: 'geo-wechatsync-2.0.9', videoPlatforms: ['douyin', 'xiaohongshu'] };
    else if (method === 'checkAuth') result = accountReply;
    else if (method === 'aicut.ping' || method === 'aicut.openAccount') result = { ok: true };
    else if (method === 'aicut.prepareVideo') {
      assert.equal(params.path, canonicalVideo);
      uploads++;
      const job = { id: params.jobId, platform: params.platform, phase: 'review', detail: 'synthetic review', revision: 1, windowOpened: true };
      jobs.set(job.id, job); result = job;
    } else if (method === 'aicut.saveDraft') {
      saved++;
      const job = jobs.get(params.jobId)!;
      job.phase = 'drafted'; job.revision++; result = job;
    } else if (method === 'aicut.reviewVideo' || method === 'aicut.videoStatus') result = jobs.get(params.jobId);
    else throw new Error(`unexpected bridge command ${method}`);
    socket!.send(JSON.stringify({ id: command.id, result }));
  });
  await once(socket, 'open');
  return { close() { socket?.terminate(); } };
  };
  installSocialPublish('http://127.0.0.1:5199', { bridgePort: 0, startHost });
  await assert.rejects(invoke!({ senderFrame: { url: 'https://evil.example' }, sender: {} }, { action: 'snapshot' }));
  const paired = await request({ action: 'snapshot' }) as PublishSnapshot;
  assert.equal(paired.bridge?.ready, true);
  assert.deepEqual(paired.accounts.map(a => a.platform), ['douyin', 'xiaohongshu']);
  assert.equal(paired.jobs.length, 0, 'retired history is not an active UI task');
  await assert.rejects(request({ action: 'connect', platform: 'channels' }), /不支持/);
  await assert.rejects(request({ action: 'refresh-account', platform: 'channels' }), /不支持/);
  assert.equal(paired.accounts.find(a => a.platform === 'douyin')?.state, 'available');
  assert.equal(paired.accounts.find(a => a.platform === 'douyin')?.username, 'fixture-user');
  assert.equal(paired.accounts.find(a => a.platform === 'xiaohongshu')?.state, 'available');
  for (const failure of [{ isAuthenticated: false, error: 'temporary failure' }, { isAuthenticated: true, username: 'cookie-only' }]) {
    accountReply = failure;
    await request({ action: 'refresh-account', platform: 'douyin' });
    const account = (await request({ action: 'snapshot' }) as PublishSnapshot).accounts.find(a => a.platform === 'douyin');
    assert.equal(account?.state, 'error', 'unknown verification must not report logout or authenticated');
    assert.equal(account?.username, undefined, 'do not keep a stale nickname after failed verification');
  }
  accountReply = { isAuthenticated: false, verified: true };
  await request({ action: 'refresh-account', platform: 'douyin' });
  assert.equal(((await request({ action: 'snapshot' })) as PublishSnapshot).accounts.find(a => a.platform === 'douyin')?.state, 'login_required');
  accountReply = { isAuthenticated: true, verified: true, username: '切换后的账号' };
  await request({ action: 'refresh-account', platform: 'douyin' });
  assert.equal(((await request({ action: 'snapshot' })) as PublishSnapshot).accounts.find(a => a.platform === 'douyin')?.username, '切换后的账号');
  const file = await request({ action: 'choose-file' }) as PublishFile;
  assert.equal('path' in file, false, 'renderer gets an opaque grant only');
  await request({ action: 'prepare', draft: { fileId: file.id, platforms: ['douyin'], title: '合成测试', description: '' } });
  let snapshot: PublishSnapshot;
  const deadline = Date.now() + 3000;
  do { snapshot = await request({ action: 'snapshot' }) as PublishSnapshot; if (snapshot.jobs[0]?.phase === 'review') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  const job = snapshot.jobs[0];
  assert.equal(job.phase, 'review');
  assert.equal(job.engine, 'geo');
  assert.equal(uploads, 1);
  await assert.rejects(request({ action: 'submit', jobId: job.id }), /不支持自动发布/);
  assert.equal(confirmations, 0, 'legacy publish rejected before confirmation or RPC');
  assert.equal(saved, 0);
  await request({ action: 'save-draft', jobId: job.id });
  assert.equal(confirmations, 1);
  assert.equal(saved, 0, 'native cancel must never dispatch draft save');
  choice = 1;
  await request({ action: 'save-draft', jobId: job.id });
  assert.equal(saved, 1);
  await assert.rejects(request({ action: 'save-draft', jobId: job.id }), /不能保存草稿/);
  const persisted = JSON.parse(await readFile(join(directory, 'social-publish-jobs.json'), 'utf8'));
  assert.equal(persisted[0].phase, 'drafted');
  assert.deepEqual(persisted.find((row: { id: string }) => row.id === retiredJob.id), retiredJob, 'removed-platform history is preserved, not deleted');
  assert.equal(JSON.stringify(persisted).includes(token!), false);
  assert.equal(JSON.stringify(persisted).includes(video), false);
  console.log('geo-social-publish: native IPC → real loopback bridge, account states, file grants, cancelled confirmation and single confirmed draft save passed');
} finally {
  socket?.terminate();
  listeners['before-quit']?.();
  delete globals.__aicutGeoFixture;
  await rm(directory, { recursive: true, force: true });
}
