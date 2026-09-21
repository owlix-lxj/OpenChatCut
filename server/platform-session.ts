import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';
import { isPlatformManagedValue, PLATFORM_MODE_ENV } from '../shared/platform-config.ts';
import { withoutPlatformStorageScope } from './platform-storage-scope.ts';

const COOKIE_NAME = 'openchatcut_platform_session';

let desktopSessionToken: (() => string | null) | null = null;
let desktopSessionClearer: (() => void | Promise<void>) | null = null;
const requestSession = new AsyncLocalStorage<{ claims: PlatformSessionClaims; token: string }>();

export interface PlatformSessionClaims {
  type: 'launch' | 'session';
  sub: string;
  tenant_id: string;
  display_name?: string;
  material_ids?: string[];
  jti: string;
  iat: number;
  exp: number;
}

export function platformManaged(): boolean {
  return desktopSessionToken !== null || isPlatformManagedValue(process.env[PLATFORM_MODE_ENV]);
}

/**
 * Make the Electron main process the owner of the remotely signed platform
 * session. The renderer never receives this token; local server routes obtain
 * it through the provider and forward it to the API gateway as Bearer auth.
 */
export function configureDesktopPlatformSessionProvider(
  provider: (() => string | null) | null,
  clear?: () => void | Promise<void>,
): void {
  desktopSessionToken = provider;
  desktopSessionClearer = provider ? clear ?? null : null;
}

/** True only for the embedded desktop server. Platform-managed web deployments
 * have no main-process token provider and must keep using their public origin. */
export function desktopPlatformSessionConfigured(): boolean {
  return desktopSessionToken !== null;
}

export async function clearDesktopPlatformSession(): Promise<boolean> {
  if (!desktopSessionToken) return false;
  await desktopSessionClearer?.();
  return true;
}

function secret(): string {
  return process.env.OPENCHATCUT_PLATFORM_SESSION_SECRET?.trim() ?? '';
}

function signature(payload: string): Buffer {
  return createHmac('sha256', secret()).update(payload).digest();
}

export function signPlatformSession(claims: PlatformSessionClaims): string {
  if (secret().length < 32) throw new Error('OPENCHATCUT_PLATFORM_SESSION_SECRET must contain at least 32 characters');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${signature(payload).toString('base64url')}`;
}

export function verifyPlatformSession(token: string, expectedType: PlatformSessionClaims['type']): PlatformSessionClaims | null {
  if (secret().length < 32) return null;
  const [payload, encodedSignature, extra] = token.split('.');
  if (!payload || !encodedSignature || extra !== undefined) return null;
  let actual: Buffer;
  try { actual = Buffer.from(encodedSignature, 'base64url'); } catch { return null; }
  const expected = signature(payload);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<PlatformSessionClaims>;
    if (value.type !== expectedType || typeof value.sub !== 'string' || !value.sub
      || typeof value.tenant_id !== 'string' || !value.tenant_id
      || typeof value.jti !== 'string' || !value.jti
      || typeof value.iat !== 'number' || typeof value.exp !== 'number'
      || value.exp <= Math.floor(Date.now() / 1000)) return null;
    return value as PlatformSessionClaims;
  } catch {
    return null;
  }
}

/**
 * Decode claims from a token acquired directly from the HTTPS API gateway.
 * This deliberately does not authenticate the signature: desktop builds do
 * not contain the platform signing secret. Authorization still happens at the
 * gateway on every privileged request when the original token is forwarded.
 */
export function decodePlatformSessionClaims(
  token: string,
  expectedType: PlatformSessionClaims['type'],
): PlatformSessionClaims | null {
  const [payload, encodedSignature, extra] = token.split('.');
  if (!payload || !encodedSignature || extra !== undefined) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<PlatformSessionClaims>;
    if (value.type !== expectedType || typeof value.sub !== 'string' || !value.sub
      || typeof value.tenant_id !== 'string' || !value.tenant_id
      || typeof value.jti !== 'string' || !value.jti
      || typeof value.iat !== 'number' || typeof value.exp !== 'number'
      || value.exp <= Math.floor(Date.now() / 1000)) return null;
    return value as PlatformSessionClaims;
  } catch {
    return null;
  }
}

function cookieValue(req: IncomingMessage): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function platformSession(req: IncomingMessage): { claims: PlatformSessionClaims; token: string } | null {
  if (!platformManaged()) return null;
  const desktopToken = desktopSessionToken?.() ?? null;
  if (desktopToken) {
    const claims = decodePlatformSessionClaims(desktopToken, 'session');
    return claims ? { claims, token: desktopToken } : null;
  }
  const token = cookieValue(req);
  const claims = token ? verifyPlatformSession(token, 'session') : null;
  return token && claims ? { claims, token } : null;
}

export function withPlatformSession<T>(
  session: { claims: PlatformSessionClaims; token: string },
  task: () => T,
): T {
  return requestSession.run(session, task);
}

export function currentPlatformSession(): { claims: PlatformSessionClaims; token: string } | null {
  return requestSession.getStore() ?? null;
}

/** Credential for a platform-owned upstream request. Hosted web requests use
 * their request-local cookie session; Electron may safely fall back to the
 * main-process token provider because one embedded server belongs to one app. */
export function activePlatformSessionToken(): string {
  const contextual = currentPlatformSession()?.token;
  if (contextual) return contextual;
  const desktop = desktopSessionToken?.() ?? '';
  return decodePlatformSessionClaims(desktop, 'session') ? desktop : '';
}

export function mintPlatformSession(launch: PlatformSessionClaims, ttlSeconds = 8 * 60 * 60): { claims: PlatformSessionClaims; token: string } {
  const now = Math.floor(Date.now() / 1000);
  const claims: PlatformSessionClaims = {
    ...launch,
    type: 'session',
    jti: randomBytes(18).toString('base64url'),
    iat: now,
    exp: now + ttlSeconds,
  };
  return { claims, token: signPlatformSession(claims) };
}

export function platformSessionCookie(token: string, maxAge: number): string {
  const secure = process.env.OPENCHATCUT_EDITOR_URL?.trim().startsWith('https://') === true;
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearPlatformSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function platformStorageScope(claims: PlatformSessionClaims): string {
  const identity = `${claims.tenant_id}\0${claims.sub}`;
  const key = secret();
  return (key.length >= 32 ? createHmac('sha256', key).update(identity) : createHash('sha256').update(identity))
    .digest('hex').slice(0, 24);
}

/** Desktop files are device-local and must never move when login state changes.
 * Keep this compatibility wrapper for older callers while deliberately running
 * work in the ordinary, unscoped desktop profile. Hosted web requests still use
 * tenant scoping in platform-integration.ts. */
export function withDesktopPlatformStorageScope<T>(task: () => T): T {
  return withoutPlatformStorageScope(task);
}
