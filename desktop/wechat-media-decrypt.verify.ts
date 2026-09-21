import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { wechatKeyStream } from './wechat-media-decrypt.ts';

// Cross-checked against the upstream Go implementation's DecryptData over
// 128 KiB of zero bytes: uint64 arithmetic, block order and big-endian bytes.
const vectors = [
  ['0', 'e1662af3b7e59867c919ad19055fc8cecea2b154d37e1459b2f96d1da14cef1f'],
  ['1', '39d98f5b25cc52f0996f7ef9e1022156cb029901be6a11ebbdd7469c6ffd5839'],
  ['18446744073709551615', '5afbffd76305e81467f97c6370fa07916e9b197611bf5c357a854eb92a6354a1'],
];
for (const [key, expected] of vectors) {
  const stream = wechatKeyStream(key!);
  assert.equal(stream.length, 128 * 1024);
  assert.equal(createHash('sha256').update(stream).digest('hex'), expected);
}
for (const invalid of ['', '-1', '1.5', '18446744073709551616']) {
  assert.throws(() => wechatKeyStream(invalid), /格式无效/);
}
console.log('wechat-media-decrypt: upstream uint64 vectors passed');
