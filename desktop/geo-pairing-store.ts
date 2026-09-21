import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { GeoPublishBridge } from './geo-publish-bridge.ts';

interface Encryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}
/** Keep pairing across app restarts without storing browser cookies or plaintext credentials. */
export async function loadGeoPairingToken(path: string, encryption: Encryption, platform = process.platform): Promise<string> {
  if (!encryption.isEncryptionAvailable() || (platform === 'linux' && encryption.getSelectedStorageBackend?.() === 'basic_text'))
    throw new Error('系统安全存储不可用，无法保存浏览器配对；请解锁钥匙串后重试');
  let info;
  try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (info) {
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 8192) throw new Error('配对文件异常，请保留文件并检查权限');
    try {
      const saved = JSON.parse(await readFile(path, 'utf8'));
      if (saved.version !== 1 || typeof saved.ciphertext !== 'string' || !/^[a-zA-Z0-9+/]+={0,2}$/.test(saved.ciphertext)) throw new Error();
      const token = encryption.decryptString(Buffer.from(saved.ciphertext, 'base64'));
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error();
      return token;
    } catch { throw new Error('无法解密浏览器配对，请检查系统钥匙串；原文件已保留'); }
  }
  const token = GeoPublishBridge.createToken();
  const ciphertext = encryption.encryptString(token).toString('base64');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try { await writeFile(path, JSON.stringify({ version: 1, ciphertext }), { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return loadGeoPairingToken(path, encryption, platform);
    throw error;
  }
  return token;
}
