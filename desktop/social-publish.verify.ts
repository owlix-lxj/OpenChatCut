import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { activePublishPhase, allowedPublishNavigation, socialPlatform, validatePublishDraft } from '../shared/social-publish.ts';
import { publishPageScript } from './social-publish-page.ts';

const draft = { fileId: 'opaque-grant', platforms: ['douyin', 'xiaohongshu'], title: '一个有效的视频标题', description: '视频正文' };
assert.deepEqual(validatePublishDraft(draft), draft);
for (const invalid of [null, {}, { ...draft, platforms: [] }, { ...draft, platforms: ['evil'] },
  { ...draft, platforms: ['douyin', 'douyin'] }, { ...draft, platforms: ['channels'] },
  { ...draft, title: 'x'.repeat(31) }, { ...draft, description: 'x'.repeat(1001) },
  { ...draft, fileId: '' }, { ...draft, title: ' ' }]) {
  assert.throws(() => validatePublishDraft(invalid));
}
assert.throws(() => socialPlatform('__proto__'));
assert.throws(() => socialPlatform('channels'), /不支持/);
assert.equal(activePublishPhase('review'), true);
assert.equal(activePublishPhase('submitting'), true);
assert.equal(activePublishPhase('unknown'), false);
for (const p of ['douyin', 'xiaohongshu'] as const) {
  assert.equal(allowedPublishNavigation(p, socialPlatform(p).url), true);
  for (const url of ['https://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'http://' + socialPlatform(p).host,
    'https://' + socialPlatform(p).host + '.evil.com', 'https://user:pass@' + socialPlatform(p).host,
    'https://' + socialPlatform(p).host + ':5199']) assert.equal(allowedPublishNavigation(p, url), false);
  // User text is embedded as JSON, not executable source.
  const code = publishPageScript(p, 'fill', { title: '";globalThis.pwned=1;//', description: '</script>\\\n`' });
  assert.doesNotThrow(() => new Function(code));
  assert.doesNotThrow(() => new Function(publishPageScript(p, 'inspect')));
}
console.log('social publish input, platform isolation, and script serialization checks passed');

// Empty synthetic DOM: login URL recognition must not depend on QR text/iframes.
for (const pathname of ['/login', '/login.html', '/login/']) {
  const state = runInNewContext(publishPageScript('douyin', 'inspect'), {
    location: { protocol: 'https:', hostname: 'creator.douyin.com', pathname },
    NodeFilter: { SHOW_TEXT: 4 },
    document: {
      body: {}, createTreeWalker: () => ({ nextNode: () => null }),
      querySelectorAll: () => [], querySelector: () => null,
    },
  });
  assert.equal(state.login, true, pathname);
  assert.equal(state.ready, false);
}
console.log('synthetic login URL detection passed (no browser/network)');
