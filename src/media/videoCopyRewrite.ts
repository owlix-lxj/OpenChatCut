import { platformManagedClient } from '../platform/platformIntegration';
import { transcribePath } from '../transcript/provider';
import { extractSharedVideoUrl, videoLinkPlatform, VIDEO_LINK_PLATFORM_LABELS } from '../../shared/video-link-resolver';

export interface ImportedRewriteVideo {
  readonly path: string;
  readonly name: string;
}

interface ImportResponse {
  readonly ok?: boolean;
  readonly path?: string;
  readonly name?: string;
  readonly filename?: string;
  readonly error?: string;
  readonly detail?: string;
}

interface LocalAsrModelState {
  readonly id?: string;
  readonly downloaded?: boolean;
  readonly sizeLabel?: string;
  readonly task?: {
    readonly status?: string;
    readonly bytesDone?: number;
    readonly bytesTotal?: number;
    readonly error?: string;
  };
}

function preferredLocalModelId(): string {
  // Link-to-copy extraction is an accuracy-first workflow. Always use the
  // desktop-bundled full Large v3 model instead of inheriting an older, smaller
  // model preference from Settings.
  return 'large-v3-turbo';
}

function percent(done = 0, total = 0): number {
  return total > 0 ? Math.min(100, Math.max(0, Math.round((done / total) * 100))) : 0;
}

async function localModelState(id: string): Promise<LocalAsrModelState> {
  const response = await fetch('/api/asr-models', { cache: 'no-store' });
  if (!response.ok) throw new Error(`无法读取本地转写模型（HTTP ${response.status}）`);
  const body = await response.json() as { models?: readonly LocalAsrModelState[] };
  const model = body.models?.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`未找到本地转写模型：${id}`);
  return model;
}

/** Install the selected open-source Whisper model on first use. Subsequent
 * extractions stay offline and never need an ASR API credential. */
export async function ensureLocalCopyModel(onProgress?: (message: string) => void): Promise<void> {
  const id = preferredLocalModelId();
  let state = await localModelState(id);
  if (state.downloaded) return;
  onProgress?.(`首次使用：正在准备本地 Whisper ${state.sizeLabel ?? ''}…`);
  if (state.task?.status !== 'downloading') {
    const response = await fetch('/api/asr-models/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(body.error ?? `本地模型下载启动失败（HTTP ${response.status}）`);
  }
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    state = await localModelState(id);
    if (state.downloaded) return;
    if (state.task?.status === 'done') {
      throw new Error('本地 Whisper 模型下载完成但完整性校验失败，请重试下载');
    }
    if (state.task?.status === 'error') {
      throw new Error(`本地 Whisper 模型准备失败：${state.task.error ?? '下载失败'}`);
    }
    onProgress?.(`首次使用：正在下载本地 Whisper ${percent(state.task?.bytesDone, state.task?.bytesTotal)}%…`);
  }
}

export function extractVideoLink(value: string): string | null {
  return extractSharedVideoUrl(value);
}

export function isDouyinVideoLink(value: string): boolean {
  const link = extractVideoLink(value);
  if (!link) return false;
  try {
    const host = new URL(link).hostname.toLowerCase();
    return host === 'douyin.com' || host.endsWith('.douyin.com')
      || host === 'iesdouyin.com' || host.endsWith('.iesdouyin.com');
  } catch {
    return false;
  }
}

function isDirectVideoFileLink(value: string): boolean {
  try {
    return /\.(?:mp4|mov|m4v|webm|m3u8)(?:$|\?)/i.test(new URL(value).pathname + new URL(value).search);
  } catch {
    return false;
  }
}

async function responseBody(response: Response): Promise<ImportResponse> {
  return response.json().catch(() => ({})) as Promise<ImportResponse>;
}

export async function importVideoForCopy(value: string): Promise<ImportedRewriteVideo> {
  const link = extractVideoLink(value);
  if (!link) throw new Error('请输入有效的视频链接');
  const douyin = isDouyinVideoLink(link);
  if (douyin && !platformManagedClient()) {
    throw new Error('抖音链接解析仅在 AI-cut 平台版可用');
  }
  let importedUrl = link;
  let importedName = 'video-copy-source';
  // Electron can execute Douyin's current security bootstrap in a disposable
  // Chromium partition. Prefer that over the legacy server-side HTML parser.
  if (window.openChatCutDesktop?.resolveVideoLink && !isDirectVideoFileLink(link)) {
    const resolved = await window.openChatCutDesktop.resolveVideoLink(value);
    if (resolved.path) return { path: resolved.path, name: resolved.name };
    importedUrl = resolved.url!;
    importedName = resolved.name;
  }
  const useLegacyDouyinImport = douyin && importedUrl === link;
  const response = await fetch(useLegacyDouyinImport ? '/api/platform/import-douyin' : '/api/import-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(useLegacyDouyinImport
      ? { shareText: value, registerMaterial: false }
      : { url: importedUrl, name: importedName }),
  });
  const body = await responseBody(response);
  if (!response.ok || body.ok === false || !body.path) {
    throw new Error(body.error ?? body.detail ?? `视频解析失败（HTTP ${response.status}）`);
  }
  return { path: body.path, name: body.name ?? body.filename ?? '链接视频' };
}

export async function extractVideoCopy(
  value: string,
  onProgress?: (message: string) => void,
): Promise<{ video: ImportedRewriteVideo; text: string }> {
  onProgress?.(`正在解析并下载${VIDEO_LINK_PLATFORM_LABELS[videoLinkPlatform(value)]}…`);
  const video = await importVideoForCopy(value);
  await ensureLocalCopyModel(onProgress);
  onProgress?.('正在使用本地 Whisper 识别视频语音…');
  const transcript = await transcribePath(video.path, (note) => onProgress?.(note || '本地正在识别视频语音…'), {
    languageCode: 'zh',
    diarize: false,
    localModelTier: 'large-v3-turbo',
  }, 'local');
  const text = transcript.text.trim() || transcript.words.map((word) => word.text).join('').trim();
  if (!text) throw new Error('没有从视频中识别到可用文案');
  return { video, text };
}
