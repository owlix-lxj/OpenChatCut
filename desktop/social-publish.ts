import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import { assertTrustedDesktopSenderUrl } from './page-origin.ts';
import { resolveExportRevealTarget } from './export-reveal.ts';
import { resolvePersistedExportDestination } from './export-directory-state.ts';
import {
  SOCIAL_PUBLISH_CHANNEL, SOCIAL_PLATFORMS, activePublishPhase, allowedPublishNavigation,
  socialPlatform, validatePublishDraft,
  type PublishFile, type PublishJob, type PublishPhase, type PublishRequest, type PublishSnapshot, type SocialPlatform,
} from '../shared/social-publish.ts';
import { publishPageScript, type PublishPageState } from './social-publish-page.ts';
import { loadPublishCreator } from './social-publish-navigation.ts';

type FileGrant = PublishFile & { path: string; mtime: number };
type AccountState = PublishSnapshot['accounts'][number]['state'];
const pause = () => new Promise(resolve => setTimeout(resolve, 1500));
const partition = (id: SocialPlatform) => `persist:aicut-publisher-${id}`;

export function installSocialPublish(trustedOrigin: string): void {
  const statePath = join(app.getPath('userData'), 'social-publish-jobs.json');
  const grants = new Map<string, FileGrant>();
  const windows = new Map<SocialPlatform, BrowserWindow>();
  const readyWindows = new WeakSet<BrowserWindow>();
  const loadingWindows = new WeakMap<BrowserWindow, Promise<void>>();
  const accountStates = new Map<SocialPlatform, AccountState>();
  const workers = new Set<SocialPlatform>();
  const confirming = new Set<string>();
  let jobs: PublishJob[] = [];
  let writes: Promise<void> = Promise.resolve();
  let admission = false;
  const loaded = readFile(statePath, 'utf8').then(raw => {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('发布记录格式损坏');
    jobs = data.slice(0, 100).filter((j): j is PublishJob => !!j && typeof j === 'object'
      && typeof j.id === 'string' && typeof j.title === 'string' && typeof j.filename === 'string'
      && typeof j.detail === 'string' && typeof j.createdAt === 'number' && typeof j.updatedAt === 'number'
      && SOCIAL_PLATFORMS.some(p => p.id === j.platform)
      && ['preparing', 'uploading', 'review', 'submitting', 'published', 'failed', 'cancelled', 'unknown'].includes(j.phase))
      .map(j => activePublishPhase(j.phase) ? { ...j, phase: 'unknown', detail: '应用已重启，请先到平台核对结果；不会自动重发。' } : j);
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw new Error('读取发布记录失败，请保留记录文件并检查磁盘');
  });
  // The promise is also awaited by every IPC operation; avoid an unhandled startup rejection.
  void loaded.catch(() => undefined);

  function save(): Promise<void> {
    const raw = JSON.stringify(jobs.slice(0, 100));
    const write = writes.then(async () => {
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(`${statePath}.tmp`, raw, { mode: 0o600 });
      await rename(`${statePath}.tmp`, statePath);
    });
    writes = write.catch(() => undefined);
    return write;
  }
  async function update(job: PublishJob, phase: PublishPhase, detail: string) {
    if (job.phase === 'cancelled' && phase !== 'cancelled') return;
    Object.assign(job, { phase, detail, updatedAt: Date.now() });
    await save();
  }
  function openWindow(id: SocialPlatform, visible: boolean): BrowserWindow {
    const existing = windows.get(id);
    if (existing && !existing.isDestroyed()) {
      if (visible) { existing.show(); existing.focus(); }
      return existing;
    }
    const p = socialPlatform(id);
    const profile = session.fromPartition(partition(id));
    profile.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    profile.setPermissionCheckHandler(() => false);
    const win = new BrowserWindow({ width: 1120, height: 800, show: visible, title: `AI-cut · ${p.name}发布`,
      webPreferences: { session: profile, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false },
    });
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guard = (event: { preventDefault(): void }, url: string) => {
      if (!allowedPublishNavigation(id, url)) event.preventDefault();
    };
    win.webContents.on('will-navigate', guard);
    win.webContents.on('will-redirect', guard);
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.webContents.on('did-finish-load', () => {
      void inspect(id, win).catch(() => undefined);
    });
    win.on('closed', () => { windows.delete(id); });
    windows.set(id, win);
    return win;
  }
  async function inspect(id: SocialPlatform, win: BrowserWindow): Promise<PublishPageState> {
    if (!allowedPublishNavigation(id, win.webContents.getURL())) throw new Error('平台页面未加载完成');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let state: PublishPageState;
    try {
      state = await Promise.race([
        win.webContents.executeJavaScript(publishPageScript(id, 'inspect')) as Promise<PublishPageState>,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('平台页面未响应')), 5000); }),
      ]);
    } finally { clearTimeout(timer); }
    accountStates.set(id, state.login ? 'login_required' : (state.uploadSelector || state.ready) ? 'available' : 'unchecked');
    return state;
  }
  function loadCreator(id: SocialPlatform, win: BrowserWindow): Promise<void> {
    const existing = loadingWindows.get(win);
    if (existing) return existing;
    readyWindows.delete(win);
    const loading = loadPublishCreator(id, win)
      .then(() => { readyWindows.add(win); })
      .finally(() => { loadingWindows.delete(win); });
    loadingWindows.set(win, loading);
    return loading;
  }
  async function grant(path: string): Promise<PublishFile> {
    const canonical = await realpath(path).catch(() => { throw new Error('视频文件不存在或无权读取，请重新选择'); });
    const info = await stat(canonical).catch(() => { throw new Error('视频文件不可读取'); });
    if (!['.mp4', '.mov', '.webm'].includes(extname(canonical).toLowerCase()) || !info.isFile() || info.size <= 0)
      throw new Error('请选择非空的 MP4、MOV 或 WebM 视频');
    if (grants.size >= 100) grants.delete(grants.keys().next().value!);
    const file = { id: randomUUID(), name: basename(canonical), size: info.size, path: canonical, mtime: info.mtimeMs };
    grants.set(file.id, file);
    return { id: file.id, name: file.name, size: file.size };
  }
  async function checkFile(file: FileGrant) {
    const info = await stat(file.path).catch(() => null);
    if (!info || !info.isFile() || info.size !== file.size || info.mtimeMs !== file.mtime || await realpath(file.path).catch(() => '') !== file.path)
      throw new Error('视频文件已改变，请重新选择');
  }
  async function prepare(job: PublishJob, file: FileGrant, description: string) {
    const id = job.platform;
    workers.add(id);
    let win: BrowserWindow | undefined;
    try {
      await checkFile(file);
      if (!activePublishPhase(job.phase)) return;
      win = openWindow(id, false);
      // Hide an existing login window only after the user explicitly starts preparation.
      win.hide();
      await loadCreator(id, win);
      let uploaded = false;
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline && activePublishPhase(job.phase)) {
        if (win.isDestroyed()) throw new Error('平台窗口已关闭');
        const page = await inspect(id, win);
        if (page.login) {
          win.show();
          if (job.detail !== '请在平台窗口完成登录，完成后自动继续。') await update(job, 'preparing', '请在平台窗口完成登录，完成后自动继续。');
        } else if (!uploaded && page.uploadSelector) {
          await checkFile(file);
          const cdp = win.webContents.debugger;
          cdp.attach('1.3');
          try {
            const { root } = await cdp.sendCommand('DOM.getDocument');
            const { nodeId } = await cdp.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: page.uploadSelector });
            if (!nodeId) throw new Error('未找到视频上传入口');
            await update(job, 'uploading', '正在上传视频到平台；关闭 AI-cut 会中断上传。');
            if (job.phase !== 'uploading') return;
            await cdp.sendCommand('DOM.setFileInputFiles', { nodeId, files: [file.path] });
            uploaded = true;
          } finally { if (cdp.isAttached()) cdp.detach(); }
        } else if (uploaded && page.failed) {
          throw new Error('平台提示上传失败，请检查视频格式和网络');
        } else if (uploaded && page.ready) {
          const filled = await win.webContents.executeJavaScript(publishPageScript(id, 'fill', { title: job.title, description }));
          if (job.phase === 'cancelled') return;
          await update(job, 'review', filled
            ? '视频已上传并填写文案，请核对账号、封面和声明后确认发布。'
            : '视频已上传；部分表单无法自动填写，请在平台窗口核对并补全标题、正文和封面。');
          win.show();
          return;
        }
        await pause();
      }
      if (job.phase !== 'cancelled') throw new Error('等待平台超时。请检查登录或页面变化；不会自动重试上传。');
    } catch (error) {
      if (job.phase !== 'cancelled') {
        await update(job, 'failed', error instanceof Error ? error.message : '上传准备失败');
        if (win && !win.isDestroyed()) win.show();
      }
    } finally { workers.delete(id); }
  }

  ipcMain.handle(SOCIAL_PUBLISH_CHANNEL, async (event, value: unknown) => {
    assertTrustedDesktopSenderUrl(event.senderFrame?.url ?? '', trustedOrigin);
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('仅主界面可以操作发布');
    await loaded;
    if (!value || typeof value !== 'object') throw new Error('无效的发布请求');
    const r = value as PublishRequest;
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (r.action === 'snapshot') {
      await Promise.all([...windows].map(([id, win]) => inspect(id, win).catch(() => undefined)));
      return {
      jobs: jobs.map(j => ({ ...j })),
      accounts: SOCIAL_PLATFORMS.map(p => ({ platform: p.id, state: accountStates.get(p.id) ?? 'unchecked', windowOpen: windows.has(p.id) })),
      } satisfies PublishSnapshot;
    }
    if (r.action === 'connect') {
      const p = socialPlatform(r.platform);
      const win = openWindow(p.id, true);
      if (!readyWindows.has(win)) await loadCreator(p.id, win);
      else await inspect(p.id, win).catch(() => undefined);
      return;
    }
    if (r.action === 'disconnect') {
      const id = socialPlatform(r.platform).id;
      if (workers.has(id) || jobs.some(j => j.platform === id && activePublishPhase(j.phase))) throw new Error('请先结束此平台的发布任务');
      const choice = await dialog.showMessageBox(parent!, { type: 'question', message: `清除${socialPlatform(id).name}的本机登录信息？`, buttons: ['保留', '清除登录'], defaultId: 0, cancelId: 0 });
      if (choice.response !== 1) return;
      if (workers.has(id) || jobs.some(j => j.platform === id && activePublishPhase(j.phase))) throw new Error('请先结束此平台的发布任务');
      workers.add(id);
      try {
        windows.get(id)?.destroy();
        await session.fromPartition(partition(id)).clearStorageData();
        accountStates.set(id, 'unchecked');
      } finally { workers.delete(id); }
      return;
    }
    if (r.action === 'choose-file') {
      const result = await dialog.showOpenDialog(parent!, { title: '选择要发布的视频', properties: ['openFile'], filters: [{ name: '视频', extensions: ['mp4', 'mov', 'webm'] }] });
      return result.canceled ? null : grant(result.filePaths[0]);
    }
    if (r.action === 'export-file') {
      const target = await resolveExportRevealTarget(r.destinationId, r.filename,
        id => resolvePersistedExportDestination(join(app.getPath('userData'), 'export-destination.json'), id));
      if (!target?.candidate || dirname(await realpath(target.candidate).catch(() => '')) !== await realpath(target.directory).catch(() => 'unavailable'))
        throw new Error('导出文件不存在或超出授权目录，请重新选择视频');
      return grant(target.candidate);
    }
    if (r.action === 'prepare') {
      if (admission) throw new Error('正在创建发布任务，请勿重复点击');
      admission = true;
      try {
        const draft = validatePublishDraft(r.draft);
        const file = grants.get(draft.fileId);
        if (!file) throw new Error('视频选择已失效，请重新选择');
        await checkFile(file);
        if (draft.platforms.some(id => workers.has(id) || jobs.some(j => j.platform === id && activePublishPhase(j.phase))))
          throw new Error('所选平台还有未结束的任务，请先完成或取消');
        const created: PublishJob[] = draft.platforms.map(platform => ({ id: randomUUID(), platform, filename: file.name, title: draft.title,
          phase: 'preparing' as const, detail: '正在打开平台上传页', createdAt: Date.now(), updatedAt: Date.now() }));
        jobs = [...created, ...jobs].slice(0, 100);
        await save();
        for (const job of created) void prepare(job, file, draft.description).catch(() => { job.phase = 'failed'; job.detail = '本机发布记录保存失败，请检查磁盘'; });
      } finally { admission = false; }
      return;
    }
    if (!['review', 'cancel'].includes(r.action) || !('jobId' in r) || typeof r.jobId !== 'string') throw new Error('旧版发布通道已禁用，请使用 GEO 保存草稿');
    const job = jobs.find(j => j.id === r.jobId);
    if (!job) throw new Error('发布任务不存在');
    if (r.action === 'cancel') {
      if (confirming.has(job.id) || job.phase === 'submitting') throw new Error('提交中的任务不能撤销，请到平台核对结果');
      if (!activePublishPhase(job.phase)) return;
      await update(job, 'cancelled', '已停止本机任务；平台可能保留已上传的草稿，未主动删除。');
      windows.get(job.platform)?.destroy();
      return;
    }
    if (r.action === 'review') {
      const win = openWindow(job.platform, true);
      if (!readyWindows.has(win)) await loadCreator(job.platform, win);
      return;
    }
    throw new Error('旧版发布通道已禁用，请使用 GEO 保存草稿');
  });
}
