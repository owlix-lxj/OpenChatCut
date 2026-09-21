import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SOCIAL_PLATFORMS, activePublishPhase, validatePublishDraft, type PublishFile, type PublishPhase, type PublishSnapshot, type SocialPlatform } from '../../shared/social-publish';
import { listExportHistory, type ExportRecord } from '../persist/exportHistoryStore';
import './socialPublish.css';

const PHASE: Record<PublishPhase, string> = { preparing: '准备中', uploading: '上传中', review: '待核对并保存', saving_draft: '保存草稿中', drafted: '已保存草稿', submitting: '旧版提交记录', published: '旧版已提交记录', failed: '准备失败', cancelled: '已取消', unknown: '结果待核对' };
const ACCOUNT = { unchecked: '正在检查账号', login_required: '未登录', available: '已登录', saved: '登录状态待验证', error: '账号信息暂未获取', manual: '请在平台核对账号' };

function PlatformOpeningOverlay() {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  // A native modal occupies the top layer and makes the editor/export dialog inert.
  return createPortal(<dialog ref={dialog} className="cc-platform-opening" aria-labelledby="cc-platform-opening-title"
    onCancel={event => event.preventDefault()} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <div role="status" aria-live="polite">
      <div className="cc-platform-opening-motion" aria-hidden="true"><i /><i /><i /></div>
      <h2 id="cc-platform-opening-title">正在打开平台页面</h2>
      <p>请稍候，页面打开后将继续上传视频</p>
    </div>
  </dialog>, document.body);
}

export function SocialPublishPanel({ projectName }: { projectName: string }) {
  const api = window.openChatCutDesktop?.socialPublish;
  const [snapshot, setSnapshot] = useState<PublishSnapshot>({ accounts: [], jobs: [] });
  const [file, setFile] = useState<PublishFile | null>(null);
  const [history, setHistory] = useState<ExportRecord[]>([]);
  const [platforms, setPlatforms] = useState<SocialPlatform[]>([]);
  const [title, setTitle] = useState(projectName);
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const operation = useRef(false);
  const phases = useRef(new Map<string, PublishPhase>());
  const applySnapshot = useCallback((result: PublishSnapshot) => {
    // Keep completion/failure feedback without rendering a task history module.
    const completed = result.jobs.filter(job => {
      const previous = phases.current.get(job.id);
      return previous && activePublishPhase(previous) && !activePublishPhase(job.phase);
    });
    const message = (jobs: typeof completed) => jobs.map(job => `${SOCIAL_PLATFORMS.find(p => p.id === job.platform)?.name}：${job.detail}`).join('；');
    const failed = completed.filter(job => job.phase === 'failed' || job.phase === 'unknown');
    if (failed.length) setError(message(failed));
    const finished = completed.filter(job => job.phase === 'drafted' || job.phase === 'cancelled');
    if (finished.length) setNotice(message(finished));
    phases.current = new Map(result.jobs.map(job => [job.id, job.phase]));
    setSnapshot(result);
  }, []);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (!api) return;
      try {
        const result = await api.snapshot();
        if (!disposed) applySnapshot(result);
      } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : '读取发布状态失败'); }
      if (!disposed) timer = setTimeout(() => void refresh(), 2000);
    }
    void refresh();
    void listExportHistory().then(rows => { if (!disposed) setHistory(rows.filter(r => r.destinationId && /\.(mp4|mov|webm)$/i.test(r.name))); });
    return () => { disposed = true; clearTimeout(timer); };
  }, [api, applySnapshot]);
  const run = async (action: () => Promise<unknown>) => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); if (api) applySnapshot(await api.snapshot()); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败，请重试'); }
    finally { setBusy(false); operation.current = false; }
  };
  return <main className="cc-export-main cc-publish" role="tabpanel" id="cc-export-content-publish" aria-labelledby="cc-export-tab-publish">
    <div className="cc-export-main-header"><div><h3>保存到平台草稿</h3><p>选择视频 → 上传 → 核对并保存草稿，不自动发布</p></div></div>
    <div className="cc-publish-scroll">
      {!api ? <p role="status">此功能需要新版 AI-cut 桌面端。请完成开发版构建并重启应用。</p> : <>
        {!snapshot.bridge?.ready && <p role="status">平台连接暂未就绪，请重新安装包含发布组件的新版 AI-cut。</p>}
        <section aria-label="发布账号" className="cc-publish-section">
          <h4>1. 选择平台与账号</h4>
          <p>在应用内登录平台，已有登录会话会保留。账号信息会自动刷新，也可点击「刷新状态」。</p>
          {SOCIAL_PLATFORMS.map(p => {
            const account = snapshot.accounts.find(a => a.platform === p.id);
            const active = snapshot.jobs.find(j => j.platform === p.id && activePublishPhase(j.phase));
            return <div key={p.id}>
              <div className="cc-publish-account">
                <label><input type="checkbox" checked={platforms.includes(p.id)} disabled={busy || !!active || !snapshot.bridge?.videoPlatforms.includes(p.id)}
                  onChange={e => setPlatforms(ids => e.target.checked ? [...ids, p.id] : ids.filter(id => id !== p.id))} />
                  <span>{p.name}<small>{account?.username ? `${account.username} · ` : ''}{ACCOUNT[account?.state ?? 'unchecked']}</small>{account?.detail && <small>{account.detail}</small>}</span></label>
                <button type="button" disabled={busy || !snapshot.bridge?.ready} onClick={() => void run(() => api.connect(p.id))}>{account?.state === 'available' ? '查看账号' : account?.state === 'login_required' ? '登录账号' : '核对账号'}</button>
                <button type="button" disabled={busy || !snapshot.bridge?.ready} onClick={() => void run(() => api.refreshAccount(p.id))}>刷新状态</button>
              </div>
              {active?.engine === 'geo' && <div className="cc-publish-progress">
                <p role="status">{PHASE[active.phase]} · {active.detail}</p>
                <div className="cc-publish-actions">
                  <button type="button" disabled={busy || !snapshot.bridge?.ready} onClick={() => void run(() => api.review(active.id))}>查看平台窗口</button>
                  {active.phase === 'review' && <button type="button" className="cc-publish-primary" disabled={busy || !snapshot.bridge?.ready} onClick={() => void run(() => api.saveDraft(active.id))}>核对并保存草稿</button>}
                  {active.phase !== 'submitting' && active.phase !== 'saving_draft' && <button type="button" disabled={busy || !snapshot.bridge?.ready} onClick={() => void run(() => api.cancel(active.id))}>取消上传</button>}
                </div>
              </div>}
            </div>;
          })}
        </section>
        <section aria-label="待发布视频" className="cc-publish-section">
          <h4>2. 视频与文案</h4>
          <div className="cc-publish-file"><span>{file ? `${file.name} · ${(file.size / 1048576).toFixed(1)} MB` : '请先在「成片」中导出，或选择已有视频'}</span>
            <button type="button" disabled={busy} onClick={() => void run(async () => { const chosen = await api.chooseFile(); if (chosen) setFile(chosen); })}>选择视频</button></div>
          {history.length > 0 && <label>最近导出<select value="" disabled={busy} onChange={e => {
            const row = history.find(r => r.id === e.target.value);
            if (row?.destinationId) void run(async () => setFile(await api.exportFile(row.destinationId!, row.name)));
          }}><option value="">从本机导出记录选择…</option>{history.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}
          <label>标题<input value={title} maxLength={60} disabled={busy} onChange={e => setTitle(e.target.value)} placeholder="填写视频标题" /></label>
          <p>抖音最多 30 字，小红书最多 20 字。</p>
          <label>正文<textarea rows={4} value={description} maxLength={1000} disabled={busy} onChange={e => setDescription(e.target.value)} placeholder="介绍视频内容；话题、封面和内容声明可在平台页核对" /></label>
          <p>上传后核对账号与文案，再保存到平台草稿箱；最终发布由你在平台自行完成。</p>
          <div className="cc-publish-submit">
            <button type="button" className="cc-publish-primary" disabled={busy || !file || !platforms.length || !snapshot.bridge?.ready || platforms.some(id => !snapshot.bridge?.videoPlatforms.includes(id) || snapshot.jobs.some(j => j.platform === id && activePublishPhase(j.phase)))}
              onClick={() => void run(async () => {
                const draft = validatePublishDraft({ fileId: file?.id, platforms, title, description });
                setOpening(true);
                try { await api.prepare(draft); }
                finally { setOpening(false); }
              })}>
              {busy ? '正在处理…' : '上传并准备草稿'}
            </button>
          </div>
        </section>
        {error && <p className="cc-export-error" role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
      </>}
    </div>
    {opening && <PlatformOpeningOverlay />}
  </main>;
}
