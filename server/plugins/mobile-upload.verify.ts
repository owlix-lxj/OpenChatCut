import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { MobileUploadSessionSnapshot } from '../mobile-upload-service';
import { configureDesktopPlatformSessionProvider } from '../platform-session';
import { handleMobileUploadControl } from './mobile-upload';

const snapshot: MobileUploadSessionSnapshot = {
  id: 'a',
  urls: ['http://192.0.2.1:1234/s/opaque-token'],
  expiresAt: Date.now() + 60_000,
  files: [],
};
let creates = 0;
let reads = 0;
let deletes = 0;
const createdLocales: string[] = [];
const createdOrigins: Array<string | undefined> = [];
const controls = {
  async createSession(locale: 'zh' | 'en' | 'it' | 'ru' = 'zh', publicOrigin?: string) {
    creates += 1;
    createdLocales.push(locale);
    createdOrigins.push(publicOrigin);
    return snapshot;
  },
  getSession(id: string) {
    reads += 1;
    assert.equal(id, snapshot.id);
    return snapshot;
  },
  async closeSession(id: string) {
    deletes += 1;
    assert.equal(id, snapshot.id);
    return snapshot;
  },
};
const server = createServer((req, res) => {
  void handleMobileUploadControl(req, res, controls);
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;

try {
  const created = await fetch(`${origin}/sessions?locale=en`, {
    method: 'POST',
    headers: { origin },
  });
  assert.equal(created.status, 201);
  assert.equal(creates, 1, 'same-origin editor requests can create a session');
  assert.equal(createdOrigins[0], undefined, 'ordinary local mode advertises LAN URLs');

  const now = Math.floor(Date.now() / 1000);
  const desktopPayload = Buffer.from(JSON.stringify({
    type: 'session', sub: 'user-a', tenant_id: 'tenant-a', jti: 'desktop-test',
    iat: now, exp: now + 300,
  })).toString('base64url');
  configureDesktopPlatformSessionProvider(() => `${desktopPayload}.remote-signature`);
  const desktopCreated = await fetch(`${origin}/sessions?locale=en`, {
    method: 'POST', headers: { origin },
  });
  assert.equal(desktopCreated.status, 201);
  assert.equal(
    createdOrigins[1], undefined,
    'desktop platform mode must advertise the Mac LAN listener, not its loopback request origin',
  );
  configureDesktopPlatformSessionProvider(null);

  const missingOrigin = await fetch(`${origin}/sessions?locale=en`, { method: 'POST' });
  assert.equal(missingOrigin.status, 401);
  assert.equal(creates, 2, 'mutations without Origin cannot create a session');

  const crossSite = await fetch(`${origin}/sessions?locale=en`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 401);
  assert.equal(creates, 2, 'a cross-site simple POST cannot create a session');

  const reboundCreate = await fetch(`${origin}/sessions?locale=en`, {
    method: 'POST',
    headers: { host: 'evil.example', origin: 'http://evil.example' },
  });
  assert.equal(reboundCreate.status, 401);
  assert.equal(creates, 2, 'matching attacker Host and Origin cannot create a session');

  const read = await fetch(`${origin}/sessions/${snapshot.id}`);
  assert.equal(read.status, 200);
  assert.equal(reads, 1, 'canonical trusted editor reads may omit Origin');

  const crossSiteRead = await fetch(`${origin}/sessions/${snapshot.id}`, {
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSiteRead.status, 403);
  assert.equal(reads, 1, 'cross-site pages cannot read a session');

  const reboundRead = await fetch(`${origin}/sessions/${snapshot.id}`, {
    headers: { host: 'evil.example', origin: 'http://evil.example' },
  });
  assert.equal(reboundRead.status, 403);
  assert.equal(reads, 1, 'matching attacker Host and Origin cannot read a session');

  const deleted = await fetch(`${origin}/sessions/${snapshot.id}`, {
    method: 'DELETE',
    headers: { origin },
  });
  assert.equal(deleted.status, 200);
  assert.equal(deletes, 1, 'same-origin editor requests can delete a session');

  const missingDeleteOrigin = await fetch(`${origin}/sessions/${snapshot.id}`, { method: 'DELETE' });
  assert.equal(missingDeleteOrigin.status, 401);
  assert.equal(deletes, 1, 'mutations without Origin cannot delete a session');

  const reboundDelete = await fetch(`${origin}/sessions/${snapshot.id}`, {
    method: 'DELETE',
    headers: { host: 'evil.example', origin: 'http://evil.example' },
  });
  assert.equal(reboundDelete.status, 401);
  assert.equal(deletes, 1, 'matching attacker Host and Origin cannot delete a session');

  const russian = await fetch(`${origin}/sessions?locale=ru`, {
    method: 'POST', headers: { origin },
  });
  assert.equal(russian.status, 201);
  const italian = await fetch(`${origin}/sessions?locale=it`, {
    method: 'POST', headers: { origin },
  });
  assert.equal(italian.status, 201);
  assert.deepEqual(createdLocales, ['en', 'en', 'ru', 'it']);
} finally {
  configureDesktopPlatformSessionProvider(null);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log('mobile-upload.verify: ok');
