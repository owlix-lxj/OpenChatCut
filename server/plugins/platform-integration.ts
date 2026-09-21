import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { isSafeUploadName, resolveUploadFile, uploadDir } from '../media-dir.ts';
import { registerOssReference } from '../oss-references.ts';
import { DouyinResolveError, resolveDouyinShare } from '../douyin-resolver.ts';
import { maxUploadBytes } from './upload-route-http.ts';
import {
  clearPlatformSessionCookie,
  clearDesktopPlatformSession,
  desktopPlatformSessionConfigured,
  mintPlatformSession,
  platformManaged,
  platformSession,
  platformSessionCookie,
  withPlatformSession,
  verifyPlatformSession,
} from '../platform-session.ts';
import { withPlatformStorageScope } from '../platform-storage-scope.ts';
import { platformStorageScope } from '../platform-session.ts';
import { DEFAULT_PLATFORM_API_BASE_URL } from '../../shared/platform-config.ts';

const consumedLaunches = new Map<string, number>();

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function jsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) throw new Error('request body too large');
    chunks.push(value);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object');
  return parsed as Record<string, unknown>;
}

function platformApiBase(): string {
  return (process.env.OPENCHATCUT_PLATFORM_API_BASE_URL ?? DEFAULT_PLATFORM_API_BASE_URL)
    .trim().replace(/\/$/, '');
}

export async function platformRequest(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  const base = platformApiBase();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(`${base}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
}

export type PlatformMaterialType = 'VIDEO' | 'IMAGE' | 'AUDIO' | 'DOCUMENT';

/** Map a browser content type to the tenant material library's coarse type. */
export function materialTypeForContentType(contentType: string): PlatformMaterialType {
  const value = (contentType || '').toLowerCase();
  if (value.startsWith('image/')) return 'IMAGE';
  if (value.startsWith('video/')) return 'VIDEO';
  if (value.startsWith('audio/')) return 'AUDIO';
  return 'DOCUMENT';
}

export interface PlatformOssCredential {
  uploadUrl: string;
  objectKey: string;
  sourceUrl: string;
  type: PlatformMaterialType;
}

/** Sign a direct browser→OSS PUT for the tenant material library (generic upload, empty purpose). */
export async function signPlatformOssUpload(
  token: string,
  input: { fileName: string; contentType: string; sizeBytes: number },
): Promise<PlatformOssCredential> {
  const type = materialTypeForContentType(input.contentType);
  const response = await platformRequest('/v1/video-editor/material-upload-credentials', token, {
    method: 'POST',
    body: JSON.stringify({
      file_name: input.fileName,
      content_type: input.contentType,
      size_bytes: input.sizeBytes,
      type,
      purpose: '',
    }),
  });
  if (!response.ok) {
    throw new Error(`material credential request failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  const credential = await response.json() as { upload_url?: string; object_key?: string; source_url?: string };
  if (!credential.upload_url || !credential.object_key || !credential.source_url) {
    throw new Error('invalid material credential response');
  }
  return { uploadUrl: credential.upload_url, objectKey: credential.object_key, sourceUrl: credential.source_url, type };
}

/** Register an already-uploaded OSS object as a material in the tenant library. */
export async function createPlatformMaterial(
  token: string,
  input: { type: PlatformMaterialType; name: string; objectKey: string; sourceUrl: string; mimeType: string; sizeBytes: number },
): Promise<Record<string, unknown>> {
  const response = await platformRequest('/v1/video-editor/materials', token, {
    method: 'POST',
    body: JSON.stringify({
      type: input.type,
      name: input.name.replace(/\.[^/.]+$/, ''),
      object_key: input.objectKey,
      source_url: input.sourceUrl,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      tags: ['OpenChatCut'],
    }),
  });
  if (!response.ok) {
    throw new Error(`material registration failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  return await response.json() as Record<string, unknown>;
}

function pruneConsumedLaunches(now: number): void {
  for (const [id, expiresAt] of consumedLaunches) if (expiresAt <= now) consumedLaunches.delete(id);
}

async function exchange(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return; }
  try {
    const body = await jsonBody(req);
    const ticket = typeof body.ticket === 'string' ? body.ticket : '';
    const launch = verifyPlatformSession(ticket, 'launch');
    if (!launch) { sendJson(res, 401, { error: 'invalid or expired platform ticket' }); return; }
    const now = Math.floor(Date.now() / 1000);
    pruneConsumedLaunches(now);
    if (consumedLaunches.has(launch.jti)) { sendJson(res, 409, { error: 'platform ticket already used' }); return; }
    consumedLaunches.set(launch.jti, launch.exp);
    const session = mintPlatformSession(launch);
    res.setHeader('Set-Cookie', platformSessionCookie(session.token, session.claims.exp - now));
    sendJson(res, 200, {
      authenticated: true,
      tenantId: session.claims.tenant_id,
      userId: session.claims.sub,
      displayName: session.claims.display_name ?? '',
      materialIds: session.claims.material_ids ?? [],
    });
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

function sessionInfo(req: IncomingMessage, res: ServerResponse): void {
  const session = platformSession(req);
  if (!session) { sendJson(res, 401, { authenticated: false }); return; }
  sendJson(res, 200, {
    authenticated: true,
    tenantId: session.claims.tenant_id,
    userId: session.claims.sub,
    displayName: session.claims.display_name ?? '',
    materialIds: session.claims.material_ids ?? [],
  });
}

async function logout(res: ServerResponse): Promise<void> {
  try {
    await clearDesktopPlatformSession();
    res.setHeader('Set-Cookie', clearPlatformSessionCookie());
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function materials(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = platformSession(req);
  if (!session) { sendJson(res, 401, { error: 'platform session required' }); return; }
  if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }
  try {
    const query = new URL(req.url ?? '/', 'http://localhost').search;
    const response = await platformRequest(`/v1/video-editor/materials${query}`, session.token);
    res.statusCode = response.status;
    res.setHeader('Content-Type', response.headers.get('content-type') ?? 'application/json');
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    sendJson(res, 502, {
      error: 'platform materials request failed',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function uploadDigitalHumanSource(
  token: string,
  source: string,
  contentType: string,
): Promise<string> {
  const filename = basename(source);
  if (!source.startsWith('/media/uploads/') || !isSafeUploadName(filename)) {
    throw new Error('invalid local digital human source');
  }
  const file = resolveUploadFile(filename);
  if (!file) throw new Error('invalid local digital human source');
  const fileStat = await stat(file);
  if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > 1024 * 1024 * 1024) {
    throw new Error('digital human source must be a file smaller than 1 GB');
  }
  const credential = await signPlatformOssUpload(token, {
    fileName: filename,
    contentType,
    sizeBytes: fileStat.size,
  });
  const uploaded = await fetch(credential.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, 'Content-Length': String(fileStat.size) },
    body: createReadStream(file) as unknown as BodyInit,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  if (!uploaded.ok) throw new Error(`digital human source upload failed: ${uploaded.status}`);
  await createPlatformMaterial(token, {
    type: credential.type,
    name: filename,
    objectKey: credential.objectKey,
    sourceUrl: credential.sourceUrl,
    mimeType: contentType,
    sizeBytes: fileStat.size,
  });
  return credential.sourceUrl;
}

async function digitalHumans(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = platformSession(req);
  if (!session) { sendJson(res, 401, { error: 'platform session required' }); return; }
  if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) {
    sendJson(res, 405, { error: 'method not allowed' }); return;
  }
  try {
    const current = new URL(req.url ?? '/', 'http://localhost');
    const suffix = current.pathname === '/' ? '' : current.pathname;
    const target = `/v1/video-editor/digital-humans${suffix}${current.search}`;
    let body: Record<string, unknown> | undefined;
    if (req.method === 'POST') {
      body = await jsonBody(req);
      if (!suffix) {
        const avatarType = typeof body.type === 'string' ? body.type : '';
        if (avatarType === 'prompt') {
          const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
          if (!prompt) throw new Error('prompt avatar description is required');
        } else {
			const source = typeof body.source === 'string' ? body.source : '';
			const contentType = typeof body.source_content_type === 'string' ? body.source_content_type : '';
			if (!source || !contentType) throw new Error('digital human source is required');
			body.source_url = await uploadDigitalHumanSource(session.token, source, contentType);
			delete body.source;
        }
      }
    }
    const response = await platformRequest(target, session.token, {
      method: req.method,
      body: body ? JSON.stringify(body) : undefined,
    });
    res.statusCode = response.status;
    res.setHeader('Content-Type', response.headers.get('content-type') ?? 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    sendJson(res, 502, {
      error: 'digital human request failed',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function digitalHumanVoices(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const session = platformSession(req);
	if (!session) { sendJson(res, 401, { error: 'platform session required' }); return; }
	if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) { sendJson(res, 405, { error: 'method not allowed' }); return; }
	try {
		const current = new URL(req.url ?? '/', 'http://localhost');
		const suffix = current.pathname === '/' ? '' : current.pathname;
		let body: Record<string, unknown> | undefined;
		if (req.method === 'POST') {
			body = await jsonBody(req);
			if (!suffix) {
				const source = typeof body.source === 'string' ? body.source : '';
				const contentType = typeof body.source_content_type === 'string' ? body.source_content_type : '';
				if (!source || !contentType.startsWith('audio/')) throw new Error('voice clone audio source is required');
				body.source_url = await uploadDigitalHumanSource(session.token, source, contentType);
				delete body.source;
			}
		}
		const response = await platformRequest(`/v1/video-editor/digital-human-voices${suffix}${current.search}`, session.token, {
			method: req.method,
			body: body ? JSON.stringify(body) : undefined,
		});
		res.statusCode = response.status;
		res.setHeader('Content-Type', response.headers.get('content-type') ?? 'application/json');
		res.setHeader('Cache-Control', req.method === 'GET' && !suffix ? 'private, max-age=300' : 'no-store');
		res.end(Buffer.from(await response.arrayBuffer()));
	} catch (error) {
		sendJson(res, 502, { error: 'digital human voices request failed', detail: error instanceof Error ? error.message : String(error) });
	}
}

async function digitalHumanVideos(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = platformSession(req);
  if (!session) { sendJson(res, 401, { error: 'platform session required' }); return; }
  if (!['GET', 'POST'].includes(req.method ?? '')) { sendJson(res, 405, { error: 'method not allowed' }); return; }
  try {
    const current = new URL(req.url ?? '/', 'http://localhost');
    const suffix = current.pathname === '/' ? '' : current.pathname;
    const target = `/v1/video-editor/digital-human-videos${suffix}${current.search}`;
    const body = req.method === 'POST' ? await jsonBody(req, 2 * 1024 * 1024) : undefined;
    const response = await platformRequest(target, session.token, {
      method: req.method,
      body: body ? JSON.stringify(body) : undefined,
    });
    res.statusCode = response.status;
    res.setHeader('Content-Type', response.headers.get('content-type') ?? 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    sendJson(res, 502, { error: 'digital human video request failed', detail: error instanceof Error ? error.message : String(error) });
  }
}

async function digitalHumanMediaJobs(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = platformSession(req);
  if (!session) { sendJson(res, 401, { error: 'platform session required' }); return; }
  if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) { sendJson(res, 405, { error: 'method not allowed' }); return; }
  try {
    const current = new URL(req.url ?? '/', 'http://localhost');
    const suffix = current.pathname === '/' ? '' : current.pathname;
    let body: Record<string, unknown> | undefined;
    if (req.method === 'POST') {
      body = await jsonBody(req, 2 * 1024 * 1024);
      if (!suffix) {
        const videoSource = typeof body.video_source === 'string' ? body.video_source : '';
        const videoType = typeof body.video_content_type === 'string' ? body.video_content_type : '';
        if (!videoSource || !videoType.startsWith('video/')) throw new Error('local video source is required');
        body.video_url = await uploadDigitalHumanSource(session.token, videoSource, videoType);
        if (body.kind === 'lipsync') {
          const audioSource = typeof body.audio_source === 'string' ? body.audio_source : '';
          const audioType = typeof body.audio_content_type === 'string' ? body.audio_content_type : '';
          if (!audioSource || !audioType.startsWith('audio/')) throw new Error('local audio source is required');
          body.audio_url = await uploadDigitalHumanSource(session.token, audioSource, audioType);
        }
        delete body.video_source; delete body.video_content_type;
        delete body.audio_source; delete body.audio_content_type;
      }
    }
    const response = await platformRequest(`/v1/video-editor/digital-human-media-jobs${suffix}${current.search}`, session.token, {
      method: req.method, body: body ? JSON.stringify(body) : undefined,
    });
    res.statusCode = response.status;
    res.setHeader('Content-Type', response.headers.get('content-type') ?? 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    sendJson(res, 502, { error: 'digital human media request failed', detail: error instanceof Error ? error.message : String(error) });
  }
}

async function registerExport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = platformSession(req);
  if (!session) { sendJson(res, 401, { error: 'platform session required' }); return; }
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return; }
  try {
    const body = await jsonBody(req);
    const source = typeof body.path === 'string' ? body.path : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const filename = basename(source);
    if (!source.startsWith('/media/uploads/') || !isSafeUploadName(filename) || !name) {
      sendJson(res, 400, { error: 'invalid export source' }); return;
    }
    const file = resolveUploadFile(filename);
    if (!file) { sendJson(res, 400, { error: 'invalid export source' }); return; }
    const fileStat = await stat(file);
    const contentType = 'video/mp4';
    const credentialResponse = await platformRequest('/v1/video-editor/material-upload-credentials', session.token, {
      method: 'POST',
      body: JSON.stringify({ file_name: name, content_type: contentType, type: 'VIDEO', size_bytes: fileStat.size, purpose: 'OPENCHATCUT_EXPORT' }),
    });
    if (!credentialResponse.ok) throw new Error(`material credential request failed: ${credentialResponse.status}`);
    const credential = await credentialResponse.json() as { upload_url?: string; object_key?: string; source_url?: string };
    if (!credential.upload_url || !credential.object_key || !credential.source_url) throw new Error('invalid material credential response');
    const uploadResponse = await fetch(credential.upload_url, {
      method: 'PUT', headers: { 'Content-Type': contentType, 'Content-Length': String(fileStat.size) },
      body: createReadStream(file) as unknown as BodyInit, duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    if (!uploadResponse.ok) throw new Error(`material upload failed: ${uploadResponse.status}`);
    const createResponse = await platformRequest('/v1/video-editor/materials', session.token, {
      method: 'POST',
      body: JSON.stringify({ type: 'VIDEO', name: name.replace(/\.[^/.]+$/, ''), object_key: credential.object_key, source_url: credential.source_url, mime_type: contentType, size_bytes: fileStat.size, tags: ['OpenChatCut'] }),
    });
    if (!createResponse.ok) throw new Error(`material registration failed: ${createResponse.status}`);
    sendJson(res, 201, await createResponse.json());
  } catch (error) {
    sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
  }
}

const DOUYIN_VIDEO_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/124.0.0.0 Safari/537.36';

/**
 * Import a Douyin share link as a tenant material: resolve the watermark-free URL, fetch the
 * video server-side (Douyin needs a referer, so the browser cannot), stream it straight to the
 * tenant OSS library (no local disk), register it as a material, and return the /media/uploads
 * handle plus the caption (文案) for the caller to transcribe or display.
 */
async function importDouyin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = platformSession(req);
  if (!session) { sendJson(res, 401, { error: 'platform session required' }); return; }
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return; }
  try {
    const body = await jsonBody(req);
    const shareText = typeof body.shareText === 'string' ? body.shareText
      : typeof body.url === 'string' ? body.url : '';
    const registerMaterial = body.registerMaterial !== false;
    if (!shareText.trim()) { sendJson(res, 400, { error: 'shareText is required', code: 'invalid' }); return; }

    const resolved = await resolveDouyinShare(shareText);
    const videoResponse = await fetch(resolved.videoUrl, {
      headers: { 'User-Agent': DOUYIN_VIDEO_UA, Referer: 'https://www.douyin.com/' },
      redirect: 'follow',
    });
    if (!videoResponse.ok || !videoResponse.body) {
      throw new DouyinResolveError('download', `无水印视频下载失败 HTTP ${videoResponse.status}`);
    }

    const contentType = 'video/mp4';
    const maxBytes = maxUploadBytes();
    const declared = Number(videoResponse.headers.get('content-length')) || 0;
    if (declared > maxBytes) throw new DouyinResolveError('too_large', '视频超出大小上限');
    const storedName = `${randomUUID()}.mp4`;
    const credential = await signPlatformOssUpload(session.token, {
      fileName: `${resolved.title}.mp4`, contentType, sizeBytes: declared,
    });

    const hash = createHash('sha256');
    let bytes = 0;
    const reader = videoResponse.body.getReader();
    let putBody: BodyInit;
    let putHeaders: Record<string, string>;
    if (declared > 0) {
      async function* streamed(): AsyncGenerator<Buffer> {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            bytes += value.length;
            if (bytes > maxBytes) throw new DouyinResolveError('too_large', '视频超出大小上限');
            hash.update(value);
            yield Buffer.from(value);
          }
        }
      }
      putBody = Readable.from(streamed()) as unknown as BodyInit;
      putHeaders = { 'Content-Type': contentType, 'Content-Length': String(declared) };
    } else {
      const chunks: Buffer[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          bytes += value.length;
          if (bytes > maxBytes) throw new DouyinResolveError('too_large', '视频超出大小上限');
          hash.update(value);
          chunks.push(Buffer.from(value));
        }
      }
      putBody = Buffer.concat(chunks);
      putHeaders = { 'Content-Type': contentType, 'Content-Length': String(bytes) };
    }

    const putResponse = await fetch(credential.uploadUrl, {
      method: 'PUT', headers: putHeaders, body: putBody, duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    if (!putResponse.ok) throw new DouyinResolveError('oss', `OSS 上传失败 HTTP ${putResponse.status}`);

    const contentHash = hash.digest('hex');
    if (registerMaterial) {
      await createPlatformMaterial(session.token, {
        type: 'VIDEO', name: resolved.title, objectKey: credential.objectKey,
        sourceUrl: credential.sourceUrl, mimeType: contentType, sizeBytes: bytes,
      });
    }
    await registerOssReference(uploadDir(), storedName, {
      sourceUrl: credential.sourceUrl, objectKey: credential.objectKey, bytes, contentType, contentHash,
    });
    sendJson(res, 201, {
      ok: true, path: `/media/uploads/${storedName}`, name: resolved.title,
      title: resolved.title, videoId: resolved.videoId, sourceUrl: credential.sourceUrl,
      bytes, contentHash,
    });
  } catch (error) {
    const code = error instanceof DouyinResolveError ? error.code : 'import_failed';
    const status = code === 'invalid' ? 400 : 502;
    sendJson(res, status, { error: error instanceof Error ? error.message : String(error), code });
  }
}

export function platformIntegrationPlugin(): Plugin {
  return {
    name: 'openchatcut-platform-integration',
    configureServer(server) {
      if (!platformManaged()) return;
      // Hosted deployments isolate tenant storage. The Electron server is a
      // single-device local workspace: its login token authorizes remote API
      // calls only and must never change local project/media paths.
      if (!desktopPlatformSessionConfigured()) {
        server.middlewares.use((req, _res, next) => {
          const session = platformSession(req);
          if (!session) { next(); return; }
        withPlatformSession(session, () => withPlatformStorageScope(platformStorageScope(session.claims), next));
        });
      }
      server.middlewares.use('/api/platform/session/exchange', (req, res) => { void exchange(req, res); });
      server.middlewares.use('/api/platform/session/logout', (_req, res) => { void logout(res); });
      server.middlewares.use('/api/platform/session', sessionInfo);
      server.middlewares.use('/api/platform/materials/export', (req, res) => { void registerExport(req, res); });
      server.middlewares.use('/api/platform/import-douyin', (req, res) => { void importDouyin(req, res); });
      server.middlewares.use('/api/platform/digital-humans', (req, res) => { void digitalHumans(req, res); });
	  server.middlewares.use('/api/platform/digital-human-voices', (req, res) => { void digitalHumanVoices(req, res); });
      server.middlewares.use('/api/platform/digital-human-videos', (req, res) => { void digitalHumanVideos(req, res); });
      server.middlewares.use('/api/platform/digital-human-media-jobs', (req, res) => { void digitalHumanMediaJobs(req, res); });
      server.middlewares.use('/api/platform/materials', (req, res) => { void materials(req, res); });
    },
  };
}
