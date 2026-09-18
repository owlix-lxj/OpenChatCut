import assert from 'node:assert/strict';
import {
  applyLoginTicket, consumeLoginCallback, deepLinkFromArgv, platformLoginUrl,
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

// ── argv deep-link extraction (Windows/Linux) ──
assert.equal(deepLinkFromArgv(['electron', '.', 'openchatcut://auth?token=z']), 'openchatcut://auth?token=z');
assert.equal(deepLinkFromArgv(['electron', '.']), null);

// ── applyLoginTicket loads origin with ?platform_ticket ──
let loaded = '';
applyLoginTicket({ loadURL: (u: string) => { loaded = u; } } as unknown as Parameters<typeof applyLoginTicket>[0], 'http://127.0.0.1:5199', 'TKT');
assert.equal(loaded, 'http://127.0.0.1:5199/?platform_ticket=TKT');

console.log('platform-login.verify: ok');
