import { setTimeout as delay } from 'node:timers/promises';
import type { ShareFetch, SocialVideo } from './social-video-parsers.ts';

// Public, keyless API, documented at https://api.bugpk.com/doc-wxsph.html.
// This is a third-party service, not an anonymous implementation of WeChat's
// private protocol. Never send editor credentials, cookies or private feed tokens.
const ENDPOINT = 'https://api.bugpk.com/api/wxsph';

export function publicWechatShareUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('请使用 HTTPS 视频号分享链接');
  }
  const shortId = ['weixin.qq.com', 'mp.weixin.qq.com'].includes(url.hostname)
    ? /^\/sph\/([A-Za-z0-9]{4,64})\/?$/.exec(url.pathname)?.[1]
    : url.hostname === 'channels.weixin.qq.com' && url.pathname === '/finder-preview/pages/sph'
      ? url.searchParams.get('id') : null;
  if (!shortId || !/^[A-Za-z0-9]{4,64}$/.test(shortId)) {
    throw new Error('请重新复制 https://weixin.qq.com/sph/ 格式的视频号公开分享链接');
  }
  return `https://weixin.qq.com/sph/${shortId}`;
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

export function parsePublicWechatVideo(value: unknown): SocialVideo {
  const body = record(value);
  if (body.code !== 200) throw new Error('视频号免费解析服务暂未取得视频，请稍后重试');
  const data = record(body.data);
  if (data.type !== 'video') throw new Error('这条视频号内容不是视频，无法提取语音文案');
  const streams = Array.isArray(data.video_backup) ? data.video_backup.map(record) : [];
  const candidates = [...streams.filter((stream) => stream.codec === 'h264').map((stream) => stream.url), data.url];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length > 16_384) continue;
    try {
      const media = new URL(candidate);
      // Don't follow arbitrary provider URLs, preview pages, covers or localhost.
      if (media.protocol !== 'https:' || media.hostname !== 'finder.video.qq.com'
        || media.username || media.password || media.port || media.pathname !== '/251/20302/stodownload'
        || !media.searchParams.get('encfilekey') || !media.searchParams.get('token')) continue;
      return {
        url: media.href,
        name: typeof data.title === 'string' && data.title.trim() ? data.title.trim().slice(0, 160) : '视频号视频',
        referer: 'https://channels.weixin.qq.com/',
      };
    } catch { /* inspect the next candidate, never return a title/cover as speech */ }
  }
  throw new Error('视频号解析未返回可下载的音视频地址');
}

async function readReply(response: Response): Promise<RecordValue> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('视频号免费解析服务返回了空响应');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error('视频号解析响应超过大小限制');
      chunks.push(value);
    }
    return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally { await reader.cancel().catch(() => undefined); }
}

export async function resolvePublicWechatVideo(
  input: string,
  fetcher: ShareFetch,
  wait: (ms: number) => Promise<unknown> = delay,
): Promise<SocialVideo> {
  const endpoint = new URL(ENDPOINT);
  endpoint.searchParams.set('url', publicWechatShareUrl(input));
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetcher(endpoint.href, {
        method: 'GET', credentials: 'omit', redirect: 'manual',
        signal: AbortSignal.timeout(35_000), headers: { Accept: 'application/json' },
      });
    } catch { throw new Error('视频号免费解析服务连接失败，请稍后重试'); }
    let body: RecordValue;
    try { body = await readReply(response); }
    catch { throw new Error('视频号免费解析服务返回异常，请稍后重试'); }
    if (response.status === 429 || body.code === 429) {
      if (attempt === 2) throw new Error('视频号免费解析服务繁忙，已自动重试，请稍后再试');
      const seconds = Number(response.headers.get('retry-after') ?? record(body.data).retry_after ?? 3);
      if (Number.isFinite(seconds) && seconds > 10) throw new Error('视频号免费解析服务暂时限流，请稍后再试');
      await wait((Number.isFinite(seconds) ? Math.max(1, seconds) : 3) * 1000);
      continue;
    }
    if (!response.ok) throw new Error('视频号免费解析服务暂不可用，请稍后重试');
    return parsePublicWechatVideo(body);
  }
  throw new Error('视频号解析失败');
}
