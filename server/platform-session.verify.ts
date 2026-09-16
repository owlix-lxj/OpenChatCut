import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';

process.env.OPENCHATCUT_PLATFORM_MODE = 'platform';
process.env.OPENCHATCUT_PLATFORM_SESSION_SECRET = 'platform-session-test-secret-at-least-32-chars';

const {
  mintPlatformSession,
  platformStorageScope,
  signPlatformSession,
  verifyPlatformSession,
} = await import('./platform-session.ts');
const {
  logicalProjectStoreKey,
  physicalProjectStoreKey,
  scopedPlatformDirectory,
  withPlatformStorageScope,
} = await import('./platform-storage-scope.ts');
const { uploadObjectKey } = await import('./r2.ts');
const { externalMcpAuthorized } = await import('./editor-auth.ts');
const { createMiniConnect } = await import('../desktop/mini-connect.ts');
const { platformIntegrationPlugin } = await import('./plugins/platform-integration.ts');
const {
  configurePlatformClientStorageScope,
  localGet,
  localKeys,
  localSet,
  resetLocalKvMemory,
} = await import('../src/persist/sharedKvLocal.ts');

const now = Math.floor(Date.now() / 1000);
const launch = {
  type: 'launch' as const,
  sub: 'user-a',
  tenant_id: 'tenant-a',
  jti: 'launch-a',
  iat: now,
  exp: now + 120,
};
const ticket = signPlatformSession(launch);
assert.deepEqual(verifyPlatformSession(ticket, 'launch'), launch);
assert.equal(verifyPlatformSession(`${ticket.slice(0, -1)}x`, 'launch'), null);
assert.equal(verifyPlatformSession(ticket, 'session'), null);

const session = mintPlatformSession(launch, 3600);
assert.equal(verifyPlatformSession(session.token, 'session')?.tenant_id, 'tenant-a');
assert.notEqual(platformStorageScope(session.claims), platformStorageScope({ ...session.claims, sub: 'user-b' }));

await withPlatformStorageScope('scope-a', async () => {
  assert.equal(physicalProjectStoreKey('project:one'), 'platform-scope:scope-a:project:one');
  assert.equal(logicalProjectStoreKey('platform-scope:scope-a:project:one'), 'project:one');
  assert.equal(logicalProjectStoreKey('platform-scope:scope-b:project:one'), null);
  assert.equal(scopedPlatformDirectory('/srv/media'), '/srv/media/platform-scopes/scope-a');
  assert.equal(uploadObjectKey('clip.mp4'), 'platform-scopes/scope-a/uploads/clip.mp4');
});
assert.equal(physicalProjectStoreKey('project:one'), 'project:one');
assert.equal(scopedPlatformDirectory('/srv/media'), '/srv/media');
assert.equal(uploadObjectKey('clip.mp4'), 'uploads/clip.mp4');
assert.equal(externalMcpAuthorized({ headers: { authorization: 'Bearer global-token' } } as never), false);

const previousClientMode = (globalThis as { __PLATFORM_MANAGED__?: boolean }).__PLATFORM_MANAGED__;
try {
  (globalThis as { __PLATFORM_MANAGED__?: boolean }).__PLATFORM_MANAGED__ = true;
  await assert.rejects(localGet('projects'), /identity is not established/);
  configurePlatformClientStorageScope('tenant-a', 'user-a');
  await localSet('projects', ['one']);
  assert.deepEqual(await localGet('projects'), ['one']);
  assert.deepEqual(await localKeys(), ['projects']);
  configurePlatformClientStorageScope('tenant-b', 'user-b');
  assert.equal(await localGet('projects'), undefined);
  assert.deepEqual(await localKeys(), []);
} finally {
  if (previousClientMode === undefined) delete (globalThis as { __PLATFORM_MANAGED__?: boolean }).__PLATFORM_MANAGED__;
  else (globalThis as { __PLATFORM_MANAGED__?: boolean }).__PLATFORM_MANAGED__ = previousClientMode;
  resetLocalKvMemory();
}

const app = createMiniConnect((error) => { throw error; });
const plugin = platformIntegrationPlugin();
const configure = plugin.configureServer;
if (typeof configure !== 'function') throw new Error('platform integration plugin has no configureServer hook');
configure.call(plugin as never, { middlewares: { use: app.use.bind(app) } } as never);
app.use('/scope', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    directory: scopedPlatformDirectory('/srv/media'),
    objectKey: uploadObjectKey('clip.mp4'),
  }));
});
const httpServer = createServer((req, res) => app.handle(req, res));
httpServer.listen(0, '127.0.0.1');
await once(httpServer, 'listening');
const address = httpServer.address();
assert(address && typeof address === 'object');
const scopedResponse = await fetch(`http://127.0.0.1:${address.port}/scope`, {
  headers: { Cookie: `openchatcut_platform_session=${encodeURIComponent(session.token)}` },
});
assert.equal(scopedResponse.status, 200);
assert.deepEqual(await scopedResponse.json(), {
  directory: `/srv/media/platform-scopes/${platformStorageScope(session.claims)}`,
  objectKey: `platform-scopes/${platformStorageScope(session.claims)}/uploads/clip.mp4`,
});
httpServer.close();
await once(httpServer, 'close');

console.log('platform session and storage scope checks passed');
