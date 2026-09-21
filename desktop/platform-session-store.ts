import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { decodePlatformSessionClaims } from '../server/platform-session.ts';

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 64 * 1024;
export const DESKTOP_PLATFORM_SESSION_FILE = 'platform-session-v1.json';

export interface DesktopSessionEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

interface StoredDesktopSession {
  readonly version: 1;
  readonly ciphertext: string;
}

export function desktopPlatformSessionPath(userDataPath: string): string {
  return join(userDataPath, DESKTOP_PLATFORM_SESSION_FILE);
}

function secureEncryptionAvailable(
  encryption: DesktopSessionEncryption,
  platform: NodeJS.Platform,
): boolean {
  if (!encryption.isEncryptionAvailable()) return false;
  return platform !== 'linux' || encryption.getSelectedStorageBackend?.() !== 'basic_text';
}

function strictStoredSession(value: unknown): StoredDesktopSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<StoredDesktopSession>;
  if (Object.keys(record).sort().join(',') !== 'ciphertext,version'
    || record.version !== STORE_VERSION
    || typeof record.ciphertext !== 'string'
    || record.ciphertext.length === 0
    || record.ciphertext.length > MAX_STORE_BYTES
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.ciphertext)) return null;
  return record as StoredDesktopSession;
}

export async function clearDesktopPlatformSessionFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function persistDesktopPlatformSession(
  path: string,
  token: string,
  encryption: DesktopSessionEncryption,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const claims = decodePlatformSessionClaims(token, 'session');
  if (!claims) throw new Error('refusing to persist an invalid or expired desktop platform session');
  if (!secureEncryptionAvailable(encryption, platform)) {
    throw new Error('secure operating-system credential encryption is unavailable');
  }
  const ciphertext = encryption.encryptString(token).toString('base64');
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ version: STORE_VERSION, ciphertext })}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function restoreDesktopPlatformSession(
  path: string,
  encryption: DesktopSessionEncryption,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_STORE_BYTES) {
    await clearDesktopPlatformSessionFile(path);
    return null;
  }
  // A temporarily unavailable Keychain/password manager should not destroy a
  // valid session that can be restored on the next launch.
  if (!secureEncryptionAvailable(encryption, platform)) return null;
  try {
    const stored = strictStoredSession(JSON.parse(await readFile(path, 'utf8')));
    if (!stored) throw new Error('invalid encrypted session envelope');
    const token = encryption.decryptString(Buffer.from(stored.ciphertext, 'base64'));
    if (!decodePlatformSessionClaims(token, 'session')) throw new Error('invalid or expired session');
    await chmod(path, 0o600).catch(() => undefined);
    return token;
  } catch {
    await clearDesktopPlatformSessionFile(path);
    return null;
  }
}
