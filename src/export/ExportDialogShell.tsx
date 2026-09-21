import type { ReactNode } from 'react';
import { Icon } from '../components/icons';
import type { TimelineState } from '../editor/types';
import { useT } from '../i18n/locale';
import { EXPORT_TABS } from './useExportDialogModel';
import type { ExportTab } from './useExportWorkflow';

interface ExportDialogShellProps {
  base: string;
  state: TimelineState;
  onClose: () => void;
  children: ReactNode;
}

function ExportDialogHeader({ base, state, onClose }: Omit<ExportDialogShellProps, 'children'>) {
  const t = useT();
  return (
    <header className="cc-export-header">
      <div>
        <h2 id="cc-export-title">{t('导出')}</h2>
        <p>{base} · {state.width}×{state.height} · {state.fps} fps</p>
      </div>
      <button type="button" className="cc-export-close" onClick={onClose} title={t('关闭')}>
        <Icon name="x" size={16} />
      </button>
    </header>
  );
}

export function ExportDialogShell({ base, state, onClose, children }: ExportDialogShellProps) {
  return (
    <div className="cc-export-overlay" onClick={onClose}>
      <div
        className="cc-export-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cc-export-title"
        onClick={(event) => event.stopPropagation()}
      >
        <ExportDialogHeader base={base} state={state} onClose={onClose} />
        <div className="cc-export-layout">{children}</div>
      </div>
    </div>
  );
}

interface ExportSidebarProps {
  publishing?: boolean;
  onPublish?: () => void;
  tab: ExportTab;
  busy: boolean;
  onTabChange: (tab: ExportTab) => void;
}

export function ExportSidebar({ tab, busy, onTabChange, publishing, onPublish }: ExportSidebarProps) {
  const t = useT();
  return (
    <aside className="cc-export-sidebar">
      <span className="cc-export-sidebar-label">{t('输出类型')}</span>
      <div className="cc-export-tabs" role="tablist" aria-label={t('输出类型')}>
        {EXPORT_TABS.map((entry) => (
          <button
            type="button"
            role="tab"
            aria-selected={!publishing && tab === entry.key}
            aria-controls={`cc-export-content-${entry.key}`}
            id={`cc-export-tab-${entry.key}`}
            key={entry.key}
            className={`cc-export-tab${!publishing && tab === entry.key ? ' active' : ''}`}
            onClick={() => onTabChange(entry.key)}
            disabled={busy}
          >
            <span className="cc-export-tab-icon"><Icon name={entry.icon} size={15} /></span>
            <span><strong>{t(entry.label)}</strong><small>{entry.summary}</small></span>
          </button>
        ))}
        {onPublish && <button type="button" role="tab" id="cc-export-tab-publish" aria-controls="cc-export-content-publish"
          aria-selected={!!publishing} className={`cc-export-tab${publishing ? ' active' : ''}`}
          onClick={onPublish}>
          <span className="cc-export-tab-icon"><Icon name="upload" size={15} /></span>
          <span><strong>平台草稿</strong><small>账号 · 视频上传</small></span>
        </button>}
      </div>
    </aside>
  );
}
