import { proxyDispatcher } from '../outbound-proxy.ts';
import { ffprobeBin } from '../media-binaries.ts';
import { isSafeUploadName, resolveUploadFile } from '../media-dir.ts';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { signVolcengineRequest, type VolcengineCredentials } from './volcengine-signature.ts';
import type { RegisterGenerationProviderTask } from './generation-jobs.ts';
import type { ValidVideoRequest } from './video-validation.ts';

const DEFAULT_BASE_URL = 'https://visual.volcengineapi.com';
const SUBJECT_REQ_KEY = 'jimeng_realman_avatar_picture_create_role_omni';
const VIDEO_REQ_KEY = 'jimeng_realman_avatar_picture_omni_v2';
const TERMINAL_FAILURES = new Set(['not_found', 'expired', 'failed']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 15;

interface JimengAvatarOptions {
  baseUrl: string;
  accessKey: string;
  secretKey: string;
}

interface VisualResponse {
  code?: number;
  message?: string;
  data?: Record<string, unknown> | null;
}

type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: unknown };
const fetchWithProxy = (url: string, init: FetchInit): Promise<Response> =>
  fetch(url, { ...init, dispatcher: proxyDispatcher() } as RequestInit);

function projectFile(path: string): string {
  const clean = path.split(/[?#]/, 1)[0] ?? '';
  if (!clean.startsWith('/media/uploads/')) throw new Error('数字人素材必须来自当前工程媒体池');
  const name = clean.slice('/media/uploads/'.length);
  if (!isSafeUploadName(name)) throw new Error('数字人素材路径无效');
  const file = resolveUploadFile(name);
  if (!file) throw new Error(`工程素材不存在: ${name}`);
  return file;
}

async function base64File(path: string, maxBytes: number, label: string): Promise<{ file: string; base64: string }> {
  const file = projectFile(path);
  const info = await stat(file);
  if (!info.isFile() || info.size <= 0) throw new Error(`${label}为空`);
  if (info.size > maxBytes) throw new Error(`${label}不能超过 ${Math.round(maxBytes / 1024 / 1024)}MB`);
  return { file, base64: (await readFile(file)).toString('base64') };
}

function audioDuration(file: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffprobeBin(), [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
    ]);
    let output = '';
    let error = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { error += String(chunk); });
    child.on('error', () => reject(new Error('无法读取数字人音频时长')));
    child.on('close', (code) => {
      const duration = Number(output.trim());
      if (code === 0 && Number.isFinite(duration) && duration > 0) resolvePromise(duration);
      else reject(new Error(`无法读取数字人音频时长${error.trim() ? `: ${error.trim().slice(-120)}` : ''}`));
    });
  });
}

async function requestVisual(
  options: JimengAvatarOptions,
  action: string,
  body: Record<string, unknown>,
): Promise<VisualResponse> {
  const credentials: VolcengineCredentials = {
    accessKeyId: options.accessKey,
    secretAccessKey: options.secretKey,
  };
  const request = signVolcengineRequest({
    baseUrl: options.baseUrl || DEFAULT_BASE_URL,
    action,
    body,
    credentials,
  });
  const response = await fetchWithProxy(request.url, {
    method: 'POST', headers: request.headers, body: request.body,
  });
  const raw = await response.text();
  let parsed: VisualResponse;
  try {
    parsed = JSON.parse(raw) as VisualResponse;
  } catch {
    throw new Error(`即梦数字人接口返回了无效响应 (${response.status})`);
  }
  if (!response.ok || (parsed.code !== undefined && parsed.code !== 10000)) {
    const message = typeof parsed.message === 'string' ? parsed.message.slice(0, 240) : `HTTP ${response.status}`;
    throw new Error(`即梦数字人请求失败: ${message}`);
  }
  return parsed;
}

function taskId(response: VisualResponse, label: string): string {
  const id = response.data?.task_id;
  if (typeof id !== 'string' && typeof id !== 'number') throw new Error(`即梦数字人${label}未返回任务 ID`);
  return String(id);
}

function statusOf(response: VisualResponse): string {
  return typeof response.data?.status === 'string' ? response.data.status : '';
}

async function waitForSubject(
  options: JimengAvatarOptions,
  task: string,
): Promise<void> {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const response = await requestVisual(options, 'CVGetResult', {
      req_key: SUBJECT_REQ_KEY,
      task_id: task,
    });
    const status = statusOf(response);
    if (TERMINAL_FAILURES.has(status)) throw new Error('即梦数字人主体识别任务已失效，请重新提交');
    if (status === 'done') {
      const raw = response.data?.resp_data;
      let subjectStatus: unknown;
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) as { status?: unknown } : raw;
        subjectStatus = parsed && typeof parsed === 'object' ? (parsed as { status?: unknown }).status : undefined;
      } catch { subjectStatus = undefined; }
      if (subjectStatus !== 1) throw new Error('图片中没有识别到清晰的单人主体，请更换正面人物照片');
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error('即梦数字人主体识别超时');
}

async function waitForVideo(
  options: JimengAvatarOptions,
  task: string,
): Promise<string> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const response = await requestVisual(options, 'CVSync2AsyncGetResult', {
      req_key: VIDEO_REQ_KEY,
      task_id: task,
    });
    const status = statusOf(response);
    if (TERMINAL_FAILURES.has(status)) throw new Error('即梦数字人视频任务已失效，请重新提交');
    if (status === 'done') {
      const url = response.data?.video_url;
      if (typeof url !== 'string' || !url) throw new Error('即梦数字人任务完成但没有返回视频地址');
      return url;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error('即梦数字人视频生成超时');
}

function supportedImage(path: string): boolean {
  return new Set(['.jpg', '.jpeg', '.png']).has(extname(basename(path)).toLowerCase());
}

function supportedAudio(path: string): boolean {
  return new Set(['.mp3', '.wav', '.m4a', '.aac']).has(extname(basename(path)).toLowerCase());
}

/** Generate a Jimeng OmniHuman 1.0 quick-mode avatar video from one image and one audio asset. */
export async function generateJimengAvatarVideo(
  input: ValidVideoRequest,
  options: JimengAvatarOptions,
  registerProviderTask: RegisterGenerationProviderTask,
  existingTaskId?: string,
): Promise<string> {
  if (!options.accessKey || !options.secretKey) throw new Error('即梦数字人未配置，请在设置 → AI 生成 → 生视频 → 即梦数字人中填写 Access Key 和 Secret Key');
  const imagePath = input.firstFramePath!;
  const audioPath = input.refAudioPaths[0]!;
  if (!supportedImage(imagePath)) throw new Error('即梦数字人图片只支持 JPG、JPEG 或 PNG');
  if (!supportedAudio(audioPath)) throw new Error('即梦数字人音频只支持 MP3、WAV、M4A 或 AAC');
  const image = await base64File(imagePath, MAX_IMAGE_BYTES, '数字人图片');
  const audio = await base64File(audioPath, 20 * 1024 * 1024, '数字人音频');
  const duration = await audioDuration(audio.file);
  if (duration > MAX_AUDIO_SECONDS + 0.05) throw new Error(`即梦数字人快速模式单段音频不能超过 ${MAX_AUDIO_SECONDS} 秒，请先分段`);

  let videoTask = existingTaskId;
  if (!videoTask) {
    const subject = await requestVisual(options, 'CVSubmitTask', {
      req_key: SUBJECT_REQ_KEY,
      image_base64: image.base64,
    });
    await waitForSubject(options, taskId(subject, '主体识别'));
    const submitted = await requestVisual(options, 'CVSync2AsyncSubmitTask', {
      req_key: VIDEO_REQ_KEY,
      image_base64: image.base64,
      audio_base64: audio.base64,
    });
    videoTask = taskId(submitted, '视频生成');
    await registerProviderTask('jimeng-avatar', videoTask);
  }
  return waitForVideo(options, videoTask);
}
