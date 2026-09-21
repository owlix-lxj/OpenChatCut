import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { assertTrustedDesktopSenderUrl } from './page-origin.ts';
import { resolveExportRevealTarget } from './export-reveal.ts';
import { resolvePersistedExportDestination } from './export-directory-state.ts';
import { GeoPublishBridge } from './geo-publish-bridge.ts';
import { startEmbeddedGeo } from './geo-embedded-host.ts';
import {
  SOCIAL_PUBLISH_CHANNEL, SOCIAL_PLATFORMS, activePublishPhase, socialPlatform, validatePublishDraft,
  type PublishFile, type PublishJob, type PublishPhase, type PublishRequest, type PublishSnapshot, type SocialPlatform,
} from '../shared/social-publish.ts';
import type { GeoVideoJob } from './geo-video-adapter.ts';
import { waitForPublishWindows } from './social-publish-window-ready.ts';

type FileGrant = PublishFile & { path: string; mtime: number };
type Account = PublishSnapshot['accounts'][number];

/** Primary publisher: platform work goes to the bundled GEO runtime over its internal bridge. */
export function installSocialPublish(trustedOrigin: string, options: { bridgePort?: number; startHost?: typeof startEmbeddedGeo } = {}): void {
  const root = app.getPath('userData');
  const statePath = join(root, 'social-publish-jobs.json');
  const grants = new Map<string, FileGrant>();
  const accounts = new Map<SocialPlatform, Account>();
  const checked = new Map<SocialPlatform, number>();
  const checking = new Map<SocialPlatform, Promise<void>>();
  const confirming = new Set<string>();
  const workers = new Set<string>();
  const revisions = new Map<string, number>();
  const openedWindows = new Set<string>(); // Runtime-only acknowledgement, never restored from history.
  let jobs: PublishJob[] = [];
  let retiredJobs: unknown[] = []; // Preserve removed-platform history without showing or executing it.
  let writes: Promise<void> = Promise.resolve();
  let admission = false;
  let closed = false;
  let transport: GeoPublishBridge | undefined;
  let embedded: { close(): void } | undefined;
  let starting: Promise<GeoPublishBridge> | undefined;
  let unavailable: string | null = null;
  const loaded = readFile(statePath, 'utf8').then(raw => {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('发布记录格式损坏');
    retiredJobs = data.filter(j => j && typeof j === 'object' && j.platform === 'channels');
    jobs = data.slice(0, 100).filter((j): j is PublishJob => !!j && typeof j === 'object'
      && typeof j.id === 'string' && typeof j.title === 'string' && typeof j.filename === 'string'
      && typeof j.detail === 'string' && typeof j.createdAt === 'number' && typeof j.updatedAt === 'number'
      && SOCIAL_PLATFORMS.some(p => p.id === j.platform)
      && ['preparing', 'uploading', 'review', 'saving_draft', 'drafted', 'submitting', 'published', 'failed', 'cancelled', 'unknown'].includes(j.phase))
      .map(j => activePublishPhase(j.phase) ? { ...j, phase: 'unknown', detail: '应用已重启，请先核对平台结果；不会自动重发。' } : j);
  }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw new Error('读取发布记录失败，请保留记录文件并检查磁盘'); });
  void loaded.catch(() => undefined);
  app.once('before-quit', () => { closed = true; embedded?.close(); void transport?.close(); });

  async function bridge(): Promise<GeoPublishBridge> {
    if (closed) throw new Error('应用正在退出');
    if (unavailable) throw new Error(unavailable);
    if (transport) return transport;
    if (!starting) starting = (async () => {
      const token = GeoPublishBridge.createToken();
      const instance = new GeoPublishBridge({ token, port: options.bridgePort ?? 0, internal: true });
      try {
        await instance.start();
        const host = await (options.startHost ?? startEmbeddedGeo)({ bridgeUrl: instance.pairingUrl(), token, userData: root });
        embedded = host;
        if (closed) { host.close(); embedded = undefined; throw new Error('应用正在退出'); }
        transport = instance;
        return instance;
      } catch (error) {
        await instance.close();
        const message = error instanceof Error ? error.message : String(error);
        if (/geo-embedded-runtime|GEO|ENOENT|missing/i.test(message)) {
          unavailable = 'GEO 发布组件未打包，当前安装包不能检查抖音/小红书账号。请安装包含 GEO 运行时的新版本。';
        }
        throw error;
      }
    })().finally(() => { starting = undefined; });
    return starting;
  }
  function save(): Promise<void> {
    const raw = JSON.stringify([...jobs.slice(0, 100), ...retiredJobs]);
    const write = writes.then(async () => {
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(`${statePath}.tmp`, raw, { mode: 0o600 });
      await rename(`${statePath}.tmp`, statePath);
    });
    writes = write.catch(() => undefined);
    return write;
  }
  async function update(job: PublishJob, phase: PublishPhase, detail: string) {
    Object.assign(job, { phase, detail, updatedAt: Date.now() });
    await save();
  }
  async function capabilities(): Promise<NonNullable<PublishSnapshot['bridge']>> {
    try {
      const b = await bridge();
      if (!b.isConnected()) { accounts.clear(); checked.clear(); return { connected: false, ready: false, detail: '平台连接正在恢复，请稍后重试。', videoPlatforms: [] }; }
      const result = await b.request<{ protocol?: number; implementation?: string; videoPlatforms?: unknown }>('aicut.capabilities', {}, 5000);
      if (result?.protocol !== 1 || result.implementation !== 'geo-wechatsync-2.0.9' || !Array.isArray(result.videoPlatforms)) throw new Error('平台连接组件版本不兼容，请重新构建开发版');
      return { connected: true, ready: true, detail: '平台连接已就绪', videoPlatforms: SOCIAL_PLATFORMS.map(p => p.id).filter(id => (result.videoPlatforms as unknown[]).includes(id)) };
    } catch (error) {
      return {
        connected: transport?.isConnected() ?? false,
        ready: false,
        detail: unavailable ?? (error instanceof Error ? error.message : '桥接连接失败'),
        videoPlatforms: [],
      };
    }
  }
  async function requireReady(platform?: SocialPlatform) {
    const status = await capabilities();
    if (!status.ready) throw new Error(status.detail);
    if (platform && !status.videoPlatforms.includes(platform)) throw new Error('内置服务未提供此平台的视频发布适配');
    return bridge();
  }
  async function refreshAccount(id: SocialPlatform, force = false): Promise<void> {
    if (checking.has(id)) return checking.get(id);
    if (!force && Date.now() - (checked.get(id) ?? 0) < 10_000) return;
    const promise = (async () => {
      {
        try {
          const result = await (await bridge()).request<{ isAuthenticated?: boolean; verified?: boolean; username?: unknown; error?: unknown }>('checkAuth', { platform: id }, 8000);
          if (typeof result?.isAuthenticated !== 'boolean') throw new Error('无效账号结果');
          const username = typeof result.username === 'string' ? result.username.trim().slice(0, 100) : undefined;
          const profileMissing = id === 'douyin' && (result.verified !== true || result.isAuthenticated && !username);
          accounts.set(id, { platform: id, windowOpen: false,
            state: result.error || profileMissing ? 'error' : !result.isAuthenticated ? 'login_required' : 'available',
            username: result.isAuthenticated && !result.error && !profileMissing ? username : undefined,
            detail: result.error || profileMissing ? '账号资料暂未获取，请打开平台核对或刷新；不代表已退出登录。' : undefined,
          });
        } catch { accounts.set(id, { platform: id, state: 'error', windowOpen: false, detail: '账号检查未成功，请稍后刷新或打开平台核对。' }); }
      }
      checked.set(id, Date.now());
    })().finally(() => { checking.delete(id); });
    checking.set(id, promise);
    return promise;
  }
  async function grant(path: string): Promise<PublishFile> {
    const canonical = await realpath(path).catch(() => { throw new Error('视频文件不存在或无权读取，请重新选择'); });
    const info = await stat(canonical);
    if (!['.mp4', '.mov', '.webm'].includes(extname(canonical).toLowerCase()) || !info.isFile() || info.size <= 0) throw new Error('请选择非空的 MP4、MOV 或 WebM 视频');
    if (grants.size >= 100) grants.delete(grants.keys().next().value!);
    const file = { id: randomUUID(), name: basename(canonical), size: info.size, path: canonical, mtime: info.mtimeMs };
    grants.set(file.id, file);
    return { id: file.id, name: file.name, size: file.size };
  }
  async function checkFile(file: FileGrant) {
    const info = await stat(file.path).catch(() => null);
    if (!info || !info.isFile() || info.size !== file.size || info.mtimeMs !== file.mtime || await realpath(file.path).catch(() => '') !== file.path) throw new Error('视频文件已改变，请重新选择');
  }
  async function applyRemote(job: PublishJob, response: unknown) {
    const remote = response as GeoVideoJob;
    if (!remote || remote.id !== job.id || remote.platform !== job.platform || typeof remote.detail !== 'string'
      || remote.detail.length > 2000 || !Number.isSafeInteger(remote.revision) || remote.revision < 0
      || !['preparing', 'uploading', 'review', 'saving_draft', 'drafted', 'failed', 'cancelled', 'unknown'].includes(remote.phase)) throw new Error('上传任务状态无效，请到平台核对');
    if (remote.revision < (revisions.get(job.id) ?? -1)) return;
    revisions.set(job.id, remote.revision);
    if (remote.windowOpened === true) openedWindows.add(job.id);
    if (job.phase !== remote.phase || job.detail !== remote.detail) await update(job, remote.phase, remote.detail);
  }
  async function observe(job: PublishJob) {
    if (workers.has(job.id)) return;
    workers.add(job.id);
    try {
      while (!closed && ['preparing', 'uploading', 'saving_draft'].includes(job.phase)) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (closed || !['preparing', 'uploading', 'saving_draft'].includes(job.phase)) break;
        const remote = await (await bridge()).request('aicut.videoStatus', { jobId: job.id }, 8000);
        await applyRemote(job, remote);
      }
    } catch { await update(job, 'unknown', '桥接中断或任务状态无法确认，请到平台核对；不会自动重发。').catch(() => undefined); }
    finally { workers.delete(job.id); }
  }
  async function prepare(job: PublishJob, file: FileGrant, description: string) {
    try {
      await checkFile(file);
      const remote = await (await bridge()).request('aicut.prepareVideo', { jobId: job.id, platform: job.platform, path: file.path, title: job.title, description }, 8000);
      await applyRemote(job, remote);
      void observe(job);
    } catch { await update(job, 'unknown', '未能确认是否开始上传，请打开平台核对；不会自动重传。'); }
  }
  ipcMain.handle(SOCIAL_PUBLISH_CHANNEL, async (event, value: unknown) => {
    assertTrustedDesktopSenderUrl(event.senderFrame?.url ?? '', trustedOrigin);
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('仅主界面可以操作发布');
    await loaded;
    if (!value || typeof value !== 'object') throw new Error('无效的发布请求');
    const r = value as PublishRequest;
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (!parent) throw new Error('发布主窗口不存在');
    if (r.action === 'snapshot') {
      const status = await capabilities();
      if (status.ready) await Promise.all(SOCIAL_PLATFORMS.map(p => refreshAccount(p.id)));
      return { jobs: jobs.map(j => ({ ...j })), bridge: status,
        accounts: SOCIAL_PLATFORMS.map(p => accounts.get(p.id) ?? (
          status.ready
            ? { platform: p.id, state: 'unchecked', windowOpen: false }
            : { platform: p.id, state: 'error', windowOpen: false, detail: status.detail }
        )),
      } satisfies PublishSnapshot;
    }
    if (r.action === 'connect') { const id = socialPlatform(r.platform).id; await (await requireReady()).request('aicut.openAccount', { platform: id }); checked.delete(id); return; }
    if (r.action === 'refresh-account') { const id = socialPlatform(r.platform).id; await requireReady(); await refreshAccount(id, true); return; }
    if (r.action === 'disconnect') throw new Error('请打开应用内的平台页面退出或切换账号，再刷新状态');
    if (r.action === 'choose-file') {
      const result = await dialog.showOpenDialog(parent, { title: '选择要发布的视频', properties: ['openFile'], filters: [{ name: '视频', extensions: ['mp4', 'mov', 'webm'] }] });
      return result.canceled ? null : grant(result.filePaths[0]);
    }
    if (r.action === 'export-file') {
      const target = await resolveExportRevealTarget(r.destinationId, r.filename, id => resolvePersistedExportDestination(join(root, 'export-destination.json'), id));
      if (!target?.candidate || dirname(await realpath(target.candidate).catch(() => '')) !== await realpath(target.directory).catch(() => 'unavailable')) throw new Error('导出文件不存在或超出授权目录，请重新选择');
      return grant(target.candidate);
    }
    if (r.action === 'prepare') {
      if (admission) throw new Error('正在创建任务，请勿重复点击');
      admission = true;
      try {
        const draft = validatePublishDraft(r.draft);
        for (const id of draft.platforms) await requireReady(id);
        const file = grants.get(draft.fileId);
        if (!file) throw new Error('视频选择已失效，请重新选择');
        await checkFile(file);
        if (draft.platforms.some(id => jobs.some(j => j.platform === id && (activePublishPhase(j.phase) || workers.has(j.id))))) throw new Error('所选平台还有未结束的任务');
        const created: PublishJob[] = draft.platforms.map(platform => ({ id: randomUUID(), platform, filename: file.name, title: draft.title,
          engine: 'geo', phase: 'preparing', detail: '正在打开平台页面并准备上传', createdAt: Date.now(), updatedAt: Date.now() }));
        jobs = [...created, ...jobs].slice(0, 100);
        await save();
        for (const job of created) void prepare(job, file, draft.description).catch(() => { job.phase = 'unknown'; job.detail = '本机记录保存失败，请到平台核对'; });
        await waitForPublishWindows(created, index => openedWindows.has(created[index].id), { closed: () => closed });
      } finally { admission = false; }
      return;
    }
    if (!['review', 'save-draft', 'cancel'].includes(r.action) || !('jobId' in r) || typeof r.jobId !== 'string') throw new Error('不支持此操作：仅支持保存草稿，不支持自动发布');
    const job = jobs.find(j => j.id === r.jobId);
    if (!job) throw new Error('发布任务不存在');
    if (job.engine !== 'geo') throw new Error('这是旧版上传记录，无法继续上传；请到原平台核对');
    const b = await requireReady(job.platform);
    if (r.action === 'review') { await b.request('aicut.reviewVideo', { jobId: job.id }); return; }
    if (r.action === 'cancel') {
      if (confirming.has(job.id) || job.phase === 'saving_draft' || job.phase === 'submitting') throw new Error('保存中的任务不能取消，请核对平台结果');
      await applyRemote(job, await b.request('aicut.cancelVideo', { jobId: job.id }));
      return;
    }
    if (job.phase !== 'review' || confirming.has(job.id)) throw new Error('此任务当前不能保存草稿');
    confirming.add(job.id);
    try {
      await b.request('aicut.reviewVideo', { jobId: job.id });
      const answer = await dialog.showMessageBox(parent, { type: 'question', title: '保存平台草稿',
        message: `保存到${socialPlatform(job.platform).name}草稿箱？`,
        detail: `视频：${job.filename}\n标题：${job.title}\n\n请核对平台窗口中的当前账号和文案。仅保存草稿，不会自动发布；最终发布由你在平台完成。`,
        buttons: ['返回核对', '保存草稿'], defaultId: 0, cancelId: 0, noLink: true });
      if (answer.response !== 1) return;
      await update(job, 'saving_draft', '已确认，正在保存到平台草稿；不会自动发布。');
      await applyRemote(job, await b.request('aicut.saveDraft', { jobId: job.id }));
      void observe(job);
    } catch (error) {
      if ((job as PublishJob).phase === 'saving_draft') await update(job, 'unknown', '草稿保存结果不确定，请到平台草稿箱核对；不会自动重试。');
      throw error;
    } finally { confirming.delete(job.id); }
  });
}
