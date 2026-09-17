import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { isSafeUploadName, resolveUploadFile } from '../media-dir.ts';
import {
  clearPlatformSessionCookie,
  mintPlatformSession,
  platformManaged,
  platformSession,
  platformSessionCookie,
  verifyPlatformSession,
} from '../platform-session.ts';
import { withPlatformStorageScope } from '../platform-storage-scope.ts';
import { platformStorageScope } from '../platform-session.ts';

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
  return (process.env.OPENCHATCUT_PLATFORM_API_BASE_URL ?? '').trim().replace(/\/$/, '');
}

export async function platformRequest(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  const base = platformApiBase();
  if (!base) throw new Error('OPENCHATCUT_PLATFORM_API_BASE_URL is not configured');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(`${base}${path}`, { ...init, headers });
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

async function materials(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = platformSession(req);
  if (!session) { sendJson(res, 401, { error: 'platform session required' }); return; }
  if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }
  const query = new URL(req.url ?? '/', 'http://localhost').search;
  const response = await platformRequest(`/v1/video-editor/materials${query}`, session.token);
  res.statusCode = response.status;
  res.setHeader('Content-Type', response.headers.get('content-type') ?? 'application/json');
  res.end(Buffer.from(await response.arrayBuffer()));
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

export function platformIntegrationPlugin(): Plugin {
  return {
    name: 'openchatcut-platform-integration',
    configureServer(server) {
      if (!platformManaged()) return;
      // Establish one tenant/user scope before any upload, media, generation,
      // export, or project-store middleware runs. AsyncLocalStorage propagates
      // the scope through jobs and timers created while handling this request.
      server.middlewares.use((req, _res, next) => {
        const session = platformSession(req);
        if (!session) { next(); return; }
        withPlatformStorageScope(platformStorageScope(session.claims), next);
      });
      server.middlewares.use('/api/platform/session/exchange', (req, res) => { void exchange(req, res); });
      server.middlewares.use('/api/platform/session/logout', (_req, res) => {
        res.setHeader('Set-Cookie', clearPlatformSessionCookie());
        sendJson(res, 200, { ok: true });
      });
      server.middlewares.use('/api/platform/session', sessionInfo);
      server.middlewares.use('/api/platform/materials/export', (req, res) => { void registerExport(req, res); });
      server.middlewares.use('/api/platform/materials', (req, res) => { void materials(req, res); });
    },
  };
}
