import assert from 'node:assert/strict';
import { waitForPublishWindows } from './social-publish-window-ready.ts';

const jobs = [
  { platform: 'douyin' as const, phase: 'preparing' as const, detail: '准备中' },
  { platform: 'xiaohongshu' as const, phase: 'uploading' as const, detail: '上传中' },
];
let opened = [true, false];
let done = false;
const wait = waitForPublishWindows(jobs, i => opened[i], { pollMs: 1, timeoutMs: 100 }).then(() => { done = true; });
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(done, false, 'wait for every selected platform, not just the first');
opened = [true, true];
await wait;
assert.equal(done, true, 'dismiss before upload/review/save completes');
await assert.rejects(waitForPublishWindows(jobs, () => false, { pollMs: 1, timeoutMs: 5 }), /超时/);
await assert.rejects(waitForPublishWindows([{ ...jobs[0], phase: 'failed', detail: '网页打开失败' }], () => false), /网页打开失败/);
await assert.rejects(waitForPublishWindows(jobs, () => false, { closed: () => true }), /正在退出/);
console.log('Platform opening: waits for all pages, failure/timeout/quit stop loading, no upload completion dependency passed');
