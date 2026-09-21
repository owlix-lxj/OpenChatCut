import { socialPlatform, type SocialPlatform } from '../shared/social-publish.ts';

// Deliberately scoped to creator pages. No generic remote-script or arbitrary URL IPC.
// Selectors are best effort; unknown layouts stop at manual review, never broad-click.
const SELECTORS = {
  douyin: { title: 'input[placeholder*="填写作品标题"]', body: 'div.zone-container[contenteditable="true"]', button: '发布' },
  xiaohongshu: { title: 'input[placeholder*="填写标题"]', body: '.tiptap[contenteditable="true"], .ProseMirror[contenteditable="true"], #post-textarea', button: '发布' },
} as const;

export interface PublishPageState {
  login: boolean; uploadSelector: string | null; ready: boolean; success: boolean; draftSaved: boolean; failed: boolean;
}

export function publishPageScript(platform: SocialPlatform, action: 'inspect' | 'fill' | 'save-draft' | 'submit', draft?: { title: string; description: string }): string {
  // Keep the legacy action fail-closed even if an old caller survives an upgrade.
  if (action === 'submit') throw new Error('自动发布已禁用，仅支持保存草稿');
  const config = { ...SELECTORS[platform], host: socialPlatform(platform).host, platform, action, draft };
  return `(() => {
    const c = ${JSON.stringify(config)};
    if (location.protocol !== 'https:' || location.hostname !== c.host) throw new Error('平台页面不匹配');
    const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    // Ignore user-entered captions/titles and hidden templates when reading platform status.
    // A caption saying "发布成功" must never be mistaken for a successful submission.
    const parts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (visible(parent) && !parent.closest('input, textarea, select, [contenteditable], script, style, noscript')) parts.push(node.textContent);
    }
    const text = parts.join('').replace(/\\s+/g, '');
    const login = /扫码登录|手机号登录|请先登录|微信扫码登录|创作者登录/.test(text) || /\\/login(?:[./?]|$)/.test(location.pathname);
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(el => visible(el) && /^(保存草稿|存草稿|保存到草稿|保存至草稿)$/.test(el.textContent.trim()) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    const titles = [...document.querySelectorAll(c.title)].filter(visible);
    const bodies = [...document.querySelectorAll(c.body)].filter(visible);
    const videoInputs = [...document.querySelectorAll('input[type="file"]')].filter(el => {
      const accept = el.getAttribute('accept') || '';
      return /video|\\.mp4|\\.mov/i.test(accept) && !/image/i.test(accept);
    });
    const uploadSelector = videoInputs.length === 1 ? 'input[type="file"][data-aicut-video-upload="selected"]' : null;
    document.querySelectorAll('[data-aicut-video-upload]').forEach(el => el.removeAttribute('data-aicut-video-upload'));
    if (uploadSelector) videoInputs[0].setAttribute('data-aicut-video-upload', 'selected');
    const uploaded = /重新上传|上传成功|编辑封面|更换视频/.test(text);
    const busy = /上传中|正在上传|转码中|处理中|正在处理/.test(text);
    const failed = /上传失败|发布失败|发表失败|转码失败|草稿保存失败|保存草稿失败/.test(text);
    const ready = !login && !busy && !failed && uploaded;
    const success = !login && /发布成功|发表成功/.test(text);
    const draftSaved = !login && !failed && /草稿保存成功|保存草稿成功|已保存至草稿|已保存到草稿|已存入草稿/.test(text);
    if (c.action === 'fill') {
      if (!ready || titles.length !== 1 || bodies.length !== 1) return false;
      const title = titles[0];
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(title, c.draft.title);
      title.dispatchEvent(new Event('input', {bubbles: true}));
      title.dispatchEvent(new Event('change', {bubbles: true}));
      const body = bodies[0];
      body.focus();
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, c.draft.description);
      body.dispatchEvent(new Event('input', {bubbles: true}));
      body.blur();
      return title.value === c.draft.title && body.innerText.trim() === c.draft.description.trim();
    }
    if (c.action === 'save-draft') {
      if (!ready || draftSaved || success || buttons.length !== 1) throw new Error('无法确认唯一的保存草稿按钮，请在平台手动核对；不会点击发布');
      buttons[0].click();
      return true;
    }
    return {login, uploadSelector, ready, success, draftSaved, failed};
  })()`;
}
