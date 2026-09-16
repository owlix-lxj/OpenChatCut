import type { MediaAsset, MediaAssetKind } from '../editor/types';
import type { ProbeResult } from '../../shared/media-probe';

export interface PlatformMaterial {
  id: string;
  type: 'VIDEO' | 'IMAGE' | 'DOCUMENT' | 'RICH_TEXT';
  name: string;
  source_url?: string;
  cover_url?: string;
  mime_type?: string;
  size_bytes?: number;
  created_at?: string;
}

interface ImportUrlResponse {
  ok?: boolean;
  path?: string;
  filename?: string;
  bytes?: number;
  contentHash?: string;
  probe?: ProbeResult;
  error?: string;
}

export function platformManagedClient(): boolean {
  return typeof __PLATFORM_MANAGED__ !== 'undefined' && __PLATFORM_MANAGED__ === true;
}

export async function listPlatformMaterials(keyword = ''): Promise<PlatformMaterial[]> {
  const query = new URLSearchParams({ page: '1', page_size: '100' });
  if (keyword.trim()) query.set('keyword', keyword.trim());
  const response = await fetch(`/api/platform/materials?${query}`);
  const body = await response.json().catch(() => ({})) as { items?: PlatformMaterial[]; error?: string };
  if (!response.ok) throw new Error(body.error ?? `业务素材加载失败（HTTP ${response.status}）`);
  return (body.items ?? []).filter((item) => item.type === 'VIDEO' || item.type === 'IMAGE');
}

function kindFor(material: PlatformMaterial): MediaAssetKind {
  return material.type === 'IMAGE' ? 'image' : 'video';
}

export async function importPlatformMaterial(material: PlatformMaterial, fps: number): Promise<MediaAsset> {
  if (!material.source_url) throw new Error('该素材没有可用的源文件');
  const response = await fetch('/api/import-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: material.source_url, name: material.name }),
  });
  const imported = await response.json().catch(() => ({})) as ImportUrlResponse;
  if (!response.ok || !imported.ok || !imported.path) {
    throw new Error(imported.error ?? `素材导入失败（HTTP ${response.status}）`);
  }
  const probe = imported.probe;
  const durationSeconds = material.type === 'IMAGE' ? 5 : (probe?.durationSeconds ?? 5);
  return {
    id: crypto.randomUUID(),
    name: material.name,
    sourceFilename: imported.filename ?? material.name,
    kind: kindFor(material),
    src: imported.path,
    durationInFrames: Math.max(1, Math.round(durationSeconds * fps)),
    sourceContentHash: imported.contentHash,
    sourceSize: imported.bytes ?? material.size_bytes,
    width: probe?.width,
    height: probe?.height,
  };
}

export async function syncPlatformExport(path: string, name: string): Promise<void> {
  if (!platformManagedClient()) return;
  const response = await fetch('/api/platform/materials/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, name }),
  });
  if (response.ok) return;
  const body = await response.json().catch(() => ({})) as { error?: string };
  throw new Error(body.error ?? `导出结果回写素材库失败（HTTP ${response.status}）`);
}
