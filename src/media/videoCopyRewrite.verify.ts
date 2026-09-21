import assert from 'node:assert/strict';
import { extractVideoLink, isDouyinVideoLink } from './videoCopyRewrite';

assert.equal(
  extractVideoLink('复制打开 https://v.douyin.com/abc123/ 看视频'),
  'https://v.douyin.com/abc123/',
);
assert.equal(extractVideoLink('没有链接'), null);
assert.equal(isDouyinVideoLink('https://v.douyin.com/abc123/'), true);
assert.equal(isDouyinVideoLink('https://www.iesdouyin.com/share/video/123456'), true);
assert.equal(isDouyinVideoLink('https://v.douyin.com.evil.example/a'), false);
assert.equal(isDouyinVideoLink('https://cdn.example.com/video.mp4'), false);

console.log('videoCopyRewrite.verify: video URL extraction and Douyin host validation passed');
