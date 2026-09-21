import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ffprobeBin, ytDlpBin } from '../server/media-binaries.ts';
import { uploadDir } from '../server/media-dir.ts';
import type { ResolvedDesktopVideoLink } from '../shared/video-link-resolver.ts';
import { safePublicFetch } from '../server/safe-public-fetch.ts';
import { wechatKeyStream } from './wechat-media-decrypt.ts';

/** Bounded native jobs; keep URLs/cookies in tool output out of UI errors. */
export function runCopyTool(executable: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error('视频解析或下载超时，请重试'); child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 2_000_000) { failure = new Error('解析结果超过大小限制'); child.kill('SIGKILL'); }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-6000); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(stderr || `下载工具退出（${code}）`));
      else resolve(stdout);
    });
  });
}

export function copyDownloadArgs(url: string, directory: string, referer?: string): string[] {
  return [
    '--ignore-config', '--no-plugin-dirs', '--no-playlist', '--playlist-items', '1',
    '--no-progress', '--no-warnings', '--socket-timeout', '20', '--retries', '1', '--fragment-retries', '1',
    '--abort-on-unavailable-fragments', '--max-filesize', '500M',
    // ASR needs speech, not a silent DASH video track. yt-dlp retains per-format
    // cookies/Referer and materializes HLS/DASH instead of treating manifests as MP4.
    '--format', 'bestaudio/best', '--output', join(directory, 'source.%(ext)s'),
    '--print', 'after_move:%(title)j', '--no-simulate',
    ...(referer ? ['--referer', referer] : []), '--', url,
  ];
}

export async function downloadVideoForCopy(url: string, options: {
  name?: string; referer?: string; cookies?: string; direct?: boolean; decodeKey?: string;
} = {}): Promise<ResolvedDesktopVideoLink> {
  const directory = uploadDir();
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(join(directory, '.copy-download-'));
  try {
    const args = copyDownloadArgs(url, temporary, options.referer);
    if (options.cookies) {
      const cookiePath = join(temporary, 'cookies.txt');
      await writeFile(cookiePath, options.cookies, { mode: 0o600 });
      args.unshift('--cookies', cookiePath);
    }
    const output = options.direct
      ? await downloadDirectMedia(url, join(temporary, 'source.mp4'), options)
      : await runCopyTool(ytDlpBin(), args, 180_000);
    const files = (await readdir(temporary)).filter((file) => /^source\.[a-z0-9]+$/i.test(file));
    if (files.length !== 1) throw new Error('没有下载到完整的媒体文件');
    const source = join(temporary, files[0]!);
    const info = await stat(source);
    if (info.size === 0 || info.size > 500 * 1024 * 1024) throw new Error('媒体为空或超过 500 MB 限制');
    const probe = JSON.parse(await runCopyTool(ffprobeBin(), [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'json', source,
    ], 20_000)) as { streams?: { codec_name?: string }[] };
    if (!probe.streams?.some((stream) => stream.codec_name)) throw new Error('下载的媒体没有可识别的音轨');
    const storedName = `copy-${randomUUID()}${extname(source)}`;
    await rename(source, join(directory, storedName));
    let title = options.name ?? '链接视频';
    try { if (!options.name) title = JSON.parse(output.trim().split('\n').at(-1) ?? '"链接视频"') as string; } catch { /* fallback */ }
    return { path: `/media/uploads/${storedName}`, name: String(title).slice(0, 200) };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function downloadDirectMedia(url: string, path: string, options: { referer?: string; decodeKey?: string }): Promise<string> {
  const key = options.decodeKey && options.decodeKey !== '0' ? wechatKeyStream(options.decodeKey) : null;
  const response = await safePublicFetch(url, {
    signal: AbortSignal.timeout(180_000), headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      ...(options.referer ? { Referer: options.referer } : {}),
    },
  });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`媒体下载失败（HTTP ${response.status}）`); }
  const reader = response.body.getReader();
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let offset = 0;
  try {
    file = await open(path, 'wx', 0o600);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > 500 * 1024 * 1024) throw new Error('媒体超过 500 MB 限制');
      if (key) for (let i = 0; i < value.length && offset+i < key.length; i++) value[i] = value[i]! ^ key[offset+i]!;
      let written = 0;
      while (written < value.length) written += (await file.write(value, written, value.length-written, offset+written)).bytesWritten;
      offset += value.length;
    }
    return '';
  } finally { await reader.cancel().catch(() => undefined); await file?.close(); }
}
