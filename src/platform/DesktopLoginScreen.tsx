import { useState } from 'react';
import { t } from '../i18n/locale';

interface DesktopBridge {
  platformLogin(): Promise<void>;
}

function desktopBridge(): DesktopBridge | null {
  const bridge = (window as unknown as { openChatCutDesktop?: Partial<DesktopBridge> }).openChatCutDesktop;
  return bridge && typeof bridge.platformLogin === 'function' ? bridge as DesktopBridge : null;
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
  const login = async (): Promise<void> => {
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
  };
  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'grid', placeItems: 'center',
      background: '#0b0b0c', color: '#f5f5f5', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      <div style={{
        width: 'min(420px, 92vw)', background: '#171719', border: '1px solid #303034',
        borderRadius: 18, padding: 32, textAlign: 'center', boxShadow: '0 24px 80px #0008',
      }}>
        <div style={{ fontSize: 24, fontWeight: 700, marginBottom: 10 }}>AI-cut</div>
        <p style={{ color: '#aaa', lineHeight: 1.6, margin: '0 0 24px' }}>
          {t('登录你的账号以使用业务素材与云端能力')}
        </p>
        <button
          type="button"
          onClick={() => { void login(); }}
          disabled={opening}
          style={{
            width: '100%', background: opening ? '#8a3f1e' : '#f26a2e', color: '#fff', border: 0,
            borderRadius: 10, padding: '13px 18px', fontSize: 15, fontWeight: 700,
            cursor: opening ? 'default' : 'pointer',
          }}
        >
          {opening ? t('已在浏览器中打开登录…') : t('登录')}
        </button>
        {opening && (
          <p style={{ color: '#888', fontSize: 13, margin: '16px 0 0', lineHeight: 1.6 }}>
            {t('请在打开的浏览器中完成登录，登录后会自动返回应用。')}
          </p>
        )}
        {error && <p style={{ color: '#ff7b72', fontSize: 13, margin: '16px 0 0' }}>{error}</p>}
      </div>
    </div>
  );
}
