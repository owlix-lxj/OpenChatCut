import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaAsset } from '../editor/types';
import { importPlatformMaterial, listPlatformMaterials, type PlatformMaterial } from '../platform/platformIntegration';
import { Icon } from '../components/icons';
import { useT } from '../i18n/locale';

interface PlatformMaterialPanelProps {
  fps: number;
  onImport: (asset: MediaAsset) => void;
}

/**
 * Business materials often store an image without a separate cover_url, so the
 * preview falls back to the image itself (source_url). If that URL cannot be
 * displayed (e.g. a private OSS object without a browser-readable URL), degrade
 * gracefully to the type icon instead of showing a broken image.
 */
function MaterialThumb({ material }: { material: PlatformMaterial }) {
  const [failed, setFailed] = useState(false);
  const preview = material.cover_url || (material.type === 'IMAGE' ? material.source_url : undefined);
  if (preview && !failed) {
    return <img src={preview} alt="" loading="lazy" onError={() => setFailed(true)} />;
  }
  return <Icon name={material.type === 'VIDEO' ? 'video' : 'image'} size={20} />;
}

const PAGE_SIZE = 5;

export function PlatformMaterialPanel({ fps, onImport }: PlatformMaterialPanelProps) {
  const t = useT();
  const [materials, setMaterials] = useState<PlatformMaterial[]>([]);
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<ReadonlySet<string>>(new Set());
  // Guards against a slower earlier request (e.g. from a previous keyword)
  // overwriting the results of the current one.
  const seqRef = useRef(0);

  // `total` counts every material kind, so paging by it stays correct even
  // though the list is filtered to video/image after each page arrives.
  const hasMore = page * PAGE_SIZE < total;

  const loadPage = useCallback(async (nextPage: number, kw: string, append: boolean) => {
    const seq = ++seqRef.current;
    if (append) setLoadingMore(true); else setLoading(true);
    setError(null);
    try {
      const result = await listPlatformMaterials(kw, nextPage, PAGE_SIZE);
      if (seq !== seqRef.current) return;
      setTotal(result.total);
      setPage(nextPage);
      setMaterials((prev) => {
        if (!append) return result.items;
        const seen = new Set(prev.map((item) => item.id));
        return [...prev, ...result.items.filter((item) => !seen.has(item.id))];
      });
    } catch (cause) {
      if (seq === seqRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (seq === seqRef.current) { setLoading(false); setLoadingMore(false); }
    }
  }, []);

  // First page on mount, and reload from page 1 when the (debounced) keyword changes.
  useEffect(() => {
    const handle = setTimeout(() => { void loadPage(1, keyword, false); }, keyword ? 300 : 0);
    return () => clearTimeout(handle);
  }, [keyword, loadPage]);

  const onScrollList = (el: HTMLDivElement) => {
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 96 && hasMore && !loadingMore && !loading) {
      void loadPage(page + 1, keyword, true);
    }
  };

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
        <button type="button" className="cc-icon-button" title={t('刷新业务素材')} onClick={() => { void loadPage(1, keyword, false); }}>
          <Icon name="refresh" size={15} />
        </button>
      </div>
      {error && <div className="cc-platform-materials-error">{error}</div>}
      <div className="cc-platform-materials-list" onScroll={(event) => onScrollList(event.currentTarget)}>
        {loading && materials.length === 0 ? <div className="cc-platform-materials-empty">{t('正在加载…')}</div> : null}
        {!loading && materials.length === 0 ? <div className="cc-platform-materials-empty">{t('暂无可用视频或图片')}</div> : null}
        {materials.map((material) => (
          <button key={material.id} type="button" className="cc-platform-material-row" onClick={() => { void importOne(material); }}>
            <span className="cc-platform-material-thumb">
              <MaterialThumb material={material} />
            </span>
            <span className="cc-platform-material-copy">
              <strong title={material.name}>{material.name}</strong>
              <small>{material.type === 'VIDEO' ? t('视频') : t('图片')}</small>
            </span>
            <span className="cc-platform-material-action">{importing.has(material.id) ? t('导入中…') : t('导入')}</span>
          </button>
        ))}
        {loadingMore ? <div className="cc-platform-materials-empty">{t('加载更多…')}</div> : null}
        {!loading && !loadingMore && hasMore ? (
          <button
            type="button"
            className="cc-platform-materials-more"
            onClick={() => { void loadPage(page + 1, keyword, true); }}
          >
            {t('加载更多')}
          </button>
        ) : null}
        {!loading && !loadingMore && !hasMore && materials.length > 0
          ? <div className="cc-platform-materials-empty">{t('没有更多了')}</div>
          : null}
      </div>
    </div>
  );
}
