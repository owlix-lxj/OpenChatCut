import assert from 'node:assert/strict';
import {
  containsDouyinShare, DouyinResolveError, extractFirstUrl, isDouyinShareUrl,
  parseRouterData, resolveDouyinShare,
} from './douyin-resolver';

// ── URL extraction & host gate ──
assert.equal(
  extractFirstUrl('7.98 复制打开抖音 https://v.douyin.com/iJAbc123/ 看看'),
  'https://v.douyin.com/iJAbc123/',
);
assert.equal(extractFirstUrl('no link here'), null);
assert.equal(isDouyinShareUrl('https://v.douyin.com/iJAbc123/'), true);
assert.equal(isDouyinShareUrl('https://www.iesdouyin.com/share/video/123'), true);
assert.equal(isDouyinShareUrl('https://evil.example.com/x'), false);
assert.equal(isDouyinShareUrl('https://v.douyin.com.evil.com/x'), false, 'suffix must match a real douyin host label');
assert.equal(containsDouyinShare('看 https://v.douyin.com/abc/ 复制'), true);
assert.equal(containsDouyinShare('看 https://youtube.com/watch 复制'), false);

// ── parseRouterData: video page, watermark removal, caption ──
const videoHtml = `<html><script>window._ROUTER_DATA = ${JSON.stringify({
  loaderData: {
    'video_(id)/page': {
      videoInfoRes: {
        item_list: [{
          desc: '  这是一条  文案/含<非法>字符  ',
          video: {
            play_addr: { url_list: ['https://v3.douyinvod.com/abc/playwm/def?a=1', 'https://backup/playwm/x'] },
            cover: { url_list: ['https://cover.example.com/c.jpg'] },
          },
        }],
      },
    },
  },
})}</script></html>`;
const parsed = parseRouterData(videoHtml, 'vid123');
assert.equal(parsed.videoUrl, 'https://v3.douyinvod.com/abc/play/def?a=1', 'playwm→play removes the watermark');
assert.equal(parsed.title, '这是一条  文案_含_非法_字符', 'caption trimmed and sanitized of filename-illegal chars');
assert.equal(parsed.videoId, 'vid123');
assert.equal(parsed.coverUrl, 'https://cover.example.com/c.jpg');

// ── parseRouterData: note (image-set) page shape is also read ──
const noteHtml = `<script>window._ROUTER_DATA = ${JSON.stringify({
  loaderData: { 'note_(id)/page': { videoInfoRes: { item_list: [{ desc: '', video: { play_addr: { url_list: ['https://x/playwm/y'] } } }] } } },
})}</script>`;
const note = parseRouterData(noteHtml, 'note9');
assert.equal(note.videoUrl, 'https://x/play/y');
assert.equal(note.title, 'douyin_note9', 'empty caption falls back to douyin_<id>');

// ── parse failures are typed, not raw throws ──
assert.throws(() => parseRouterData('<html>no router data</html>', 'x'),
  (e: unknown) => e instanceof DouyinResolveError && e.code === 'parse');
assert.throws(() => parseRouterData('<script>window._ROUTER_DATA = {"loaderData":{}}</script>', 'x'),
  (e: unknown) => e instanceof DouyinResolveError && e.code === 'parse');

// ── resolveDouyinShare end-to-end with an injected fetch (no network) ──
// The share link "redirects" to a URL whose last path segment is the video id; Response.url on a
// synthesized Response is empty, so we stamp the redirect target the resolver reads.
const shareFinalUrl = 'https://www.iesdouyin.com/share/video/7123456789/';
const fetchWithUrl = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input.toString();
  let res: Response;
  let finalUrl = url;
  if (url.startsWith('https://v.douyin.com/')) { res = new Response('redirected', { status: 200 }); finalUrl = shareFinalUrl; }
  else if (url.startsWith('https://www.iesdouyin.com/share/video/7123456789')) { res = new Response(videoHtml, { status: 200 }); }
  else throw new Error(`unexpected fetch ${url}`);
  Object.defineProperty(res, 'url', { value: finalUrl, configurable: true });
  return res;
}) as unknown as typeof fetch;
const resolved = await resolveDouyinShare('打开抖音 https://v.douyin.com/iJAbc123/ 复制', { fetch: fetchWithUrl });
assert.equal(resolved.videoId, '7123456789');
assert.equal(resolved.videoUrl, 'https://v3.douyinvod.com/abc/play/def?a=1');

await assert.rejects(
  resolveDouyinShare('no douyin link', { fetch: fetchWithUrl }),
  (e: unknown) => e instanceof DouyinResolveError && e.code === 'invalid',
);

console.log('douyin-resolver.verify: ok');
