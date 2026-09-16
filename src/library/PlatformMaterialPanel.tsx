import { useEffect, useMemo, useState } from 'react';
import type { MediaAsset } from '../editor/types';
import { importPlatformMaterial, listPlatformMaterials, type PlatformMaterial } from '../platform/platformIntegration';
import { Icon } from '../components/icons';
import { useT } from '../i18n/locale';

interface PlatformMaterialPanelProps {
  fps: number;
  onImport: (asset: MediaAsset) => void;
}

export function PlatformMaterialPanel({ fps, onImport }: PlatformMaterialPanelProps) {
  const t = useT();
  const [materials, setMaterials] = useState<PlatformMaterial[]>([]);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<ReadonlySet<string>>(new Set());

  const load = async () => {
    setLoading(true);
    setError(null);
    try { setMaterials(await listPlatformMaterials()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const visible = useMemo(() => {
    const needle = keyword.trim().toLocaleLowerCase();
    return needle ? materials.filter((item) => item.name.toLocaleLowerCase().includes(needle)) : materials;
  }, [keyword, materials]);

  const importOne = async (material: PlatformMaterial) => {
    if (importing.has(material.id)) return;
    setImporting((current) => new Set(current).add(material.id));
    setError(null);
    try { onImport(await importPlatformMaterial(material, fps)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally {
      setImporting((current) => {
        const next = new Set(current);
        next.delete(material.id);
        return next;
      });
    }
  };

  return (
    <div className="cc-platform-materials">
      <div className="cc-platform-materials-toolbar">
        <label className="cc-platform-materials-search">
          <Icon name="search" size={14} />
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={t('搜索业务素材')} />
        </label>
        <button type="button" className="cc-icon-button" title={t('刷新业务素材')} onClick={() => { void load(); }}>
          <Icon name="refresh" size={15} />
        </button>
      </div>
      {error && <div className="cc-platform-materials-error">{error}</div>}
      <div className="cc-platform-materials-list">
        {loading ? <div className="cc-platform-materials-empty">{t('正在加载…')}</div> : null}
        {!loading && visible.length === 0 ? <div className="cc-platform-materials-empty">{t('暂无可用视频或图片')}</div> : null}
        {visible.map((material) => (
          <button key={material.id} type="button" className="cc-platform-material-row" onClick={() => { void importOne(material); }}>
            <span className="cc-platform-material-thumb">
              {material.cover_url ? <img src={material.cover_url} alt="" /> : <Icon name={material.type === 'VIDEO' ? 'video' : 'image'} size={20} />}
            </span>
            <span className="cc-platform-material-copy">
              <strong title={material.name}>{material.name}</strong>
              <small>{material.type === 'VIDEO' ? t('视频') : t('图片')}</small>
            </span>
            <span className="cc-platform-material-action">{importing.has(material.id) ? t('导入中…') : t('导入')}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
