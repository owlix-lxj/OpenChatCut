import assert from 'node:assert/strict';
import { recoverableDouyinNavigationError } from './video-link-resolver-error';

assert.equal(recoverableDouyinNavigationError({ code: 'ERR_ABORTED' }), true);
assert.equal(recoverableDouyinNavigationError({ errno: -3 }), true);
assert.equal(recoverableDouyinNavigationError(new Error("ERR_ABORTED (-3) loading 'snssdk1128://aweme/detail/1'")), true);
assert.equal(recoverableDouyinNavigationError(new Error('ERR_CONNECTION_REFUSED')), false);

console.log('video-link-resolver.verify: app deep-link abort is recoverable');
