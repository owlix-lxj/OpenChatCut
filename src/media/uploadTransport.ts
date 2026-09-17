import { t } from '../i18n/locale';
import { platformManagedClient } from '../platform/platformIntegration';
import {
  uploadedMediaLocation,
  type UploadedMediaLocation,
} from './uploadResponse';

export type UploadProgress = (ratio: number) => void;

const MULTIPART_THRESHOLD = 32 * 1024 * 1024;
const MULTIPART_CONCURRENCY = 3;
const PART_RETRIES = 4;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

interface UploadPlan {
  url: string;
  expectedPath?: string;
}

async function requestUploadPlan(
  file: File,
  onProgress?: UploadProgress,
): Promise<UploadPlan | UploadedMediaLocation> {
  try {
    const response = await fetch('/upload/presign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: file.name,
        contentType: file.type || 'application/octet-stream',
      }),
    });
    if (!response.ok) return { url: `/upload?name=${encodeURIComponent(file.name)}` };
    const slot: unknown = await response.json();
    if (!slot || typeof slot !== 'object' || !('uploadUrl' in slot)
      || typeof slot.uploadUrl !== 'string') {
      return { url: `/upload?name=${encodeURIComponent(file.name)}` };
    }
    const path = 'path' in slot && typeof slot.path === 'string' ? slot.path : undefined;
    if (!('mode' in slot) || slot.mode !== 'presign') {
      return { url: slot.uploadUrl, expectedPath: path };
    }
    try {
      await putPresigned(file, slot.uploadUrl, onProgress);
      if (!path) throw new Error('presigned upload returned no destination path');
      return await hydratePresignedUpload(path);
    } catch {
      return {
        url: 'proxyUploadUrl' in slot && typeof slot.proxyUploadUrl === 'string'
          ? slot.proxyUploadUrl
          : `/upload?name=${encodeURIComponent(file.name)}`,
        expectedPath: path,
      };
    }
  } catch {
    return { url: `/upload?name=${encodeURIComponent(file.name)}` };
  }
}

async function hydratePresignedUpload(path: string): Promise<UploadedMediaLocation> {
  const response = await fetch('/upload/hydrate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const value = await response.json().catch(() => null);
  const location = uploadedMediaLocation(value);
  if (!response.ok || !location?.sourceContentHash) {
    throw new Error(responseError(value) ?? 'uploaded media identity is unavailable');
  }
  return location;
}

/** Stream File to the same-origin proxy or a presigned object URL with progress. */
async function uploadFileSimple(
  file: File,
  onProgress?: UploadProgress,
): Promise<UploadedMediaLocation> {
  const plan = await requestUploadPlan(file, onProgress);
  if ('src' in plan) return plan;
  const { promise, resolve, reject } = deferred<UploadedMediaLocation>();
  const xhr = new XMLHttpRequest();
  const isPresigned = /^https?:\/\//i.test(plan.url) && !plan.url.includes('/upload');
  xhr.open(isPresigned ? 'PUT' : 'POST', plan.url);
  xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
  xhr.upload.onprogress = (event) => {
    if (!onProgress || !event.lengthComputable || event.total <= 0) return;
    onProgress(Math.min(1, event.loaded / event.total));
  };
  xhr.onload = () => settleSimpleUpload(xhr, file, plan, onProgress, resolve, reject);
  xhr.onerror = () => reject(new Error(t('上传失败 ({status})', { status: 0 })));
  xhr.onabort = () => reject(new Error(t('上传已取消')));
  xhr.send(file);
  return promise;
}

function settleSimpleUpload(
  xhr: XMLHttpRequest,
  file: File,
  plan: UploadPlan,
  onProgress: UploadProgress | undefined,
  resolve: (value: UploadedMediaLocation) => void,
  reject: (reason: Error) => void,
): void {
  if (xhr.status >= 200 && xhr.status < 300) {
    const parsed = uploadedMediaLocation(safeJson(xhr.responseText));
    const fallback = plan.expectedPath ?? `/media/uploads/${file.name}`;
    if (parsed || /^https?:\/\//i.test(plan.url)) {
      onProgress?.(1);
      resolve(parsed ?? { src: fallback });
      return;
    }
  }
  const message = responseError(safeJson(xhr.responseText));
  reject(new Error(message ?? (xhr.status === 413
    ? t('文件过大，无法上传')
    : t('上传失败 ({status})', { status: xhr.status }))));
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value || '{}'); } catch { return null; }
}

function responseError(value: unknown): string | undefined {
  return value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
    ? value.error
    : undefined;
}

function putPresigned(file: File, uploadUrl: string, onProgress?: UploadProgress): Promise<void> {
  const { promise, resolve, reject } = deferred<void>();
  const xhr = new XMLHttpRequest();
  xhr.open('PUT', uploadUrl);
  xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
  xhr.upload.onprogress = (event) => {
    if (!onProgress || !event.lengthComputable || event.total <= 0) return;
    onProgress(Math.min(1, event.loaded / event.total));
  };
  xhr.onload = () => {
    if (xhr.status < 200 || xhr.status >= 300) {
      reject(new Error(t('上传失败 ({status})', { status: xhr.status })));
      return;
    }
    onProgress?.(1);
    resolve();
  };
  xhr.onerror = () => reject(new Error(t('上传失败 ({status})', { status: 0 })));
  xhr.onabort = () => reject(new Error(t('上传已取消')));
  xhr.send(file);
  return promise;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = deferred<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function putPart(uploadId: string, part: number, blob: Blob): Promise<void> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= PART_RETRIES; attempt += 1) {
    try {
      const response = await fetch(
        `/upload/multipart/part?uploadId=${encodeURIComponent(uploadId)}&part=${part}`,
        { method: 'PUT', body: blob },
      );
      if (response.ok) return;
      const info = await response.json().catch(() => null);
      lastError = new Error(responseError(info) ?? `part ${part} failed (${response.status})`);
      if (response.status < 500 && response.status !== 408 && response.status !== 429) throw lastError;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= PART_RETRIES) break;
    }
    if (attempt < PART_RETRIES) await sleep(Math.min(16_000, 500 * 2 ** (attempt - 1)));
  }
  throw lastError ?? new Error(`part ${part} failed`);
}

interface MultipartSession {
  uploadId: string;
  partSize: number;
  partCount: number;
}

async function startMultipart(file: File): Promise<MultipartSession> {
  const response = await fetch('/upload/multipart/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: file.name,
      size: file.size,
      contentType: file.type || 'application/octet-stream',
    }),
  });
  const info: unknown = await response.json().catch(() => null);
  const error = responseError(info);
  if (!response.ok) {
    if (response.status === 413) throw new Error(error ?? t('文件过大，无法上传'));
    throw new Error(error ?? t('上传失败 ({status})', { status: response.status }));
  }
  if (!info || typeof info !== 'object' || !('uploadId' in info)
    || !('partSize' in info) || !('partCount' in info)
    || typeof info.uploadId !== 'string' || typeof info.partSize !== 'number'
    || typeof info.partCount !== 'number') {
    throw new Error(t('上传失败 ({status})', { status: response.status }));
  }
  return { uploadId: info.uploadId, partSize: info.partSize, partCount: info.partCount };
}

async function uploadMultipartParts(
  file: File,
  session: MultipartSession,
  onProgress?: UploadProgress,
): Promise<void> {
  const done = new Set<number>();
  let cursor = 1;
  const worker = async () => {
    while (cursor <= session.partCount) {
      const part = cursor;
      cursor += 1;
      const start = (part - 1) * session.partSize;
      const slice = file.slice(start, Math.min(file.size, start + session.partSize));
      try {
        await putPart(session.uploadId, part, slice);
      } catch (error) {
        void fetch(`/upload/multipart?uploadId=${encodeURIComponent(session.uploadId)}`, {
          method: 'DELETE',
        });
        throw error;
      }
      done.add(part);
      onProgress?.(Math.min(1, done.size / session.partCount));
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(MULTIPART_CONCURRENCY, session.partCount) },
    worker,
  ));
}

async function completeMultipart(session: MultipartSession): Promise<UploadedMediaLocation> {
  const response = await fetch('/upload/multipart/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId: session.uploadId }),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(responseError(value) ?? t('上传失败 ({status})', { status: response.status }));
  }
  const location = uploadedMediaLocation(value);
  if (!location) throw new Error(t('上传失败 ({status})', { status: response.status }));
  return location;
}

async function uploadFileMultipartAttempt(
  file: File,
  onProgress?: UploadProgress,
): Promise<UploadedMediaLocation> {
  const session = await startMultipart(file);
  await uploadMultipartParts(file, session, onProgress);
  const location = await completeMultipart(session);
  onProgress?.(1);
  return location;
}

export function isExpiredMultipartSessionError(error: unknown): boolean {
  return error instanceof Error && /upload session not found or expired/i.test(error.message);
}

export async function retryExpiredMultipartSession<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!isExpiredMultipartSessionError(error)) throw error;
  }
  try {
    return await attempt();
  } catch (error) {
    if (isExpiredMultipartSessionError(error)) throw new Error(t('上传会话已失效，请重新导入'));
    throw error;
  }
}


async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface OssPresignSlot {
  ossUpload: true;
  uploadUrl: string;
  name: string;
  path: string;
  objectKey: string;
  sourceUrl: string;
  contentType: string;
}

/**
 * Platform mode: upload straight to the tenant's OSS material library. The browser PUTs the
 * bytes to a signed OSS URL (never touching the editor server's disk), then hydrate registers
 * the object as a tenant material and returns the stable /media/uploads/<name> handle.
 */
async function uploadFileViaPlatformOss(
  file: File,
  onProgress?: UploadProgress,
): Promise<UploadedMediaLocation | null> {
  const contentType = file.type || 'application/octet-stream';
  const presignResponse = await fetch('/upload/presign', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: file.name, contentType, size: file.size }),
  });
  if (!presignResponse.ok) {
    const info = safeJson(await presignResponse.text());
    if (presignResponse.status === 413) throw new Error(responseError(info) ?? t('文件过大，无法上传'));
    // A backend that predates OSS uploads may reject the extra field or be unavailable here;
    // return null so the caller falls back to the standard upload path rather than failing.
    return null;
  }
  const slot = safeJson(await presignResponse.text()) as Partial<OssPresignSlot> | null;
  if (!slot?.ossUpload || !slot.uploadUrl || !slot.name || !slot.objectKey || !slot.sourceUrl || !slot.path) {
    // Backend does not (yet) route uploads to OSS — fall back to the standard path.
    return null;
  }
  await putPresigned(file, slot.uploadUrl, onProgress);
  const contentHash = await sha256Hex(file);
  const hydrateResponse = await fetch('/upload/hydrate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: slot.name, objectKey: slot.objectKey, sourceUrl: slot.sourceUrl,
      size: file.size, contentType, contentHash,
    }),
  });
  const info = safeJson(await hydrateResponse.text());
  if (!hydrateResponse.ok) {
    throw new Error(responseError(info) ?? t('上传失败 ({status})', { status: hydrateResponse.status }));
  }
  const location = uploadedMediaLocation(info);
  if (!location) throw new Error(t('上传失败 ({status})', { status: hydrateResponse.status }));
  onProgress?.(1);
  return location;
}

export async function uploadFile(
  file: File,
  onProgress?: UploadProgress,
): Promise<UploadedMediaLocation> {
  if (platformManagedClient()) {
    const viaOss = await uploadFileViaPlatformOss(file, onProgress);
    if (viaOss) return viaOss;
    // Backend has not enabled OSS uploads yet — fall through to the standard path.
  }
  if (file.size < MULTIPART_THRESHOLD) return uploadFileSimple(file, onProgress);
  try {
    return await retryExpiredMultipartSession(
      () => uploadFileMultipartAttempt(file, onProgress),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/404|Failed to fetch|multipart/i.test(message)) return uploadFileSimple(file, onProgress);
    throw error;
  }
}
