import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { editorCredentialAuthorized, trustedEditorRequest } from '../editor-auth.ts';
import { MobileUploadService } from '../mobile-upload-service.ts';
import { desktopPlatformSessionConfigured, platformManaged } from '../platform-session.ts';
import { maxUploadBytes } from './upload.ts';

const PHONE_ROUTE = /^\/s\/[A-Za-z0-9_-]+(\/upload)?$/;

/** The public origin (scheme://host) a phone should use to reach this editor,
 * derived from the browser request that created the session. */
function publicOriginOf(req: IncomingMessage): string | undefined {
  const host = req.headers.host;
  if (!host || /[/\\@?#,\s]/.test(host)) return undefined;
  const proto = (Array.isArray(req.headers['x-forwarded-proto'])
    ? req.headers['x-forwarded-proto'][0]
    : req.headers['x-forwarded-proto'])?.trim().toLowerCase();
  return `${proto === 'http' ? 'http' : 'https'}://${host}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

type MobileUploadControls = Pick<MobileUploadService, 'createSession' | 'getSession' | 'closeSession' | 'handle'>;

function mobilePageLocale(value: string | null): 'zh' | 'en' | 'it' | 'ru' {
  return value === 'en' || value === 'it' || value === 'ru' ? value : 'zh';
}

function mobileUploadControlAuthorized(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === 'GET') {
    if (trustedEditorRequest(req, false)) return true;
    req.resume();
    sendJson(res, 403, { error: 'untrusted editor request' });
    return false;
  }
  if (req.method === 'POST' || req.method === 'DELETE') {
    if (editorCredentialAuthorized(req, true)) return true;
    req.resume();
    sendJson(res, 401, { error: 'editor credential required' });
    return false;
  }
  return true;
}

export async function handleMobileUploadControl(
  req: IncomingMessage,
  res: ServerResponse,
  service: MobileUploadControls,
): Promise<void> {
  const phoneUrl = new URL(req.url ?? '/', 'http://localhost');
  // Phone-facing routes authenticate via the unguessable session token in the
  // path (validated in service.handle), not the editor credential — serve them
  // before the editor-auth gate so a phone on any network can reach them.
  if (PHONE_ROUTE.test(phoneUrl.pathname)) {
    await service.handle(req, res);
    return;
  }
  if (!mobileUploadControlAuthorized(req, res)) return;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/sessions') {
      // The desktop editor must advertise the Mac's LAN listener. Reusing the
      // embedded request origin would produce https://127.0.0.1:5199, which is
      // both the wrong scheme and the phone's own loopback address.
      const origin = platformManaged() && !desktopPlatformSessionConfigured()
        ? publicOriginOf(req)
        : undefined;
      sendJson(res, 201, await service.createSession(
        mobilePageLocale(url.searchParams.get('locale')), origin,
      ));
      return;
    }
    const match = /^\/sessions\/([0-9a-f-]+)$/.exec(url.pathname);
    if (!match) { sendJson(res, 404, { error: 'not found' }); return; }
    if (req.method === 'GET') {
      const snapshot = service.getSession(match[1]!);
      sendJson(res, snapshot ? 200 : 404, snapshot ?? { error: 'session not found or expired' });
      return;
    }
    if (req.method === 'DELETE') {
      const snapshot = await service.closeSession(match[1]!);
      sendJson(res, snapshot ? 200 : 404, snapshot ?? { error: 'session not found or expired' });
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /no LAN IPv4/i.test(message) ? 503 : 500;
    sendJson(res, status, { error: message });
  }
}

export function mobileUploadPlugin(): Plugin {
  return {
    name: 'openchatcut-mobile-upload',
    configureServer(server) {
      const service = new MobileUploadService({
        maxBytes: maxUploadBytes(),
      });
      server.httpServer?.once('close', () => { void service.stop(); });

      server.middlewares.use('/api/mobile-upload', (req: IncomingMessage, res: ServerResponse) => {
        void handleMobileUploadControl(req, res, service);
      });
    },
  };
}
