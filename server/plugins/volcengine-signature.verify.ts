import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { signVolcengineRequest } from './volcengine-signature.ts';

const input = {
  baseUrl: 'https://visual.volcengineapi.com',
  action: 'CVSync2AsyncGetResult',
  body: { req_key: 'jimeng_realman_avatar_picture_omni_v2', task_id: 'probe' },
  credentials: { accessKeyId: 'ak-test', secretAccessKey: 'sk-test' },
  date: new Date('2026-01-02T03:04:05.678Z'),
};
const signed = signVolcengineRequest(input);
const bodyHash = createHash('sha256').update(signed.body).digest('hex');
assert.equal(signed.url, 'https://visual.volcengineapi.com/?Action=CVSync2AsyncGetResult&Version=2022-08-31');
assert.equal(signed.headers['X-Date'], '20260102T030405Z');
assert.equal(signed.headers['X-Content-Sha256'], bodyHash);
assert.match(signed.headers.Authorization, /^HMAC-SHA256 Credential=ak-test\/20260102\/cn-north-1\/cv\/request,/);
assert.match(signed.headers.Authorization, /SignedHeaders=content-type;host;x-content-sha256;x-date/);
assert.doesNotMatch(signed.url, /sk-test|ak-test/);
assert.deepEqual(signVolcengineRequest(input), signed, 'V4 signing stays deterministic for retries and tests');

console.log('volcengine-signature.verify: ok');
