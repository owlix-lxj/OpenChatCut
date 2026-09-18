// Desktop platform login via the system browser + an openchatcut:// deep-link callback.
//
// Flow: renderer "登录" → startPlatformLogin() opens the platform login page in the system browser
// with a fresh CSRF `state`. The user signs in there; the page mints a launch ticket and redirects
// to openchatcut://auth?token=<ticket>&state=<state>. The OS hands that URL back to this process;
// consumeLoginCallback() validates the state and returns the ticket, which we hand to the editor
// window as ?platform_ticket=<ticket> so the renderer's existing exchangePlatformTicket() runs.
import { randomBytes } from 'node:crypto';
import type { BrowserWindow } from 'electron';

export const PLATFORM_LOGIN_PROTOCOL = 'openchatcut';

// Served by the business admin SPA (a Vue route), NOT under /openchatcut/ which nginx maps to the editor.
const DEFAULT_LOGIN_URL = 'https://admin.daost.cn/desktop-login';

/** The platform's desktop-login landing page (overridable for staging). */
export function platformLoginUrl(): string {
  const configured = process.env.OPENCHATCUT_PLATFORM_LOGIN_URL?.trim();
  return configured && /^https:\/\//i.test(configured) ? configured : DEFAULT_LOGIN_URL;
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

/** Load the editor with the launch ticket so the renderer exchanges it for a platform session. */
export function applyLoginTicket(win: BrowserWindow, origin: string, ticket: string): void {
  const url = new URL(`${origin}/`);
  url.searchParams.set('platform_ticket', ticket);
  void win.loadURL(url.toString());
}
