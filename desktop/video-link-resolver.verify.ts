import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  removeBrowserProfile, selectVideoCandidate, stopBrowserProcess, trustedMediaResponse, videoCandidate,
} from './chrome-video-resolver.ts';
import { recoverableDouyinNavigationError } from './video-link-resolver-error';

assert.equal(recoverableDouyinNavigationError({ code: 'ERR_ABORTED' }), true);
assert.equal(recoverableDouyinNavigationError({ errno: -3 }), true);
assert.equal(recoverableDouyinNavigationError(new Error("ERR_ABORTED (-3) loading 'snssdk1128://aweme/detail/1'")), true);
assert.equal(recoverableDouyinNavigationError(new Error('ERR_CONNECTION_REFUSED')), false);
assert.equal(videoCandidate('https://v3-dy-o.zjcdn.com/video/tos/example'), true,
  'new Douyin CDN paths remain recognized');
assert.equal(trustedMediaResponse('https://v3-dy-o.zjcdn.com/media/example', 'video/mp4'), true,
  'CDP video MIME responses are accepted even when the CDN hostname changes');
assert.equal(trustedMediaResponse('https://cdn.example/video', 'text/html'), false,
  'non-media responses are rejected');
assert.equal(
  selectVideoCandidate(['https://cdn.example/first', 'https://cdn.example/latest'], '7687923342816333082'),
  'https://cdn.example/latest',
  'single-video pages fall back to their latest trusted media response when CDN URLs omit the video id',
);

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
await new Promise<void>((resolve, reject) => {
  child.once('spawn', resolve);
  child.once('error', reject);
});
await stopBrowserProcess(child);
assert.ok(child.exitCode !== null || child.signalCode !== null, 'browser process is fully stopped before cleanup');

const profile = await mkdtemp(join(tmpdir(), 'aicut-profile-cleanup-'));
await writeFile(join(profile, 'chrome_debug.log'), 'test');
await removeBrowserProfile(profile);
await assert.rejects(access(profile), 'temporary browser profile is removed');

console.log('video-link-resolver.verify: app deep-link abort is recoverable');
