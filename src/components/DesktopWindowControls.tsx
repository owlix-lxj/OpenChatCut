import { useT } from '../i18n/locale';

type DesktopWindowAction = 'close' | 'minimize' | 'toggle-maximize';

interface DesktopWindowControlButtonsProps {
  translate: (text: string) => string;
  onAction: (action: DesktopWindowAction) => void;
  platform?: 'darwin' | 'win32';
}

export function DesktopWindowControlButtons({
  translate,
  onAction,
  platform = 'darwin',
}: DesktopWindowControlButtonsProps) {
  const controls = platform === 'win32'
    ? [
      { action: 'minimize' as const, className: 'minimize', label: '最小化窗口', glyph: '−' },
      { action: 'toggle-maximize' as const, className: 'maximize', label: '缩放窗口', glyph: '□' },
      { action: 'close' as const, className: 'close', label: '关闭窗口', glyph: '×' },
    ]
    : [
      { action: 'close' as const, className: 'close', label: '关闭窗口', glyph: '×' },
      { action: 'minimize' as const, className: 'minimize', label: '最小化窗口', glyph: '−' },
      { action: 'toggle-maximize' as const, className: 'maximize', label: '缩放窗口', glyph: '+' },
    ];
  return (
    <div className={`cc-window-controls cc-window-controls--${platform === 'win32' ? 'win' : 'mac'}`} aria-label={translate('窗口控制')}>
      {controls.map((control) => (
        <button
          key={control.action}
          type="button"
          className={`cc-window-control cc-window-control--${control.className} cc-tip`}
          aria-label={translate(control.label)}
          data-tip={translate(control.label)}
          onClick={() => onAction(control.action)}
        >
          <span className="cc-window-control-glyph" aria-hidden="true">{control.glyph}</span>
        </button>
      ))}
    </div>
  );
}

export function DesktopWindowControls() {
  const t = useT();
  const desktop = window.openChatCutDesktop;
  if (desktop?.platform !== 'darwin' && desktop?.platform !== 'win32') return null;

  return (
    <DesktopWindowControlButtons
      translate={t}
      platform={desktop.platform}
      onAction={(action) => { void desktop.windowAction(action); }}
    />
  );
}
