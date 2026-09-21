import { videoLinkPlatform } from '../shared/video-link-resolver.ts';

export const SHARE_MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
export type ShareFetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface SocialVideo { url: string; name: string; referer: string; decodeKey?: string }

export function xhsCanonicalUrl(value: string): string {
  const url = new URL(value);
  if (videoLinkPlatform(value) !== 'xiaohongshu') throw new Error('小红书短链跳转到了不支持的网站');
  if (url.pathname === '/login') {
    const target = url.searchParams.get('redirectPath');
    if (!target) throw new Error('小红书未返回公开分享页，请重新复制完整分享链接');
    const next = new URL(target, url.origin);
    if (next.pathname === '/login') throw new Error('小红书分享链接无效');
    return xhsCanonicalUrl(next.href);
  }
  url.protocol = 'https:';
  return url.href;
}

export function parseXhsVideo(html: string, pageUrl: string): SocialVideo {
  // Parse JSON only, never evaluate JavaScript supplied by a remote page.
  const states = [...html.matchAll(/window\.__(?:SETUP_SERVER_STATE|INITIAL_STATE)__\s*=\s*([\s\S]*?)<\/script>/g)];
  const noteId = /\/(?:explore|discovery\/item)\/([a-f0-9]+)/i.exec(new URL(pageUrl).pathname)?.[1];
  for (const state of states) {
    let data;
    try {
      const json = state[1]!.trim().replace(/;$/, '').replace(/"(?:\\.|[^"\\])*"|\bundefined\b/g, (token) => token === 'undefined' ? 'null' : token);
      data = JSON.parse(json);
    } catch { continue; }
    const note = data.LAUNCHER_SSR_STORE_PAGE_DATA?.noteData
      ?? (noteId ? data.note?.noteDetailMap?.[noteId]?.note : undefined)
      ?? data.noteData?.data?.noteData;
    if (!note || (note.noteId && noteId && note.noteId !== noteId)) continue;
    if (note.type && note.type !== 'video') throw new Error('这篇小红书笔记是图文，没有可提取的语音文案');
    const streams = Object.values(note.video?.media?.stream ?? {}).flat() as Array<{ masterUrl?: string; audioCodec?: string }>;
    for (const stream of streams) {
      if (!stream.masterUrl || stream.audioCodec === 'none') continue;
      const media = new URL(stream.masterUrl);
      if (media.hostname.endsWith('.xhscdn.com') && /^https?:$/.test(media.protocol)) {
        media.protocol = 'https:';
        return { url: media.href, name: String(note.title || '小红书视频'), referer: pageUrl };
      }
    }
  }
  throw new Error('小红书未返回可播放视频，请重新复制完整分享内容（保留链接参数）；确认该笔记仍公开可见');
}

export async function resolveXhsVideo(link: string, fetcher: ShareFetch): Promise<SocialVideo> {
  let pageUrl = xhsCanonicalUrl(link);
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await fetcher(pageUrl, { credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': SHARE_MOBILE_UA } });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      pageUrl = xhsCanonicalUrl(new URL(location, pageUrl).href);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`小红书访问失败（HTTP ${response.status}），请检查分享链接`); }
    return parseXhsVideo(await limitedText(response), pageUrl);
  }
  throw new Error('小红书短链跳转次数过多，请重新复制分享链接');
}

async function limitedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 6 * 1024 * 1024) throw new Error('平台返回的解析信息过大');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => undefined); }
}

export function wechatFeedRequest(link: string): { referer: string; body: Record<string, unknown> } {
  const url = new URL(link);
  if (videoLinkPlatform(link) !== 'wechat') throw new Error('无效的视频号分享地址');
  const shortId = /\/sph\/([A-Za-z0-9]+)/.exec(url.pathname)?.[1]
    ?? (url.pathname.endsWith('/sph') ? url.searchParams.get('id') : null);
  if (shortId) return {
    referer: `https://channels.weixin.qq.com/finder-preview/pages/sph?id=${encodeURIComponent(shortId)}`,
    body: { baseReq: { generalToken: '' }, shortUri: shortId },
  };
  const eid = url.searchParams.get('eid');
  if (eid && url.hostname === 'channels.weixin.qq.com') return {
    referer: url.href,
    body: { baseReq: { generalToken: url.searchParams.get('token') ?? '' }, exportId: eid },
  };
  throw new Error('请粘贴视频号的 https://weixin.qq.com/sph/ 分享链接；微信内卡片或口令无法直接解析');
}

export function parseWechatFeed(text: string, referer: string): SocialVideo | null {
  // decodeKey is uint64: preserve the original decimal digits before JSON parsing.
  const data = JSON.parse(text.replace(/("decodeKey"\s*:\s*)(\d+)/g, '$1"$2"'));
  if (data.errCode) throw new Error('视频号链接已失效、受访问限制或暂时不可用，请重新分享后重试');
  const feed = data.data?.feedInfo;
  const rawUrl = feed?.h264VideoInfo?.videoUrl || feed?.videoUrl || feed?.originVideoUrl;
  if (!rawUrl) return null;
  const media = new URL(rawUrl);
  if (!/^https?:$/.test(media.protocol) || !(media.hostname.endsWith('.video.qq.com') || media.hostname.endsWith('.qpic.cn'))) {
    throw new Error('视频号返回了不支持的媒体地址');
  }
  media.protocol = 'https:';
  return { url: media.href, name: String(feed.description || '视频号视频').slice(0, 160), referer, decodeKey: String(feed.decodeKey ?? '') };
}

export async function resolveWechatVideo(
  link: string, fetcher: ShareFetch, fallback?: (link: string) => Promise<SocialVideo>,
): Promise<SocialVideo> {
  const getFeed = async (request: ReturnType<typeof wechatFeedRequest>) => {
    const response = await fetcher('https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info', {
      method: 'POST', credentials: 'omit', signal: AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/json', Origin: 'https://channels.weixin.qq.com', Referer: request.referer },
      body: JSON.stringify(request.body),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`视频号访问失败（HTTP ${response.status}）`); }
    return parseWechatFeed(await limitedText(response), request.referer);
  };
  const publicVideo = await getFeed(wechatFeedRequest(link));
  if (publicVideo) return publicVideo;
  if (fallback) return fallback(link);
  throw new Error('此视频号分享页只返回了标题和封面，暂未取得可转写的音视频，免登录解析尚未成功');
}
