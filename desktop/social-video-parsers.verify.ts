import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractSharedVideoUrl, isResolvedDesktopVideoLink, videoLinkPlatform } from '../shared/video-link-resolver.ts';
import { parseWechatFeed, parseXhsVideo, resolveWechatVideo, resolveXhsVideo, wechatFeedRequest, xhsCanonicalUrl } from './social-video-parsers.ts';
import { copyDownloadArgs, decodeWechatMediaPrefix } from './video-copy-download.ts';
import { wechatKeyStream } from './wechat-media-decrypt.ts';

assert.equal(videoLinkPlatform('https://xhslink.cn/o/example'), 'xiaohongshu');
assert.equal(videoLinkPlatform('https://xhslink.com/example'), 'xiaohongshu');
assert.equal(videoLinkPlatform('https://weixin.qq.com/sph/example'), 'wechat');
assert.equal(videoLinkPlatform('https://weixin.qq.com.evil.test/sph/example'), 'other');
assert.equal(extractSharedVideoUrl('分享 https://xhslink.cn/o/example。'), 'https://xhslink.cn/o/example');
const target = 'https://www.xiaohongshu.com/discovery/item/abcdef?xsec_token=test%3D&xsec_source=app_share';
assert.equal(xhsCanonicalUrl(`https://www.xiaohongshu.com/login?redirectPath=${encodeURIComponent(target)}`), target);
assert.throws(() => xhsCanonicalUrl('https://evil.test/explore/abcdef'));
const state = { LAUNCHER_SSR_STORE_PAGE_DATA: { noteData: {
  noteId: 'abcdef', type: 'video', title: '目标视频', video: { media: { stream: { h264: [{
    masterUrl: 'http://sns-video.xhscdn.com/opaque-video?sign=keep', audioCodec: 'aac',
  }] } } },
} } };
const html = `<script>window.__SETUP_SERVER_STATE__=${JSON.stringify(state)}</script>`;
assert.deepEqual(parseXhsVideo(html, target), { url: 'https://sns-video.xhscdn.com/opaque-video?sign=keep', name: '目标视频', referer: target });
assert.throws(() => parseXhsVideo(html, target.replace('abcdef', '123456')), /未返回/);
assert.throws(() => parseXhsVideo(html.replace('"type":"video"', '"type":"normal"'), target), /图文/);
const visited: string[] = [];
const parsed = await resolveXhsVideo('https://xhslink.cn/o/example', async (url, init) => {
  visited.push(url);
  assert.equal(init?.credentials, 'omit', 'public extraction must not use an end-user account');
  assert.equal(init?.redirect, 'manual');
  return visited.length === 1 ? new Response(null, { status: 302, headers: { location: target.replace('https:', 'http:') } })
    : new Response(html);
});
assert.equal(parsed.name, '目标视频');
assert.deepEqual(visited, ['https://xhslink.cn/o/example', target]);
const followedResponse = new Response(html);
Object.defineProperty(followedResponse, 'url', { value: target });
const followed = await resolveXhsVideo('https://xhslink.cn/o/example', async () => followedResponse);
assert.equal(followed.name, '目标视频', 'system-proxy redirect following uses the validated final XHS URL');
assert.deepEqual(wechatFeedRequest('https://weixin.qq.com/sph/AffHs8CkT0').body, { baseReq: { generalToken: '' }, shortUri: 'AffHs8CkT0' });
assert.equal(parseWechatFeed('{"errCode":0,"data":{"feedInfo":{"description":"只有标题","coverUrl":"https://example.com/cover.jpg"}}}', 'https://weixin.qq.com/'), null);
assert.equal(parseWechatFeed('{"errCode":0,"data":{"feedInfo":{"videoUrl":"https://finder.video.qq.com/a","decodeKey":18446744073709551615}}}', 'https://weixin.qq.com/')?.decodeKey, '18446744073709551615');
let calls = 0;
await assert.rejects(resolveWechatVideo('https://weixin.qq.com/sph/example', async (url, init) => {
  calls++;
  assert.equal(init?.credentials, 'omit');
  assert.equal(new URL(url).hostname, 'channels.weixin.qq.com');
  return new Response('{"errCode":0,"data":{"feedInfo":{"description":"标题"}}}');
}), /免登录解析尚未成功/);
assert.equal(calls, 1, 'never fall back to login, unrelated accounts or third-party services');
assert.equal(isResolvedDesktopVideoLink({ name: '小红书', path: '/media/uploads/copy-123.mp4' }), true);
assert.equal(isResolvedDesktopVideoLink({ name: 'unsafe', path: '/media/uploads/../../private.txt' }), false);
const args = copyDownloadArgs('https://example.com/watch?v=1', '/tmp/test');
assert.ok(args.includes('bestaudio/best'), 'ASR must not select silent video-only DASH formats');
assert.ok(args.includes('--ignore-config'), 'external user config must not trigger commands');
assert.ok(args.includes('--no-plugin-dirs'));

const decryptRoot = await mkdtemp(join(tmpdir(), 'aicut-wechat-decrypt-'));
try {
  const mediaPath = join(decryptRoot, 'media.mp4');
  const plain = Buffer.from('wechat encrypted media prefix regression');
  const key = wechatKeyStream('123456789');
  const encrypted = Buffer.from(plain);
  for (let index = 0; index < encrypted.length; index += 1) encrypted[index] ^= key[index]!;
  await writeFile(mediaPath, encrypted);
  await decodeWechatMediaPrefix(mediaPath, '123456789', encrypted.length);
  assert.deepEqual(await readFile(mediaPath), plain, 'downloaded WeChat media is locally decrypted before ffprobe');
} finally {
  await rm(decryptRoot, { recursive: true, force: true });
}
console.log('social-video-parsers: platform routing, signed short links, target media, no-login failure and local IPC paths passed');
