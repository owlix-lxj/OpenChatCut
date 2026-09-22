// Desktop platform login via the system browser + an openchatcut:// deep-link callback.
//
// Flow: renderer "登录" → startPlatformLogin() opens the platform login page in the system browser
// with a fresh CSRF `state`. The user signs in there; the page mints a launch ticket and redirects
// to openchatcut://auth?token=<ticket>&state=<state>. The OS hands that URL back to this process;
// consumeLoginCallback() validates the state and returns the ticket. The Electron main process
// exchanges it at the platform gateway, keeps the resulting session token out of the renderer,
// and lets the embedded server forward that token for authenticated platform API calls.
import { randomBytes } from 'node:crypto';
import { decodePlatformSessionClaims, type PlatformSessionClaims } from '../server/platform-session.ts';
import { DEFAULT_PLATFORM_API_BASE_URL } from '../shared/platform-config.ts';

export const PLATFORM_LOGIN_PROTOCOL = 'openchatcut';

// Served by the business admin SPA. The legacy /openchatcut path only redirects to its AI-cut intro page.
const DEFAULT_LOGIN_URL = 'https://admin.daost.cn/desktop-login';
/** The platform's desktop-login landing page (overridable for staging). */
export function platformLoginUrl(): string {
  const configured = process.env.OPENCHATCUT_PLATFORM_LOGIN_URL?.trim();
  return configured && /^https:\/\//i.test(configured) ? configured : DEFAULT_LOGIN_URL;
}

/** Platform API origin used by the Electron main process (never the renderer). */
export function platformApiBaseUrl(): string {
  const configured = process.env.OPENCHATCUT_PLATFORM_API_BASE_URL?.trim().replace(/\/$/, '');
  return configured && /^https:\/\//i.test(configured) ? configured : DEFAULT_PLATFORM_API_BASE_URL;
}

let pendingState: string | null = null;

/** Open the system browser to the platform login page with a fresh single-use CSRF state.
 * `open` is injected (main passes electron's shell.openExternal) so this module stays free of a
 * value import from 'electron' and remains unit-testable. */
export async function startPlatformLogin(open: (url: string) => Promise<void>): Promise<void> {
  pendingState = randomBytes(18).toString('base64url');
  const url = new URL(platformLoginUrl());
  url.searchParams.set('state', pendingState);
  url.searchParams.set('callback', `${PLATFORM_LOGIN_PROTOCOL}://auth`);
  await open(url.toString());
}

/** Cancel the active browser-login challenge. Any later callback from that browser tab is rejected. */
export function cancelPlatformLogin(): boolean {
  const hadPendingLogin = pendingState !== null;
  pendingState = null;
  return hadPendingLogin;
}

/**
 * Validate an incoming deep link and extract the launch ticket. Returns null for anything that is
 * not a well-formed openchatcut://auth callback whose state matches the pending login. The state is
 * single-use (cleared on success) so a replayed or forged link cannot inject a session.
 */
export function consumeLoginCallback(rawUrl: string): { ticket: string } | null {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== `${PLATFORM_LOGIN_PROTOCOL}:`) return null;
  const action = url.hostname || url.pathname.replace(/^\/+/, '');
  if (action !== 'auth') return null;
  const ticket = url.searchParams.get('token');
  const state = url.searchParams.get('state');
  if (!ticket || !state || !pendingState || state !== pendingState) return null;
  pendingState = null;
  return { ticket };
}

/** The first openchatcut:// URL in a process argv list (Windows/Linux deliver the deep link here). */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${PLATFORM_LOGIN_PROTOCOL}://`)) ?? null;
}

export interface DesktopPlatformSession {
  token: string;
  claims: PlatformSessionClaims;
}

/** Exchange a short-lived launch ticket at the trusted gateway. */
export async function exchangeDesktopSession(
  ticket: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopPlatformSession> {
  const response = await fetchImpl(`${platformApiBaseUrl()}/v1/video-editor/desktop-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({})) as { session_token?: unknown; error?: unknown; message?: unknown };
  if (!response.ok) {
    const detail = typeof body.message === 'string' ? body.message
      : typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new Error(`桌面登录凭据兑换失败：${detail}`);
  }
  const token = typeof body.session_token === 'string' ? body.session_token : '';
  const claims = decodePlatformSessionClaims(token, 'session');
  if (!claims) throw new Error('桌面登录凭据响应无效');
  return { token, claims };
}
