export const SOCIAL_PUBLISH_CHANNEL = 'openchatcut:social-publish';
export const SOCIAL_PLATFORMS = [
  { id: 'douyin', name: '抖音', url: 'https://creator.douyin.com/creator-micro/content/upload', host: 'creator.douyin.com', titleLimit: 30 },
  { id: 'xiaohongshu', name: '小红书', url: 'https://creator.xiaohongshu.com/publish/publish?from=homepage&target=video', host: 'creator.xiaohongshu.com', titleLimit: 20 },
] as const;
export type SocialPlatform = typeof SOCIAL_PLATFORMS[number]['id'];
export type PublishPhase = 'preparing' | 'uploading' | 'review' | 'saving_draft' | 'drafted' | 'submitting' | 'published' | 'failed' | 'cancelled' | 'unknown';
export interface PublishFile { id: string; name: string; size: number }
export interface PublishJob {
  id: string; platform: SocialPlatform; filename: string; title: string;
  phase: PublishPhase; detail: string; createdAt: number; updatedAt: number;
  engine?: 'geo';
}
export interface PublishSnapshot {
  jobs: PublishJob[];
  accounts: { platform: SocialPlatform; state: 'unchecked' | 'login_required' | 'available' | 'saved' | 'error' | 'manual'; windowOpen: boolean; username?: string; detail?: string }[];
  bridge?: { connected: boolean; ready: boolean; detail: string; videoPlatforms: SocialPlatform[] };
}
export interface PublishDraft { fileId: string; platforms: SocialPlatform[]; title: string; description: string }
export type PublishRequest =
  | { action: 'snapshot' }
  | { action: 'refresh-account'; platform: SocialPlatform }
  | { action: 'connect' | 'disconnect'; platform: SocialPlatform }
  | { action: 'choose-file' }
  | { action: 'export-file'; destinationId: string; filename: string }
  | { action: 'prepare'; draft: PublishDraft }
  | { action: 'review' | 'save-draft' | 'cancel'; jobId: string };
export interface SocialPublishApi {
  snapshot(): Promise<PublishSnapshot>;
  refreshAccount(platform: SocialPlatform): Promise<void>;
  connect(platform: SocialPlatform): Promise<void>;
  disconnect(platform: SocialPlatform): Promise<void>;
  chooseFile(): Promise<PublishFile | null>;
  exportFile(destinationId: string, filename: string): Promise<PublishFile>;
  prepare(draft: PublishDraft): Promise<void>;
  review(jobId: string): Promise<void>;
  saveDraft(jobId: string): Promise<void>;
  cancel(jobId: string): Promise<void>;
}
export function socialPlatform(value: unknown) {
  const result = SOCIAL_PLATFORMS.find(p => p.id === value);
  if (!result) throw new Error('不支持的视频发布平台');
  return result;
}
export function validatePublishDraft(value: unknown): PublishDraft {
  if (!value || typeof value !== 'object') throw new Error('无效的发布内容');
  const d = value as Partial<PublishDraft>;
  if (typeof d.fileId !== 'string' || !d.fileId || !Array.isArray(d.platforms)
    || d.platforms.length < 1 || d.platforms.length > SOCIAL_PLATFORMS.length || new Set(d.platforms).size !== d.platforms.length)
    throw new Error('请选择视频和发布平台');
  if (typeof d.title !== 'string' || !d.title.trim() || typeof d.description !== 'string' || d.description.length > 1000)
    throw new Error('请填写标题，正文不得超过 1000 字');
  const title = d.title.trim();
  for (const id of d.platforms) {
    const p = socialPlatform(id);
    if (Array.from(title).length > p.titleLimit) throw new Error(`${p.name}标题最多 ${p.titleLimit} 字`);
  }
  return { fileId: d.fileId, platforms: [...d.platforms], title, description: d.description.trim() };
}
export function activePublishPhase(phase: PublishPhase): boolean {
  return ['preparing', 'uploading', 'review', 'saving_draft', 'submitting'].includes(phase);
}
export function allowedPublishNavigation(platform: SocialPlatform, value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port
      && u.hostname === socialPlatform(platform).host;
  } catch { return false; }
}
