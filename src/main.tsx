import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { TranscriptWindowRoot } from './media/TranscriptWindowRoot';
import { loadProjectFonts } from './fonts/googleFonts';
import { hydratePlugins } from './plugins/store';
import { initSkins } from './skins';
import { ensureLocaleDict, getLocale, prefetchLocaleDicts, t } from './i18n/locale';
import { configurePlatformClientStorageScope } from './persist/sharedKvLocal';
import { DesktopLoginScreen, isDesktopPlatformRuntime } from './platform/DesktopLoginScreen';

// Kick the active locale's dictionary off FIRST so its fetch overlaps the setup
// below; the render waits on it so no frame renders untranslated copy. Only
// this one language is fetched — the other three cost nothing until switched.
const localeReady = ensureLocaleDict(getLocale());

type PlatformBootStatus = 'ok' | 'needs-desktop-login';

async function exchangePlatformTicket(): Promise<PlatformBootStatus> {
  if (typeof __PLATFORM_MANAGED__ === 'undefined' || !__PLATFORM_MANAGED__) return 'ok';
  const url = new URL(window.location.href);
  const ticket = url.searchParams.get('platform_ticket');
  let response: Response;
  if (!ticket) {
    response = await fetch('/api/platform/session', { cache: 'no-store' });
    if (!response.ok) {
      // The desktop app has no admin tab to reopen from — offer an in-app login instead.
      if (isDesktopPlatformRuntime()) return 'needs-desktop-login';
      throw new Error(t('剪辑会话已过期，请从业务后台重新打开'));
    }
  } else {
    url.searchParams.delete('platform_ticket');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    response = await fetch('/api/platform/session/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    if (!response.ok) {
      if (isDesktopPlatformRuntime()) return 'needs-desktop-login';
      throw new Error(t('剪辑会话无效或已过期，请从业务后台重新打开'));
    }
  }
  const identity = await response.json() as { tenantId?: string; userId?: string };
  configurePlatformClientStorageScope(identity.tenantId ?? '', identity.userId ?? '');
  return 'ok';
}

// Inject skin variables and apply persistent skin before rendering to avoid flashing the default color in the first frame.
initSkins();

// Register local font faces; TimelineComposition loads used Google faces on demand.
loadProjectFonts();

// The installed content plugin is registered in the runtime registry (visible to resource library/agent). Timeline rendering does not wait for it —
// The applied content has been snapshotted into state, see docs/plugin-system-design.md.

const root = document.getElementById('root');
if (!root) throw new Error('no #root');
const isTranscriptWindow = new URLSearchParams(window.location.search).has('transcript-window');
void Promise.all([localeReady, exchangePlatformTicket()]).then(([, platformStatus]) => {
  void hydratePlugins().catch(() => {});
  createRoot(root).render(
    <StrictMode>
      {platformStatus === 'needs-desktop-login' ? <DesktopLoginScreen />
        : isTranscriptWindow ? <TranscriptWindowRoot /> : <App />}
    </StrictMode>,
  );
  // Keep the additional dictionaries warm for compatibility with imported
  // projects and internal locale consumers without adding a visible language
  // switcher to the product UI.
  if (typeof requestIdleCallback === 'function') requestIdleCallback(prefetchLocaleDicts);
  else setTimeout(prefetchLocaleDicts, 2_000);
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  root.textContent = message;
});
