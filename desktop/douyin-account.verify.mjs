import assert from 'node:assert/strict';
import { readDouyinAccount, DOUYIN_ACCOUNT_URL } from './geo-extension/douyin-account.mjs';

const request = (data, status = 200) => async (url, options) => {
  assert.equal(url, DOUYIN_ACCOUNT_URL);
  assert.equal(options.method, 'GET');
  assert.equal(options.credentials, 'include');
  assert.equal(options.redirect, 'error');
  return new Response(JSON.stringify(data), { status });
};
assert.deepEqual(await readDouyinAccount(request({ status_code: 0, user: { sec_uid: 'id', nickname: ' 昵称\n', secret: 'not returned' } })),
  { isAuthenticated: true, verified: true, username: '昵称' });
assert.deepEqual(await readDouyinAccount(request({}, 401)), { isAuthenticated: false, verified: true });
for (const fixture of [
  request({}), request({ user: { nickname: 'not verified' } }),
  request({ user: { uid: 'id', nickname: '' } }),
  request({ status_code: 8, user: { uid: 'old-user', nickname: 'stale' } }),
  request({}, 403), request({}, 500),
  async () => new Response('<html>login/challenge</html>'),
  async () => { throw new Error('Network problem containing a secret'); },
]) {
  const account = await readDouyinAccount(fixture);
  assert.equal(account.isAuthenticated, false);
  assert.equal(account.verified, false);
  assert.equal(account.username, undefined);
  assert.match(account.error, /不代表已退出登录/);
  assert.equal(JSON.stringify(account).includes('secret'), false);
}
assert.equal((await readDouyinAccount(request({ user: { sec_uid: 'new-user', nickname: '切换后的昵称' } }))).username, '切换后的昵称');
console.log('Douyin profile: verified nickname, explicit logout, unknown/network/challenge states, account switch and no secret leakage passed');
