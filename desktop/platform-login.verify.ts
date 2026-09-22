import assert from 'node:assert/strict';
import {
  cancelPlatformLogin, consumeLoginCallback, deepLinkFromArgv, exchangeDesktopSession, platformApiBaseUrl, platformLoginUrl,
  startPlatformLogin,
} from './platform-login.ts';

// ── login URL + state round-trip ──
let opened = '';
await startPlatformLogin(async (url) => { opened = url; });
const loginUrl = new URL(opened);
assert.equal(`${loginUrl.origin}${loginUrl.pathname}`, platformLoginUrl(), 'opens the configured login page');
const state = loginUrl.searchParams.get('state');
assert.ok(state && state.length >= 16, 'a CSRF state is generated');
assert.equal(loginUrl.searchParams.get('callback'), 'openchatcut://auth');

// ── callback with the matching state yields the ticket ──
const ok = consumeLoginCallback(`openchatcut://auth?token=TICKET123&state=${state}`);
assert.deepEqual(ok, { ticket: 'TICKET123' });

// ── state is single-use: replay is rejected ──
assert.equal(consumeLoginCallback(`openchatcut://auth?token=TICKET123&state=${state}`), null, 'state is single-use');

// ── forged / mismatched links are rejected ──
await startPlatformLogin(async (url) => { opened = url; });
const s2 = new URL(opened).searchParams.get('state')!;
assert.equal(consumeLoginCallback('openchatcut://auth?token=x&state=wrong'), null, 'wrong state rejected');
assert.equal(consumeLoginCallback('https://evil.com/auth?token=x&state=' + s2), null, 'wrong protocol rejected');
assert.equal(consumeLoginCallback('openchatcut://other?token=x&state=' + s2), null, 'wrong action rejected');
assert.equal(consumeLoginCallback('openchatcut://auth?state=' + s2), null, 'missing token rejected');
// the valid one still works after the rejections above (state not consumed by failures)
assert.deepEqual(consumeLoginCallback('openchatcut://auth?token=good&state=' + s2), { ticket: 'good' });

// ── cancellation invalidates the pending browser callback ──
await startPlatformLogin(async (url) => { opened = url; });
const cancelledState = new URL(opened).searchParams.get('state')!;
assert.equal(cancelPlatformLogin(), true, 'pending challenge is cancelled');
assert.equal(cancelPlatformLogin(), false, 'cancelling again reports no pending challenge');
assert.equal(
  consumeLoginCallback(`openchatcut://auth?token=late&state=${cancelledState}`),
  null,
  'callback from a cancelled browser tab is rejected',
);

// ── argv deep-link extraction (Windows/Linux) ──
assert.equal(deepLinkFromArgv(['electron', '.', 'openchatcut://auth?token=z']), 'openchatcut://auth?token=z');
assert.equal(deepLinkFromArgv(['electron', '.']), null);

// ── launch ticket is exchanged at the gateway, never at the local server ──
const now = Math.floor(Date.now() / 1000);
const payload = Buffer.from(JSON.stringify({
  type: 'session', sub: 'user-a', tenant_id: 'tenant-a', jti: 'session-a', iat: now, exp: now + 3600,
})).toString('base64url');
let exchangeUrl = '';
let exchangeBody = '';
const exchanged = await exchangeDesktopSession('TKT', async (input, init) => {
  exchangeUrl = String(input);
  exchangeBody = String(init?.body ?? '');
  return new Response(JSON.stringify({ session_token: `${payload}.signature` }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
});
assert.equal(exchangeUrl, `${platformApiBaseUrl()}/v1/video-editor/desktop-session`);
assert.deepEqual(JSON.parse(exchangeBody), { ticket: 'TKT' });
assert.equal(exchanged.claims.tenant_id, 'tenant-a');

await assert.rejects(
  exchangeDesktopSession('bad', async () => new Response(JSON.stringify({ message: 'invalid ticket' }), {
    status: 401, headers: { 'Content-Type': 'application/json' },
  })),
  /invalid ticket/,
);

console.log('platform-login.verify: ok');
