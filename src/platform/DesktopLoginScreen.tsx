import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n/locale';
import { theme } from '../theme';
import { DesktopWindowControls } from '../components/DesktopWindowControls';

interface DesktopBridge {
  platformLogin(): Promise<void>;
  cancelPlatformLogin(): Promise<{ status: 'cancelled'; invalidated: boolean }>;
}

function desktopBridge(): DesktopBridge | null {
  const bridge = (window as unknown as { openChatCutDesktop?: Partial<DesktopBridge> }).openChatCutDesktop;
  return bridge
    && typeof bridge.platformLogin === 'function'
    && typeof bridge.cancelPlatformLogin === 'function'
    ? bridge as DesktopBridge
    : null;
}

/** Whether this build is the platform-connected desktop app and needs an explicit login. */
export function isDesktopPlatformRuntime(): boolean {
  return desktopBridge() !== null;
}

/**
 * Shown when the desktop app is in platform mode without a session. The button opens the platform
 * login page in the system browser; after sign-in the openchatcut:// callback reloads this window
 * with a launch ticket, so this screen simply waits for that reload.
 */
export function DesktopLoginScreen() {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const autoStarted = useRef(false);
  const login = useCallback(async (): Promise<void> => {
    const bridge = desktopBridge();
    if (!bridge) { setError(t('无法调用桌面登录')); return; }
    setError('');
    setOpening(true);
    try {
      await bridge.platformLogin();
    } catch {
      setError(t('打开登录页失败，请重试'));
      setOpening(false);
    }
  }, []);
  const cancelLogin = useCallback(async (): Promise<void> => {
    const bridge = desktopBridge();
    if (!bridge) { setError(t('无法调用桌面登录')); return; }
    setError('');
    try {
      await bridge.cancelPlatformLogin();
      setOpening(false);
    } catch {
      setError(t('取消授权登录失败，请重试'));
    }
  }, []);
  useEffect(() => {
    if (autoStarted.current) return;
    autoStarted.current = true;
    void login();
  }, [login]);
  const platform = window.openChatCutDesktop?.platform;
  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'grid', placeItems: 'center',
      background: theme.bg, color: theme.text, fontFamily: 'Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      <header
        className={`cc-window-titlebar${platform === 'darwin' ? ' cc-window-titlebar--mac' : platform === 'win32' ? ' cc-window-titlebar--win' : ''}`}
        style={{ position: 'fixed', inset: '0 0 auto 0', height: 42, display: 'flex', alignItems: 'center', padding: '0 16px', borderBottom: `0.5px solid ${theme.border}`, background: theme.panel }}
      >
        <span style={{ fontSize: 12, fontWeight: 650, color: theme.textMuted }}>AI-cut</span>
        <DesktopWindowControls />
      </header>
      <div style={{
        width: 'min(420px, 92vw)', background: theme.panel, border: `1px solid ${theme.border}`,
        borderRadius: 18, padding: 32, textAlign: 'center', boxShadow: '0 24px 80px rgba(var(--cc-shadow-rgb),0.52)',
      }}>
        <div style={{ fontSize: 24, fontWeight: 700, marginBottom: 10 }}>AI-cut</div>
        <p style={{ color: theme.textMuted, lineHeight: 1.6, margin: '0 0 24px' }}>
          {t('登录你的账号以使用业务素材与云端能力')}
        </p>
        <button
          type="button"
          onClick={() => { void (opening ? cancelLogin() : login()); }}
          style={{
            width: '100%', background: opening ? theme.accentDeep : theme.accent, color: theme.onAccent, border: 0,
            borderRadius: 10, padding: '13px 18px', fontSize: 15, fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          {opening ? t('取消授权登录') : t('发起授权登录')}
        </button>
        {opening && (
          <p style={{ color: theme.textDim, fontSize: 13, margin: '16px 0 0', lineHeight: 1.6 }}>
            {t('请在打开的浏览器中完成登录，登录后会自动返回应用。')}
          </p>
        )}
        {error && <p style={{ color: theme.danger, fontSize: 13, margin: '16px 0 0' }}>{error}</p>}
      </div>
    </div>
  );
}
