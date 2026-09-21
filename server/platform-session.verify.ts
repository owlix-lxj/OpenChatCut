import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';

process.env.OPENCHATCUT_PLATFORM_MODE = 'platform';
process.env.OPENCHATCUT_PLATFORM_SESSION_SECRET = 'platform-session-test-secret-at-least-32-chars';

const {
  clearDesktopPlatformSession,
  activePlatformSessionToken,
  configureDesktopPlatformSessionProvider,
  currentPlatformSession,
  decodePlatformSessionClaims,
  desktopPlatformSessionConfigured,
  mintPlatformSession,
  platformSession,
  platformStorageScope,
  signPlatformSession,
  verifyPlatformSession,
  withDesktopPlatformStorageScope,
  withPlatformSession,
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
assert.equal(decodePlatformSessionClaims(session.token, 'session')?.sub, 'user-a');
assert.equal(currentPlatformSession(), null);
await withPlatformSession(session, async () => {
  assert.equal(currentPlatformSession()?.token, session.token);
  await Promise.resolve();
  assert.equal(currentPlatformSession()?.claims.tenant_id, 'tenant-a');
});
assert.equal(currentPlatformSession(), null);
assert.notEqual(platformStorageScope(session.claims), platformStorageScope({ ...session.claims, sub: 'user-b' }));

// Desktop mode has no signing secret. The main-process provider supplies the
// gateway-issued token and the local server only decodes identity/scope.
const savedSecret = process.env.OPENCHATCUT_PLATFORM_SESSION_SECRET;
delete process.env.OPENCHATCUT_PLATFORM_SESSION_SECRET;
let activeDesktopToken: string | null = session.token;
configureDesktopPlatformSessionProvider(
  () => activeDesktopToken,
  () => { activeDesktopToken = null; },
);
assert.equal(desktopPlatformSessionConfigured(), true);
assert.equal(platformSession({ headers: {} } as never)?.claims.tenant_id, 'tenant-a');
assert.equal(activePlatformSessionToken(), session.token);
assert.notEqual(platformStorageScope(session.claims), platformStorageScope({ ...session.claims, sub: 'user-b' }));
assert.equal(
  withDesktopPlatformStorageScope(() => scopedPlatformDirectory('/srv/media')),
  '/srv/media',
  'desktop IPC filesystem work remains in the stable device-local profile',
);
configureDesktopPlatformSessionProvider(() => 'invalid-token');
assert.equal(
  withDesktopPlatformStorageScope(() => scopedPlatformDirectory('/srv/media')),
  '/srv/media',
  'desktop local storage does not depend on the remote session lifetime',
);
configureDesktopPlatformSessionProvider(null);
assert.equal(desktopPlatformSessionConfigured(), false);
assert.equal(await clearDesktopPlatformSession(), false);
assert.equal(withDesktopPlatformStorageScope(() => scopedPlatformDirectory('/srv/media')), '/srv/media');
process.env.OPENCHATCUT_PLATFORM_SESSION_SECRET = savedSecret;

let desktopCleared = 0;
configureDesktopPlatformSessionProvider(() => session.token, () => { desktopCleared += 1; });
assert.equal(await clearDesktopPlatformSession(), true);
assert.equal(desktopCleared, 1, 'desktop logout invokes its encrypted-session clearer');
configureDesktopPlatformSessionProvider(null);

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

// The desktop embedded server never verifies the remote signature. It decodes
// identity for local scoping and forwards the untouched token; the gateway is
// the authorization boundary on every platform request.
delete process.env.OPENCHATCUT_PLATFORM_SESSION_SECRET;
let gatewayDesktopToken: string | null = session.token;
configureDesktopPlatformSessionProvider(
  () => gatewayDesktopToken,
  () => { gatewayDesktopToken = null; },
);
const gateway = createServer((req, res) => {
  assert.equal(req.headers.authorization, `Bearer ${session.token}`);
  assert.equal(req.url, '/v1/video-editor/materials?page=1');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ items: [{ id: 'material-a' }] }));
});
gateway.listen(0, '127.0.0.1');
await once(gateway, 'listening');
const gatewayAddress = gateway.address();
assert(gatewayAddress && typeof gatewayAddress === 'object');
process.env.OPENCHATCUT_PLATFORM_API_BASE_URL = `http://127.0.0.1:${gatewayAddress.port}`;

const desktopApp = createMiniConnect((error) => { throw error; });
const desktopPlugin = platformIntegrationPlugin();
const configureDesktop = desktopPlugin.configureServer;
if (typeof configureDesktop !== 'function') throw new Error('platform integration plugin has no configureServer hook');
configureDesktop.call(desktopPlugin as never, { middlewares: { use: desktopApp.use.bind(desktopApp) } } as never);
const desktopServer = createServer((req, res) => desktopApp.handle(req, res));
desktopServer.listen(0, '127.0.0.1');
await once(desktopServer, 'listening');
const desktopAddress = desktopServer.address();
assert(desktopAddress && typeof desktopAddress === 'object');
const materialsResponse = await fetch(`http://127.0.0.1:${desktopAddress.port}/api/platform/materials?page=1`);
assert.equal(materialsResponse.status, 200);
assert.deepEqual(await materialsResponse.json(), { items: [{ id: 'material-a' }] });
const logoutResponse = await fetch(`http://127.0.0.1:${desktopAddress.port}/api/platform/session/logout`, {
  method: 'POST',
});
assert.equal(logoutResponse.status, 200);
const loggedOutSession = await fetch(`http://127.0.0.1:${desktopAddress.port}/api/platform/session`);
assert.equal(loggedOutSession.status, 401, 'desktop logout clears the main-process session provider');

desktopServer.close();
gateway.close();
await Promise.all([once(desktopServer, 'close'), once(gateway, 'close')]);
configureDesktopPlatformSessionProvider(null);
process.env.OPENCHATCUT_PLATFORM_SESSION_SECRET = savedSecret;
delete process.env.OPENCHATCUT_PLATFORM_API_BASE_URL;

console.log('platform session and storage scope checks passed');
