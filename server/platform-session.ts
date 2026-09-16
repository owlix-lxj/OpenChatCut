import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isPlatformManagedValue, PLATFORM_MODE_ENV } from '../shared/platform-config.ts';

const COOKIE_NAME = 'openchatcut_platform_session';

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
  return isPlatformManagedValue(process.env[PLATFORM_MODE_ENV]);
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

function cookieValue(req: IncomingMessage): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function platformSession(req: IncomingMessage): { claims: PlatformSessionClaims; token: string } | null {
  if (!platformManaged()) return null;
  const token = cookieValue(req);
  const claims = token ? verifyPlatformSession(token, 'session') : null;
  return token && claims ? { claims, token } : null;
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
  return createHmac('sha256', secret()).update(`${claims.tenant_id}\0${claims.sub}`).digest('hex').slice(0, 24);
}
