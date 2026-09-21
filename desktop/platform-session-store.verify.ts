import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearDesktopPlatformSessionFile,
  desktopPlatformSessionPath,
  persistDesktopPlatformSession,
  restoreDesktopPlatformSession,
  type DesktopSessionEncryption,
} from './platform-session-store.ts';

function token(exp: number): string {
  const payload = Buffer.from(JSON.stringify({
    type: 'session', sub: 'user-a', tenant_id: 'tenant-a', jti: 'session-a',
    iat: Math.floor(Date.now() / 1000), exp,
  })).toString('base64url');
  return `${payload}.remote-signature`;
}

function fakeEncryption(available = true, backend = 'unknown'): DesktopSessionEncryption {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (value) => Buffer.from(`encrypted:${value.split('').reverse().join('')}`),
    decryptString: (value) => {
      const encoded = value.toString('utf8');
      if (!encoded.startsWith('encrypted:')) throw new Error('invalid ciphertext');
      return encoded.slice('encrypted:'.length).split('').reverse().join('');
    },
  };
}

const root = await mkdtemp(join(tmpdir(), 'ai-cut-platform-session-'));
const path = desktopPlatformSessionPath(root);
const active = token(Math.floor(Date.now() / 1000) + 3600);

await persistDesktopPlatformSession(path, active, fakeEncryption(), 'darwin');
const storedText = await readFile(path, 'utf8');
assert.equal(storedText.includes(active), false, 'the session token must never be stored as plaintext');
assert.equal(await restoreDesktopPlatformSession(path, fakeEncryption(), 'darwin'), active);
if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);

await assert.rejects(
  persistDesktopPlatformSession(path, active, fakeEncryption(false), 'darwin'),
  /secure operating-system credential encryption is unavailable/,
);
await assert.rejects(
  persistDesktopPlatformSession(path, active, fakeEncryption(true, 'basic_text'), 'linux'),
  /secure operating-system credential encryption is unavailable/,
  'Linux plaintext fallback must never persist a platform session',
);

await persistDesktopPlatformSession(path, active, fakeEncryption(), 'darwin');
assert.equal(
  await restoreDesktopPlatformSession(path, fakeEncryption(false), 'darwin'),
  null,
  'temporary keychain unavailability skips restore',
);
assert.equal((await stat(path)).isFile(), true, 'temporary keychain unavailability retains ciphertext');

await writeFile(path, JSON.stringify({ version: 1, ciphertext: 'not base64!' }), { mode: 0o600 });
assert.equal(await restoreDesktopPlatformSession(path, fakeEncryption(), 'darwin'), null);
await assert.rejects(stat(path), { code: 'ENOENT' });

await persistDesktopPlatformSession(
  path,
  token(Math.floor(Date.now() / 1000) + 1),
  fakeEncryption(),
  'darwin',
);
await new Promise((resolve) => setTimeout(resolve, 1100));
assert.equal(await restoreDesktopPlatformSession(path, fakeEncryption(), 'darwin'), null);
await assert.rejects(stat(path), { code: 'ENOENT' });

const target = join(root, 'target');
await writeFile(target, 'do not touch');
await symlink(target, path);
assert.equal(await restoreDesktopPlatformSession(path, fakeEncryption(), 'darwin'), null);
assert.equal(await readFile(target, 'utf8'), 'do not touch', 'rejecting a symlink must not remove its target');

await clearDesktopPlatformSessionFile(path);
await rm(root, { recursive: true, force: true });
