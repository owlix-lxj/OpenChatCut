import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const VERSION = '2026.08.19';
const TARGETS = {
  'darwin-arm64': { asset: 'yt-dlp_macos', sha256: '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202', suffix: '' },
  'darwin-x64': { asset: 'yt-dlp_macos', sha256: '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202', suffix: '' },
  'win32-arm64': { asset: 'yt-dlp_arm64.exe', sha256: '05b438997bafc3affdfda9d041353c9d73e04dc842207254b655b0887c4445b0', suffix: '.exe' },
  'win32-x64': { asset: 'yt-dlp.exe', sha256: '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a', suffix: '.exe' },
  'linux-arm64': { asset: 'yt-dlp_linux_aarch64', sha256: 'b16e4dab368a816cd05d477d698a605a6ae87ccee1c8ffd38fa21d7254141fcc', suffix: '' },
  'linux-x64': { asset: 'yt-dlp_linux', sha256: '58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a', suffix: '' },
};

const targetKey = process.env.CC_EB_TARGET ?? `${process.platform}-${process.arch}`;
const target = TARGETS[targetKey];
if (!target) throw new Error(`No pinned yt-dlp binary for ${targetKey}`);
const destination = join(process.cwd(), 'public', 'yt-dlp', targetKey, `yt-dlp${target.suffix}`);
const destinationDir = dirname(destination);

await mkdir(destinationDir, { recursive: true });
for (const name of await readdir(destinationDir)) {
  if (name.startsWith('yt-dlp.') && (name.includes('.download') || name.includes('.part-'))) {
    await rm(join(destinationDir, name), { force: true });
  }
}

async function verified(path) {
  try {
    if (!(await stat(path)).isFile()) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex') === target.sha256;
  } catch {
    return false;
  }
}

async function download(url, output) {
  const head = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  const bytes = Number(head.headers.get('content-length'));
  const ranges = head.ok && head.headers.get('accept-ranges') === 'bytes' && Number.isSafeInteger(bytes)
    ? Array.from({ length: 8 }, (_, index) => {
        const start = Math.floor((bytes * index) / 8);
        const end = Math.floor((bytes * (index + 1)) / 8) - 1;
        return { start, end, path: `${output}.part-${index}` };
      })
    : [];
  if (ranges.length === 0) {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(output));
    return;
  }
  await Promise.all(ranges.map(async (range) => {
    await rm(range.path, { force: true });
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { Range: `bytes=${range.start}-${range.end}` },
      signal: AbortSignal.timeout(30 * 60_000),
    });
    if (response.status !== 206 || !response.body) throw new Error(`range download returned HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(range.path));
  }));
  await rm(output, { force: true });
  for (const range of ranges) {
    await pipeline(createReadStream(range.path), createWriteStream(output, { flags: 'a' }));
    await rm(range.path, { force: true });
  }
}

if (await verified(destination)) {
  if (process.platform !== 'win32') await chmod(destination, 0o755);
  console.log(`[yt-dlp] verified ${VERSION} for ${targetKey}`);
  process.exit(0);
}

const temporary = `${destination}.${process.pid}.download`;
await rm(temporary, { force: true });
const upstream = `https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}/${target.asset}`;
const sources = [`https://gh-proxy.com/${upstream}`, upstream];
let lastError;
for (const url of sources) {
  try {
    await rm(temporary, { force: true });
    await download(url, temporary);
    if (!(await verified(temporary))) throw new Error('download failed pinned SHA-256 verification');
    lastError = undefined;
    break;
  } catch (error) {
    lastError = error;
  }
}
if (lastError || !(await verified(temporary))) {
  await rm(temporary, { force: true });
  throw new Error(`Unable to provision yt-dlp: ${lastError instanceof Error ? lastError.message : lastError}`);
}
if (process.platform !== 'win32') await chmod(temporary, 0o755);
await rename(temporary, destination);
console.log(`[yt-dlp] downloaded and verified ${VERSION} for ${targetKey}`);
