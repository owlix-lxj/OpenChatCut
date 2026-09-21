import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { loadGeoPairingToken } from './geo-pairing-store.ts';

const dir = await mkdtemp(join(tmpdir(), 'aicut-geo-store-'));
const file = join(dir, 'pairing.json');
const key = randomBytes(32), iv = randomBytes(16);
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString(value: string) { const cipher = createCipheriv('aes-256-cbc', key, iv); return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); },
  decryptString(value: Buffer) { const cipher = createDecipheriv('aes-256-cbc', key, iv); return Buffer.concat([cipher.update(value), cipher.final()]).toString('utf8'); },
};
try {
  const token = await loadGeoPairingToken(file, encryption);
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(await loadGeoPairingToken(file, encryption), token, 'restart retains pairing');
  const raw = await readFile(file, 'utf8');
  assert.equal(raw.includes(token), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(loadGeoPairingToken(file, { ...encryption, isEncryptionAvailable: () => false }), /安全存储/);
  await assert.rejects(loadGeoPairingToken(file, { ...encryption, getSelectedStorageBackend: () => 'basic_text' }, 'linux'), /安全存储/);
  assert.equal(await readFile(file, 'utf8'), raw, 'keychain unavailability never deletes saved pairing');
  const linked = join(dir, 'symlink.json');
  await symlink(file, linked);
  await assert.rejects(loadGeoPairingToken(linked, encryption), /配对文件异常/);
  await writeFile(file, 'corrupt fixture');
  await assert.rejects(loadGeoPairingToken(file, encryption), /原文件已保留/);
  assert.equal(await readFile(file, 'utf8'), 'corrupt fixture');
  console.log('geo-pairing-store: encrypted persistence/restart, secure-backend requirement and corruption preservation passed');
} finally { await rm(dir, { recursive: true, force: true }); }
