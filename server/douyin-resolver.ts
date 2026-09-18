// Resolve a Douyin (抖音) share link to a watermark-free video URL and its caption text.
//
// Mechanism (no API key needed): a share link redirects to a page whose id we read, then the
// share render endpoint embeds a `window._ROUTER_DATA = {…}` JSON blob with the play address.
// The watermarked address contains `playwm`; swapping it for `play` yields the clean stream.
//
// Everything fetched here is UNTRUSTED third-party data: only Douyin share hosts are contacted,
// responses are size- and time-bounded, and the parsed shape is validated defensively.

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) EdgiOS/121.0.2277.107 Version/17.0 Mobile/15E148 Safari/604.1';

const SHARE_HOSTS = new Set([
  'v.douyin.com', 'www.douyin.com', 'douyin.com', 'www.iesdouyin.com', 'iesdouyin.com',
]);

const MAX_HTML_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

export interface DouyinVideo {
  /** Watermark-free progressive video URL (playwm→play). */
  videoUrl: string;
  /** The post caption (desc) — this is the "文案". */
  title: string;
  videoId: string;
  coverUrl?: string;
}

export class DouyinResolveError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'DouyinResolveError';
  }
}

/** The first http(s) URL embedded in a pasted share blob ("7.98 xyz https://v.douyin.com/… 复制"). */
export function extractFirstUrl(shareText: string): string | null {
  const match = String(shareText ?? '').match(/https?:\/\/[^\s"'<>）)]+/);
  return match ? match[0] : null;
}

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

/** Whether a URL points at a Douyin share host this resolver is willing to contact. */
export function isDouyinShareUrl(url: string): boolean {
  const host = hostOf(url);
  return host != null && (SHARE_HOSTS.has(host) || host.endsWith('.douyin.com') || host.endsWith('.iesdouyin.com'));
}

/** Whether a pasted blob contains a Douyin share link. */
export function containsDouyinShare(shareText: string): boolean {
  const url = extractFirstUrl(shareText);
  return url != null && isDouyinShareUrl(url);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Pure parse of the share-render HTML for a known video id. Exposed for testing without network.
 * Throws DouyinResolveError('parse', …) when the embedded data is missing or shaped unexpectedly.
 */
export function parseRouterData(html: string, videoId: string): DouyinVideo {
  const match = /window\._ROUTER_DATA\s*=\s*(\{.*?\})<\/script>/s.exec(html);
  if (!match?.[1]) throw new DouyinResolveError('parse', '无法从抖音页面解析视频信息（页面结构可能已变化）');
  let data: unknown;
  try { data = JSON.parse(match[1]); } catch { throw new DouyinResolveError('parse', '抖音视频信息 JSON 解析失败'); }
  const loaderData = asRecord(asRecord(data)?.loaderData);
  if (!loaderData) throw new DouyinResolveError('parse', '抖音页面缺少 loaderData');
  const page = asRecord(loaderData['video_(id)/page']) ?? asRecord(loaderData['note_(id)/page']);
  const info = asRecord(page?.videoInfoRes);
  const list = Array.isArray(info?.item_list) ? info!.item_list : null;
  const item = list && list.length > 0 ? asRecord(list[0]) : null;
  if (!item) throw new DouyinResolveError('parse', '未从抖音页面解析到视频（可能是图集或已失效）');
  const video = asRecord(item.video);
  const playAddr = asRecord(video?.play_addr);
  const urlList = Array.isArray(playAddr?.url_list) ? playAddr!.url_list : null;
  const rawUrl = urlList?.find((u): u is string => typeof u === 'string' && u.length > 0);
  if (!rawUrl) throw new DouyinResolveError('parse', '抖音视频未包含可用的播放地址');
  const videoUrl = rawUrl.replace('playwm', 'play');
  const desc = typeof item.desc === 'string' ? item.desc.trim() : '';
  const title = (desc || `douyin_${videoId}`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
  const cover = asRecord(video?.cover) ?? asRecord(video?.origin_cover);
  const coverList = Array.isArray(cover?.url_list) ? cover!.url_list : null;
  const coverUrl = coverList?.find((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u));
  return { videoUrl, title, videoId, ...(coverUrl ? { coverUrl } : {}) };
}

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<{ finalUrl: string; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': MOBILE_UA, Accept: 'text/html,*/*' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new DouyinResolveError('upstream', `抖音返回 HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) return { finalUrl: response.url || url, body: await response.text() };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > MAX_HTML_BYTES) { await reader.cancel(); throw new DouyinResolveError('too_large', '抖音页面过大'); }
        chunks.push(value);
      }
    }
    return { finalUrl: response.url || url, body: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8') };
  } catch (error) {
    if (error instanceof DouyinResolveError) throw error;
    const aborted = (error as { name?: string }).name === 'AbortError';
    throw new DouyinResolveError(aborted ? 'timeout' : 'network', aborted ? '抖音请求超时' : '无法连接抖音');
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve a pasted Douyin share blob to its watermark-free video and caption. */
export async function resolveDouyinShare(
  shareText: string,
  deps: { fetch?: typeof fetch } = {},
): Promise<DouyinVideo> {
  const fetchImpl = deps.fetch ?? fetch;
  const shareUrl = extractFirstUrl(shareText);
  if (!shareUrl || !isDouyinShareUrl(shareUrl)) {
    throw new DouyinResolveError('invalid', '未找到有效的抖音分享链接');
  }
  const { finalUrl } = await fetchText(shareUrl, fetchImpl);
  const videoId = finalUrl.split('?')[0]!.replace(/\/+$/, '').split('/').pop() ?? '';
  if (!/^[A-Za-z0-9_-]{6,}$/.test(videoId)) {
    throw new DouyinResolveError('invalid', '无法从抖音链接解析出视频 ID');
  }
  const { body } = await fetchText(`https://www.iesdouyin.com/share/video/${videoId}`, fetchImpl);
  return parseRouterData(body, videoId);
}
