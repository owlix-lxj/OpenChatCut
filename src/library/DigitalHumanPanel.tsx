import { useMemo, useRef, useState } from 'react';
import type { MediaAsset } from '../editor/types';
import { useT } from '../i18n/locale';
import { Icon } from '../components/icons';

type CourseAction = 'script' | 'video';

interface Props {
  assets: MediaAsset[];
  onImportMedia: (file: File) => Promise<MediaAsset>;
  onGenerateCourse: (assets: MediaAsset[], action: CourseAction) => Promise<void> | void;
}

const isCourseware = (asset: MediaAsset): boolean => asset.kind === 'document'
  && /\.(?:pptx|pdf|docx|txt|md)$/i.test(asset.sourceFilename ?? asset.name);

export function DigitalHumanPanel({ assets, onImportMedia, onGenerateCourse }: Props) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<CourseAction | null>(null);
  const [error, setError] = useState('');
  const courseware = useMemo(() => assets.filter(isCourseware), [assets]);
  const selected = courseware.filter((asset) => selectedIds.includes(asset.id));

  const toggle = (id: string) => setSelectedIds((current) => current.includes(id)
    ? current.filter((value) => value !== id)
    : [...current, id]);

  const importFiles = async (files: File[]) => {
    setError('');
    for (const file of files) {
      if (!/\.(?:pptx|pdf|docx|txt|md)$/i.test(file.name)) {
        setError(t('智能制课仅支持 PPTX、PDF、DOCX、TXT 或 Markdown 课件。'));
        continue;
      }
      try {
        const asset = await onImportMedia(file);
        setSelectedIds((current) => current.includes(asset.id) ? current : [...current, asset.id]);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  };

  const run = async (action: CourseAction) => {
    if (!selected.length || busy) return;
    setError('');
    setBusy(action);
    try {
      await onGenerateCourse(selected, action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return <div className="cc-digital-human-panel">
    <div className="cc-digital-human-heading">
      <Icon name="bookOpen" size={18} />
      <div><strong>{t('智能制课')}</strong><small>{t('上传课件，AI 自动生成讲稿与课程视频')}</small></div>
    </div>

    <button type="button" className="cc-courseware-drop" onClick={() => inputRef.current?.click()}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); void importFiles(Array.from(event.dataTransfer.files)); }}>
      <Icon name="upload" size={22} />
      <strong>{t('上传 PPT / PDF 课件')}</strong>
      <small>{t('也支持 DOCX、TXT、Markdown，可一次选择多个文件')}</small>
      <input ref={inputRef} type="file" hidden multiple accept=".pptx,.pdf,.docx,.txt,.md,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation" onChange={(event) => {
        if (event.target.files) void importFiles(Array.from(event.target.files));
        event.target.value = '';
      }} />
    </button>

    {courseware.length > 0 && <div className="cc-courseware-list" role="listbox" aria-label={t('课件资源')}>
      <div className="cc-courseware-list-heading"><span>{t('课件资源')}</span><small>{t('{count} 个文件', { count: String(courseware.length) })}</small></div>
      {courseware.map((asset) => <button key={asset.id} type="button" role="option" aria-selected={selectedIds.includes(asset.id)}
        className={`cc-courseware-item${selectedIds.includes(asset.id) ? ' selected' : ''}`} onClick={() => toggle(asset.id)}>
        <Icon name={asset.name.toLowerCase().endsWith('.pptx') ? 'filePlay' : 'text'} size={16} />
        <span>{asset.name}</span>
        {selectedIds.includes(asset.id) && <Icon name="check" size={14} />}
      </button>)}
    </div>}

    <div className="cc-courseware-actions">
      <button type="button" className="cc-courseware-secondary" disabled={!selected.length || !!busy} onClick={() => { void run('script'); }}>
        <Icon name="text" size={15} />{busy === 'script' ? t('正在生成讲稿…') : t('AI 生成讲稿')}
      </button>
      <button type="button" className="cc-digital-human-submit" disabled={!selected.length || !!busy} onClick={() => { void run('video'); }}>
        <Icon name={busy === 'video' ? 'clock' : 'sparkles'} size={15} />{busy === 'video' ? t('正在准备课程视频…') : t('生成课程视频')}
      </button>
    </div>
    <div className="cc-courseware-note">{t('AI 会读取课件内容，在右侧对话中生成逐页口播稿；确认后可继续生成课程视频。无需手动选择人物、音色或配音服务。')}</div>
    {error && <div className="cc-digital-human-error" role="alert">{t(error)}</div>}
  </div>;
}
