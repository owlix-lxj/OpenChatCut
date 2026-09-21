import { publishPageScript, type PublishPageState } from './social-publish-page.ts';
import { SOCIAL_PLATFORMS, activePublishPhase, allowedPublishNavigation, socialPlatform, validatePublishDraft,
  type PublishPhase, type SocialPlatform } from '../shared/social-publish.ts';

type Tab = { id?: number; url?: string; status?: string };
type Target = { tabId: number };
export interface GeoVideoChrome {
  tabs: {
    create(options: { url: string; active: boolean }): Promise<Tab>;
    get(id: number): Promise<Tab>;
    update(id: number, options: { active: boolean }): Promise<Tab>;
    remove(id: number): Promise<void>;
  };
  debugger: {
    attach(target: Target, version: string): Promise<void>;
    detach(target: Target): Promise<void>;
    sendCommand(target: Target, method: string, params?: object): Promise<unknown>;
    onDetach: { addListener(listener: (target: { tabId?: number }) => void): void };
  };
  storage: { local: { get(key: string): Promise<Record<string, unknown>>; set(value: object): Promise<void> } };
}
export interface GeoVideoJob { id: string; platform: SocialPlatform; phase: PublishPhase; detail: string; revision: number; tabId?: number; windowOpened?: boolean }
type PrepareInput = { jobId: string; platform: SocialPlatform; path: string; title: string; description: string };
const STORE = 'aicutVideoJobs';

/** Electron errors cross the embedded VM boundary and fail instanceof Error. */
export function videoFailureDetail(error: unknown): string {
  const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message : '未返回具体错误';
  return message
    .replace(/\b(?:https?|wss?|file):\/\/[^\s"'<>]+/gi, '[地址已隐藏]')
    .replace(/(?:\/(?:Users|home|private|var)\/|[A-Za-z]:\\)[^\n"'<>]+/g, '[本机路径已隐藏]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[标识已隐藏]')
    .replace(/[\r\n\t]/g, ' ').slice(0, 400);
}

/** Video extension for the real GEO MCP client. It never reads or transfers browser cookies. */
export class GeoVideoAdapter {
  private chrome: GeoVideoChrome;
  private jobs = new Map<string, GeoVideoJob>();
  private retiredJobs: unknown[] = [];
  private attached = new Set<number>();
  private loaded: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private pollMs: number;
  private timeoutMs: number;
  private workers = new Set<string>();

  constructor(chrome: GeoVideoChrome, options: { pollMs?: number; timeoutMs?: number } = {}) {
    this.chrome = chrome;
    this.pollMs = options.pollMs ?? 1500;
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.loaded = this.restore();
    void this.loaded.catch(() => undefined);
    chrome.debugger.onDetach.addListener(({ tabId }) => {
      if (tabId == null || !this.attached.delete(tabId)) return;
      for (const job of this.jobs.values()) if (job.tabId === tabId && activePublishPhase(job.phase)) {
        void this.update(job, 'unknown', '浏览器调试连接已关闭，请到平台核对；不会自动重新提交。').catch(() => undefined);
      }
    });
  }
  private async restore() {
    const saved = (await this.chrome.storage.local.get(STORE))[STORE];
    if (saved !== undefined && !Array.isArray(saved)) throw new Error('平台上传记录损坏，请保留记录并重启应用检查');
    this.retiredJobs = ((saved ?? []) as Array<Record<string, unknown>>)
      .filter(row => row && row.platform === 'channels')
      .map(({ tabId: _tabId, ...row }) => row); // History only; never restore a retired platform's window.
    for (const row of (saved as GeoVideoJob[] | undefined) ?? []) {
      if (!row || typeof row.id !== 'string' || !SOCIAL_PLATFORMS.some(p => p.id === row.platform)
        || !['preparing', 'uploading', 'review', 'saving_draft', 'drafted', 'submitting', 'published', 'failed', 'cancelled', 'unknown'].includes(row.phase)) continue;
      // Window IDs are process-local and can be reused for an unrelated new task after restart.
      // Never restore a window handle or spread arbitrary persisted fields into a live job.
      this.jobs.set(row.id, { id: row.id, platform: row.platform, phase: row.phase,
        detail: typeof row.detail === 'string' ? row.detail.slice(0, 2000) : '请到平台核对任务记录',
        revision: (Number.isSafeInteger(row.revision) ? row.revision : 0) + 1,
        ...(activePublishPhase(row.phase)
          ? { phase: 'unknown' as const, detail: '应用内发布服务已重启，请核对原平台草稿或提交结果；不会自动重发。' } : {}) });
    }
    await this.persist();
  }
  private persist() {
    const rows = [...[...this.jobs.values()].map(({ tabId: _tabId, windowOpened: _windowOpened, ...record }) => record), ...this.retiredJobs];
    const write = this.writes.then(() => this.chrome.storage.local.set({ [STORE]: rows }));
    this.writes = write.catch(() => undefined);
    return write;
  }
  private async update(job: GeoVideoJob, phase: PublishPhase, detail: string) {
    // Cancellation/uncertain outcomes are terminal for the current worker.
    if ((job.phase === 'cancelled' || job.phase === 'unknown') && phase !== job.phase) return;
    Object.assign(job, { phase, detail, revision: job.revision + 1 });
    await this.persist();
  }
  private async tab(job: GeoVideoJob) {
    if (job.tabId == null) throw new Error('原平台页面不存在，请先核对平台草稿');
    const tab = await this.chrome.tabs.get(job.tabId);
    if (tab.status === 'loading' && (!tab.url || tab.url === 'about:blank')) return tab;
    if (!allowedPublishNavigation(job.platform, tab.url ?? '')) throw new Error('平台页面已离开受信创作者域名，已停止自动操作');
    return tab;
  }
  private async command<T>(job: GeoVideoJob, method: string, params?: object): Promise<T> {
    const tab = await this.tab(job);
    if (tab.status === 'loading') throw new Error('平台页面正在加载，请稍后核对');
    return await this.chrome.debugger.sendCommand({ tabId: job.tabId! }, method, params) as T;
  }
  private async evaluate<T>(job: GeoVideoJob, action: 'inspect' | 'fill' | 'save-draft', draft?: { title: string; description: string }): Promise<T> {
    const result = await this.command<{ result?: { value?: T }; exceptionDetails?: unknown }>(job, 'Runtime.evaluate', {
      expression: publishPageScript(job.platform, action, draft), returnByValue: true, awaitPromise: true,
      userGesture: action === 'save-draft',
    });
    if (result.exceptionDetails || result.result?.value === undefined) throw new Error('平台页面未就绪或结构已变化，请打开平台核对');
    return result.result.value;
  }
  private async detach(job: GeoVideoJob) {
    if (job.tabId == null || !this.attached.delete(job.tabId)) return;
    await this.chrome.debugger.detach({ tabId: job.tabId }).catch(() => undefined);
  }
  private async attach(job: GeoVideoJob) {
    await this.tab(job);
    if (this.attached.has(job.tabId!)) return;
    await this.chrome.debugger.attach({ tabId: job.tabId! }, '1.3');
    this.attached.add(job.tabId!);
  }
  private pause() { return new Promise(resolve => setTimeout(resolve, this.pollMs)); }
  private async prepare(job: GeoVideoJob, input: PrepareInput) {
    this.workers.add(job.id);
    let stage = '打开平台页面';
    try {
      const tab = await this.chrome.tabs.create({ url: socialPlatform(job.platform).url, active: false });
      if (tab.id == null) throw new Error('无法打开平台页面');
      job.tabId = tab.id;
      if (!activePublishPhase(job.phase)) return;
      await this.persist();
      const deadline = Date.now() + this.timeoutMs;
      let uploaded = false;
      while (Date.now() < deadline && ['preparing', 'uploading'].includes(job.phase)) {
        stage = '等待平台页面';
        const tab = await this.tab(job);
        if (tab.status === 'loading') { await this.pause(); continue; }
        if (!activePublishPhase(job.phase)) return;
        if (!job.windowOpened) {
          // Only acknowledge a trusted, loaded document after the native window is shown.
          await this.chrome.tabs.update(job.tabId!, { active: true });
          job.windowOpened = true;
          await this.update(job, job.phase, '平台页面已打开，正在准备上传。');
        }
        stage = '连接平台页面';
        await this.attach(job);
        stage = '识别上传表单';
        const page = await this.evaluate<PublishPageState>(job, 'inspect');
        if (!['preparing', 'uploading'].includes(job.phase)) return;
        if (page.login) {
          if (job.detail !== '请打开平台页面完成登录，完成后会继续上传。') {
            await this.update(job, 'preparing', '请打开平台页面完成登录，完成后会继续上传。');
            await this.chrome.tabs.update(job.tabId!, { active: true });
          }
        } else if (!uploaded && page.uploadSelector) {
          stage = '定位视频上传控件';
          const { root } = await this.command<{ root: { nodeId: number } }>(job, 'DOM.getDocument');
          const { nodeId } = await this.command<{ nodeId: number }>(job, 'DOM.querySelector', { nodeId: root.nodeId, selector: page.uploadSelector });
          if (!nodeId) throw new Error('未找到视频上传控件');
          await this.update(job, 'uploading', '正在通过浏览器上传视频；请保持应用与浏览器开启，断连后先核对平台草稿。');
          if (job.phase !== 'uploading') return;
          // Keep the real upload page visible for platform progress, challenges and required fields.
          // Some creator widgets defer initialization while their document is hidden.
          await this.chrome.tabs.update(job.tabId!, { active: true });
          // The native app supplies only paths granted by its file picker/export directory.
          stage = '指定视频文件';
          await this.command(job, 'DOM.setFileInputFiles', { nodeId, files: [input.path] });
          uploaded = true;
        } else if (uploaded && page.failed) {
          throw new Error('平台提示上传或转码失败，请检查视频与网络');
        } else if (uploaded && page.ready) {
          stage = '填写视频文案';
          const filled = await this.evaluate<boolean>(job, 'fill', input);
          await this.update(job, 'review', filled ? '视频已上传并填写文案，请核对后保存到平台草稿；不会自动发布。'
            : '视频已上传；请在平台页补全文案后保存草稿；不会自动发布。');
          await this.chrome.tabs.update(job.tabId!, { active: true });
          return;
        }
        await this.pause();
      }
      if (['preparing', 'uploading'].includes(job.phase)) throw new Error('等待上传超时，请核对平台草稿；不会自动重传');
    } catch (error) {
      await this.update(job, 'failed', `视频上传失败（${stage}）：${videoFailureDetail(error)}`).catch(() => undefined);
    } finally {
      this.workers.delete(job.id);
      if (job.phase !== 'review') await this.detach(job);
    }
  }
  private async observeDraft(job: GeoVideoJob) {
    this.workers.add(job.id);
    try {
      const deadline = Date.now() + Math.min(this.timeoutMs, 90_000);
      while (Date.now() < deadline && job.phase === 'saving_draft') {
        const page = await this.evaluate<PublishPageState>(job, 'inspect');
        if (page.draftSaved) { await this.update(job, 'drafted', '平台已确认保存草稿，未执行发布。'); return; }
        if (page.failed) break;
        await this.pause();
      }
      await this.update(job, 'unknown', '未确认草稿保存结果，请到平台草稿箱核对；不会自动重试。');
    } catch {
      await this.update(job, 'unknown', '平台页面中断，草稿保存结果待核对；不会自动重试。').catch(() => undefined);
    } finally { this.workers.delete(job.id); await this.detach(job); }
  }

  async handle(method: string, value: unknown): Promise<GeoVideoJob> {
    if (method === 'aicut.submitVideo') throw new Error('自动发布已禁用，仅支持保存草稿');
    await this.loaded;
    if (!value || typeof value !== 'object') throw new Error('无效的视频请求');
    const input = value as PrepareInput;
    if (typeof input.jobId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(input.jobId)) throw new Error('无效任务编号');
    if (method === 'aicut.prepareVideo') {
      const previous = this.jobs.get(input.jobId);
      if (previous) return { ...previous }; // deduplication, never re-upload after an uncertain RPC outcome
      const { platforms } = validatePublishDraft({ fileId: input.jobId, platforms: [input.platform], title: input.title, description: input.description });
      if (typeof input.path !== 'string' || !/^(\/|[A-Za-z]:[\\/])/.test(input.path) || /[\x00\r\n]/.test(input.path)
        || !/\.(mp4|mov|webm)$/i.test(input.path)) throw new Error('无效的本机视频授权路径');
      if ([...this.jobs.values()].some(job => job.platform === input.platform && (activePublishPhase(job.phase) || this.workers.has(job.id)))) throw new Error('此平台还有未结束的任务');
      // Keep deduplication records, but bound storage. A full store fails closed, never forgets a recent submit.
      if (this.jobs.size >= 1000) throw new Error('发布记录已满，请先归档记录');
      const job: GeoVideoJob = { id: input.jobId, platform: platforms[0], phase: 'preparing', detail: '正在打开平台视频上传页', revision: 0 };
      this.jobs.set(job.id, job);
      await this.persist();
      void this.prepare(job, input);
      return { ...job };
    }
    const job = this.jobs.get(input.jobId);
    if (!job) throw new Error('未找到此上传任务，请到平台核对原草稿');
    if (method === 'aicut.videoStatus') return { ...job };
    if (method === 'aicut.reviewVideo') { await this.tab(job); await this.chrome.tabs.update(job.tabId!, { active: true }); return { ...job }; }
    if (method === 'aicut.cancelVideo') {
      if (job.phase === 'submitting' || job.phase === 'saving_draft') throw new Error('保存中的任务不可取消，请到平台核对');
      if (activePublishPhase(job.phase)) await this.update(job, 'cancelled', '已停止任务；平台已上传草稿未删除。');
      await this.detach(job);
      return { ...job };
    }
    if (method === 'aicut.saveDraft') {
      if (job.phase !== 'review') throw new Error('此任务当前不能保存草稿');
      // Claim in memory synchronously and persist before doing any external click.
      await this.update(job, 'saving_draft', '正在保存到平台草稿，请勿重复操作。');
      try {
        await this.attach(job);
        const page = await this.evaluate<PublishPageState>(job, 'inspect');
        if (!page.ready || page.success || page.draftSaved) throw new Error('平台未就绪或已有成功提示，请先核对结果');
        await this.evaluate(job, 'save-draft');
        void this.observeDraft(job);
      } catch {
        await this.update(job, 'unknown', '无法确认草稿已保存，请打开平台草稿箱核对；不会点击发布或自动重试。');
        await this.detach(job);
      }
      return { ...job };
    }
    throw new Error('未知的视频操作');
  }
}
