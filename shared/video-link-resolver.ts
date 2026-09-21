export const VIDEO_LINK_RESOLVER_CHANNEL = 'openchatcut:resolve-video-link';

export type ResolvedDesktopVideoLink = { readonly name: string } & (
  | { readonly url: string; readonly path?: never }
  | { readonly path: string; readonly url?: never }
);

export function isResolvedDesktopVideoLink(value: unknown): value is ResolvedDesktopVideoLink {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ResolvedDesktopVideoLink>;
  const sourceValid = (typeof record.url === 'string' && /^https:\/\//i.test(record.url) && record.path === undefined)
    || (typeof record.path === 'string' && /^\/media\/uploads\/[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(record.path) && record.url === undefined);
  return sourceValid && typeof record.name === 'string' && record.name.length > 0;
}

export type VideoLinkPlatform = 'douyin' | 'xiaohongshu' | 'bilibili' | 'wechat' | 'other';

export function extractSharedVideoUrl(value: string): string | null {
  const match = value.match(/https?:\/\/[^\s"'<>）)\]】]+/i);
  return match?.[0]?.replace(/[，。；！、,;!]+$/, '') ?? null;
}

export function videoLinkPlatform(value: string): VideoLinkPlatform {
  try {
    const host = new URL(extractSharedVideoUrl(value) ?? value).hostname.toLowerCase();
    const belongsTo = (domain: string) => host === domain || host.endsWith(`.${domain}`);
    if (belongsTo('douyin.com') || belongsTo('iesdouyin.com')) return 'douyin';
    if (belongsTo('xiaohongshu.com') || belongsTo('xhslink.com') || belongsTo('xhslink.cn')) return 'xiaohongshu';
    if (belongsTo('bilibili.com') || belongsTo('b23.tv')) return 'bilibili';
    if (belongsTo('weixin.qq.com') || belongsTo('weixin.com') || belongsTo('wx.qq.com')) return 'wechat';
  } catch { /* invalid URL */ }
  return 'other';
}

export const VIDEO_LINK_PLATFORM_LABELS: Record<VideoLinkPlatform, string> = {
  douyin: '抖音', xiaohongshu: '小红书', bilibili: '哔哩哔哩', wechat: '微信视频号', other: '视频链接',
};
