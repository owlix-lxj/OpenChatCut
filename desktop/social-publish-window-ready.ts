import { activePublishPhase, socialPlatform, type PublishPhase, type SocialPlatform } from '../shared/social-publish.ts';

/** Opening a page is distinct from uploading a video or saving its draft. Never retry either. */
export async function waitForPublishWindows(
  jobs: { platform: SocialPlatform; phase: PublishPhase; detail: string }[],
  isOpen: (index: number) => boolean,
  options: { timeoutMs?: number; pollMs?: number; closed?: () => boolean } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 45_000);
  while (true) {
    if (options.closed?.()) throw new Error('应用正在退出');
    const failed = jobs.find((job, index) => !isOpen(index) && !activePublishPhase(job.phase));
    if (failed) throw new Error(`${socialPlatform(failed.platform).name}：${failed.detail}`);
    if (jobs.every((_, index) => isOpen(index))) return;
    if (Date.now() >= deadline) throw new Error('打开平台页面超时，请查看对应平台窗口或取消上传后重试；不会自动重复上传。');
    await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 100));
  }
}
