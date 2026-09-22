import assert from 'node:assert/strict';
import { platformDigitalHumanErrorMessage, platformDigitalHumanResponseError } from './platformIntegration';

assert.equal(
  platformDigitalHumanErrorMessage('digital human pricing is not configured'),
  '业务平台尚未配置数字人视频计费单价，请联系平台管理员完成定价配置后重试。',
);
assert.equal(
  platformDigitalHumanErrorMessage(' Digital Human Pricing Is Not Configured '),
  '业务平台尚未配置数字人视频计费单价，请联系平台管理员完成定价配置后重试。',
);
assert.equal(platformDigitalHumanErrorMessage('provider unavailable'), 'provider unavailable');
assert.equal(
  platformDigitalHumanErrorMessage('digital human request failed'),
  '数字人业务平台请求失败，请重试；如果持续失败，请检查业务平台服务状态。',
);
assert.equal(
  platformDigitalHumanResponseError({
    error: 'digital human request failed',
    detail: 'upstream avatar provider rejected the request',
  }, 502),
  'upstream avatar provider rejected the request',
  'the proxy detail must not be hidden by its generic error label',
);
assert.equal(
  platformDigitalHumanResponseError({ error: 'digital human request failed', detail: 'fetch failed' }, 502),
  '无法连接数字人业务平台，请检查网络或稍后重试。',
);

console.log('platform integration verification passed');
