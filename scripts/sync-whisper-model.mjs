import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Desktop AI-cut ships the full-precision Whisper large-v3 model used by
// whisper.cpp. This is intentionally the accuracy-first model: Turbo and
// quantized variants are smaller/faster, but they are not the product choice
// for transcript extraction. Browser-only ONNX graphs are not bundled because
// Electron uses the native whisper.cpp path.
const MODEL = {
  fileName: 'ggml-large-v3.bin',
  bytes: 3_095_033_483,
  sha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2',
  revision: '5359861c739e955e79d9a303bcbc70fb988958b1',
};

const destination = join(process.cwd(), 'public', 'whisper-models', MODEL.fileName);

async function cleanInterruptedDownloads() {
  const directory = dirname(destination);
  await mkdir(directory, { recursive: true });
  for (const name of await readdir(directory)) {
    if (name.startsWith(`${MODEL.fileName}.`)
      && (name.includes('.download') || name.includes('.part-'))) {
      await rm(join(directory, name), { force: true });
    }
  }
}

async function verified(path) {
  try {
    if ((await stat(path)).size !== MODEL.bytes) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex') === MODEL.sha256;
  } catch {
    return false;
  }
}

async function adopt(path) {
  if (!(await verified(path))) return false;
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await rm(temporary, { force: true });
  await copyFile(path, temporary);
  await rename(temporary, destination);
  return true;
}

async function download(url, output) {
  const head = await fetch(url, {
    method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(60_000),
  });
  const bytes = Number(head.headers.get('content-length'));
  const ranges = head.ok && head.headers.get('accept-ranges') === 'bytes'
    && Number.isSafeInteger(bytes) && bytes === MODEL.bytes
    ? Array.from({ length: 32 }, (_, index) => ({
        start: Math.floor((bytes * index) / 32),
        end: Math.floor((bytes * (index + 1)) / 32) - 1,
        path: `${output}.part-${index}`,
      }))
    : [];
  if (ranges.length === 0) {
    const response = await fetch(url, {
      redirect: 'follow', signal: AbortSignal.timeout(45 * 60_000),
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(output));
    return;
  }
  try {
    await Promise.all(ranges.map(async (range) => {
      await rm(range.path, { force: true });
      const response = await fetch(url, {
        redirect: 'follow',
        headers: { Range: `bytes=${range.start}-${range.end}` },
        signal: AbortSignal.timeout(45 * 60_000),
      });
      if (response.status !== 206 || !response.body) {
        throw new Error(`range download returned HTTP ${response.status}`);
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(range.path));
    }));
    await rm(output, { force: true });
    for (const range of ranges) {
      await pipeline(createReadStream(range.path), createWriteStream(output, { flags: 'a' }));
    }
  } finally {
    await Promise.all(ranges.map((range) => rm(range.path, { force: true })));
  }
}

if (await verified(destination)) {
  await cleanInterruptedDownloads();
  console.log(`[whisper-model] verified ${MODEL.fileName}`);
  process.exit(0);
}

const cacheRoot = join(homedir(), '.openchatcut', 'asr-models');
const localCandidates = [
  join(cacheRoot, 'ggml', MODEL.fileName),
  join(cacheRoot, 'ggerganov', 'whisper.cpp', MODEL.fileName),
];
for (const candidate of localCandidates) {
  if (await adopt(candidate)) {
    console.log(`[whisper-model] staged verified local ${MODEL.fileName}`);
    process.exit(0);
  }
}

await mkdir(dirname(destination), { recursive: true });
const temporary = `${destination}.${process.pid}.download`;
const encodedRevision = encodeURIComponent(MODEL.revision);
const encodedFile = encodeURIComponent(MODEL.fileName);
const sources = [
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/${encodedRevision}/${encodedFile}`,
  `https://hf-mirror.com/ggerganov/whisper.cpp/resolve/${encodedRevision}/${encodedFile}`,
];
let lastError;
for (const source of sources) {
  try {
    await rm(temporary, { force: true });
    await download(source, temporary);
    if (!(await verified(temporary))) throw new Error('downloaded file failed size/SHA-256 verification');
    await rename(temporary, destination);
    console.log(`[whisper-model] downloaded and verified ${MODEL.fileName}`);
    process.exit(0);
  } catch (error) {
    lastError = error;
  }
}
await rm(temporary, { force: true });
throw new Error(`Unable to provision bundled Whisper model: ${lastError instanceof Error ? lastError.message : lastError}`);
