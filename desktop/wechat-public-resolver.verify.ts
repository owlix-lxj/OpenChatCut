import assert from 'node:assert/strict';
import { parsePublicWechatVideo, publicWechatShareUrl, resolvePublicWechatVideo } from './wechat-public-resolver.ts';
import { resolveWechatVideo } from './social-video-parsers.ts';

const share = 'https://weixin.qq.com/sph/AffHs8CkT0';
const media = 'https://finder.video.qq.com/251/20302/stodownload?encfilekey=sample&token=sample';
const result = { code: 200, data: { type: 'video', title: '视频标题不是转写文案', url: media } };
assert.equal(publicWechatShareUrl(`${share}?tracking=drop`), share);
assert.equal(publicWechatShareUrl('https://channels.weixin.qq.com/finder-preview/pages/sph?id=AffHs8CkT0&tracking=drop'), share);
assert.equal(publicWechatShareUrl(share.replace('weixin.qq.com', 'mp.weixin.qq.com')), share);
for (const input of [
  'http://weixin.qq.com/sph/AffHs8CkT0', 'https://weixin.qq.com.evil.test/sph/AffHs8CkT0',
  'https://user:pass@weixin.qq.com/sph/AffHs8CkT0', 'https://weixin.qq.com:444/sph/AffHs8CkT0',
  'https://channels.weixin.qq.com/finder-preview/pages/feed?eid=private&token=secret',
]) assert.throws(() => publicWechatShareUrl(input));
assert.equal(parsePublicWechatVideo(result).url, media);
assert.equal(parsePublicWechatVideo({ ...result, data: { ...result.data, video_backup: [
  { codec: 'h264', url: `${media}&codec=h264` },
] } }).url, `${media}&codec=h264`);
for (const url of [
  'https://127.0.0.1/media.mp4', 'file:///etc/passwd',
  'https://finder.video.qq.com.evil.test/251/20302/stodownload?encfilekey=x&token=y',
  'https://finder.video.qq.com/251/20304/stodownload?encfilekey=cover&token=y',
  'https://finder.video.qq.com/251/20302/stodownload',
  media.replace('https:', 'http:'), media.replace('https://', 'https://user:secret@'),
]) assert.throws(() => parsePublicWechatVideo({ ...result, data: { ...result.data, url } }), /音视频/);
assert.throws(() => parsePublicWechatVideo({ code: 200, data: { type: 'image', url: media } }), /不是视频/);
assert.throws(() => parsePublicWechatVideo({ code: 200, data: { type: 'video', title: '只有标题' } }), /音视频/);

let calls = 0;
const waits: number[] = [];
const resolved = await resolvePublicWechatVideo(`${share}?token=DO_NOT_FORWARD`, async (url, init) => {
  calls++;
  const target = new URL(url);
  assert.equal(target.origin, 'https://api.bugpk.com');
  assert.equal(target.pathname, '/api/wxsph');
  assert.deepEqual([...target.searchParams], [['url', share]]);
  assert.equal(init?.credentials, 'omit');
  assert.equal(init?.redirect, 'manual');
  assert.equal(init?.method, 'GET');
  assert.equal(new Headers(init?.headers).has('cookie'), false);
  assert.equal(new Headers(init?.headers).has('authorization'), false);
  return new Response(JSON.stringify(calls === 1 ? { code: 429, data: { retry_after: 3 } } : result));
}, async (ms) => { waits.push(ms); });
assert.equal(resolved.url, media);
assert.equal(calls, 2);
assert.deepEqual(waits, [3000]);

calls = 0;
await assert.rejects(resolvePublicWechatVideo(share, async () => {
  calls++;
  return new Response(JSON.stringify({ code: 429 }), { status: 429 });
}, async () => {}), /已自动重试/);
assert.equal(calls, 3, 'a busy public API must never cause an unbounded retry loop');
await assert.rejects(resolvePublicWechatVideo(share, async () => new Response('{"code":429}', {
  headers: { 'Retry-After': '60' },
}), async () => { assert.fail('do not retry earlier than the server permits'); }), /限流/);
await assert.rejects(resolvePublicWechatVideo(share, async () => new Response('not JSON')), /返回异常/);
await assert.rejects(resolvePublicWechatVideo(share, async () => new Response('x'.repeat(1024 * 1024 + 1))), /返回异常/);
await assert.rejects(resolvePublicWechatVideo(share, async () => { throw new Error('credential-leaking upstream message'); }),
  (error: Error) => error.message.includes('连接失败') && !error.message.includes('credential-leaking'));
await assert.rejects(resolvePublicWechatVideo(share, async () => new Response(JSON.stringify(result), {
  status: 302, headers: { location: 'https://unrelated.test/' },
})), /暂不可用/);

let fallbacks = 0;
const fallback = async (link: string) => { assert.equal(link, share); fallbacks++; return resolved; };
const noMedia = async () => new Response('{"errCode":0,"data":{"feedInfo":{"description":"只是标题"}}}');
assert.equal((await resolveWechatVideo(share, noMedia, fallback)).url, media);
assert.equal(fallbacks, 1);
const direct = async () => new Response(JSON.stringify({ errCode: 0, data: { feedInfo: { videoUrl: media } } }));
await resolveWechatVideo(share, direct, fallback);
assert.equal(fallbacks, 1, 'do not send links to the third party if direct public resolution succeeds');
await assert.rejects(resolveWechatVideo(share, async () => new Response('{"errCode":1}'), fallback));
assert.equal(fallbacks, 1, 'do not turn explicit access errors into fallback attempts');
console.log('wechat-public-resolver: keyless fallback, privacy, media validation and bounded retries passed');
