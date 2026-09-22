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

export interface PlatformDigitalHuman {
  id: string;
  name: string;
  type: 'photo' | 'digital_twin' | 'prompt';
  provider: 'heygen';
  provider_group_id: string;
  provider_look_id: string;
  provider_voice_id?: string;
  preview_image_url?: string;
  preview_video_url?: string;
  status: string;
  consent_status?: string;
  supported_api_engines?: string[];
  failure_code?: string;
  failure_message?: string;
  created_at: string;
  updated_at: string;
}

export interface PlatformDigitalHumanLook {
  id: string;
  name: string;
  avatar_type: string;
  group_id: string;
  preview_image_url?: string;
  preview_video_url?: string;
  default_voice_id?: string;
  tags?: string[];
  supported_api_engines?: string[];
  status: string;
}

export interface PlatformDigitalHumanVoice {
	id?: string;
	voice_id: string;
	name: string;
	language: string;
	gender: string;
	preview_audio_url?: string;
	support_pause?: boolean;
	support_locale?: boolean;
	type: 'public' | 'private';
	status?: string;
	failure_message?: string;
}

export interface PlatformDigitalHumanVideoSegment {
  index: number;
  title: string;
  provider_video_id?: string;
  status: string;
  video_url?: string;
  subtitle_url?: string;
  thumbnail_url?: string;
  duration_seconds?: number;
  failure_code?: string;
  failure_message?: string;
}

export interface PlatformDigitalHumanVideo {
  id: string;
  digital_human_id: string;
	voice_id?: string;
  title: string;
  status: string;
  resolution: string;
  aspect_ratio: string;
  estimated_seconds: number;
  price_per_minute_cents: number;
  estimated_amount_cents: number;
	settled_seconds?: number;
	settled_amount_cents?: number;
  billing_status: string;
  segments: PlatformDigitalHumanVideoSegment[];
  created_at: string;
  updated_at: string;
}

export interface PlatformDigitalHumanVideoUsageItem {
	job_id: string;
	title: string;
	status: string;
	billing_status: string;
	estimated_seconds: number;
	estimated_amount_cents: number;
	settled_seconds?: number;
	settled_amount_cents?: number;
	created_at: string;
}

export interface PlatformDigitalHumanVideoUsage {
	committed_seconds: number;
	committed_amount_cents: number;
	reserved_seconds: number;
	reserved_amount_cents: number;
	completed_jobs: number;
	failed_jobs: number;
	items: PlatformDigitalHumanVideoUsageItem[];
}

export interface PlatformDigitalHumanMediaJob {
	id: string;
	kind: 'translation' | 'lipsync';
	title: string;
	status: string;
	output_language?: string;
	video_url?: string;
	srt_caption_url?: string;
	vtt_caption_url?: string;
	duration_seconds?: number;
	failure_message?: string;
	estimated_seconds: number;
	estimated_amount_cents: number;
	billing_status: string;
	created_at: string;
	updated_at: string;
}

export function platformDigitalHumanErrorMessage(message: string): string {
  const normalized = message.trim().toLowerCase();
  if (normalized === 'digital human pricing is not configured') {
    return '业务平台尚未配置数字人视频计费单价，请联系平台管理员完成定价配置后重试。';
  }
  if (normalized === 'digital human request failed') {
    return '数字人业务平台请求失败，请重试；如果持续失败，请检查业务平台服务状态。';
  }
  if (normalized === 'fetch failed') {
    return '无法连接数字人业务平台，请检查网络或稍后重试。';
  }
  if (normalized.includes('timed out') || normalized.includes('timeout')) {
    return '数字人业务平台响应超时，请稍后重试。';
  }
  return message;
}

export function platformDigitalHumanResponseError(body: {
  error?: string | { message?: string };
  detail?: string;
  message?: string;
}, status: number): string {
  const nested = typeof body.error === 'object' ? body.error?.message : body.error;
  // Local proxy failures use a generic `error` plus the actionable cause in `detail`.
  // Prefer that cause so “digital human request failed” never hides the real problem.
  const message = body.detail?.trim() || nested?.trim() || body.message?.trim()
    || `数字人请求失败（HTTP ${status}）`;
  return platformDigitalHumanErrorMessage(message);
}

async function digitalHumanRequest<T>(path = '', init?: RequestInit, base = '/api/platform/digital-humans'): Promise<T> {
  const response = await fetch(`${base}${path}`, init);
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({})) as T & {
    error?: string | { message?: string };
    detail?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new Error(platformDigitalHumanResponseError(body, response.status));
  }
  return body;
}

export async function listPlatformDigitalHumans(): Promise<PlatformDigitalHuman[]> {
  const body = await digitalHumanRequest<{ items?: PlatformDigitalHuman[] }>();
  return body.items ?? [];
}

export async function createPlatformDigitalHuman(input: {
  name: string;
  type: 'photo' | 'digital_twin' | 'prompt';
  source?: string;
  sourceContentType?: string;
  prompt?: string;
  aspectRatio?: string;
  likenessConsent: boolean;
}): Promise<PlatformDigitalHuman> {
  return digitalHumanRequest<PlatformDigitalHuman>('', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      type: input.type,
      source: input.source,
      source_content_type: input.sourceContentType,
      prompt: input.prompt,
      aspect_ratio: input.aspectRatio,
      likeness_consent: input.likenessConsent,
    }),
  });
}

export async function refreshPlatformDigitalHuman(id: string): Promise<PlatformDigitalHuman> {
  return digitalHumanRequest<PlatformDigitalHuman>(`/${encodeURIComponent(id)}/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
}

export async function createPlatformDigitalHumanConsent(id: string): Promise<{
  url?: string;
  consent_status?: string;
}> {
  return digitalHumanRequest(`/${encodeURIComponent(id)}/consent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
}

export async function listPlatformDigitalHumanLooks(id: string): Promise<PlatformDigitalHumanLook[]> {
  const body = await digitalHumanRequest<{ items?: PlatformDigitalHumanLook[] }>(`/${encodeURIComponent(id)}/looks`);
  return body.items ?? [];
}

export async function createPlatformDigitalHumanLook(id: string, input: { name: string; prompt: string; baseLookId?: string; aspectRatio?: string }): Promise<PlatformDigitalHumanLook> {
  return digitalHumanRequest<PlatformDigitalHumanLook>(`/${encodeURIComponent(id)}/looks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: input.name, prompt: input.prompt, base_look_id: input.baseLookId, aspect_ratio: input.aspectRatio }),
  });
}

export async function deletePlatformDigitalHuman(id: string): Promise<void> {
  await digitalHumanRequest<void>(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function listPlatformDigitalHumanVoices(language = 'Chinese', type: 'public' | 'private' = 'public'): Promise<PlatformDigitalHumanVoice[]> {
	const query = new URLSearchParams({ language, type });
	const body = await digitalHumanRequest<{ items?: PlatformDigitalHumanVoice[] }>(
		`?${query}`, undefined, '/api/platform/digital-human-voices',
	);
	return body.items ?? [];
}

export async function clonePlatformDigitalHumanVoice(input: {
	name: string;
	source: string;
	sourceContentType: string;
	language?: string;
	removeBackgroundNoise: boolean;
	voiceConsent: boolean;
	idempotencyKey: string;
}): Promise<PlatformDigitalHumanVoice> {
	return digitalHumanRequest<PlatformDigitalHumanVoice>('', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: input.name, source: input.source, source_content_type: input.sourceContentType,
			language: input.language, remove_background_noise: input.removeBackgroundNoise,
			voice_consent: input.voiceConsent, idempotency_key: input.idempotencyKey,
		}),
	}, '/api/platform/digital-human-voices');
}

export async function quotePlatformDigitalHumanVoiceClone(): Promise<{ price_cents: number }> {
	return digitalHumanRequest('/clone-quote', {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
	}, '/api/platform/digital-human-voices');
}

export async function refreshPlatformDigitalHumanVoice(id: string): Promise<PlatformDigitalHumanVoice> {
	return digitalHumanRequest<PlatformDigitalHumanVoice>(`/${encodeURIComponent(id)}/refresh`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
	}, '/api/platform/digital-human-voices');
}

export async function deletePlatformDigitalHumanVoice(id: string): Promise<void> {
	await digitalHumanRequest<void>(`/${encodeURIComponent(id)}`, { method: 'DELETE' }, '/api/platform/digital-human-voices');
}

export interface PlatformDigitalHumanSpeechResult {
	audio_url: string;
	duration: number;
	request_id: string;
	settled_seconds: number;
	price_per_minute_cents: number;
	settled_amount_cents: number;
	billing_status: string;
}

export async function quotePlatformDigitalHumanSpeech(input: { voiceId: string; voiceType: 'public' | 'private'; text: string; speed: number; locale?: string }): Promise<{
	estimated_seconds: number; price_per_minute_cents: number; estimated_amount_cents: number;
}> {
	return digitalHumanRequest('/speech', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ voice_id: input.voiceId, voice_type: input.voiceType, text: input.text, speed: input.speed, locale: input.locale, quote_only: true }),
	}, '/api/platform/digital-human-voices');
}

export async function createPlatformDigitalHumanSpeech(input: { voiceId: string; voiceType: 'public' | 'private'; text: string; speed: number; locale?: string; idempotencyKey: string }): Promise<PlatformDigitalHumanSpeechResult> {
	return digitalHumanRequest<PlatformDigitalHumanSpeechResult>('/speech', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ voice_id: input.voiceId, voice_type: input.voiceType, text: input.text, speed: input.speed, locale: input.locale, idempotency_key: input.idempotencyKey }),
	}, '/api/platform/digital-human-voices');
}

export async function importPlatformDigitalHumanSpeech(result: PlatformDigitalHumanSpeechResult, name: string, fps: number): Promise<MediaAsset> {
	if (!result.audio_url) throw new Error('语音地址尚未就绪');
	const response = await fetch('/api/import-url', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ url: result.audio_url, name: `${name || '数字人配音'}.mp3` }),
	});
	const imported = await response.json().catch(() => ({})) as ImportUrlResponse;
	if (!response.ok || !imported.ok || !imported.path) throw new Error(imported.error ?? `配音导入失败（HTTP ${response.status}）`);
	return {
		id: crypto.randomUUID(), name: `${name || '数字人配音'}.mp3`, kind: 'audio', src: imported.path,
		durationInFrames: Math.max(1, Math.round((imported.probe?.durationSeconds ?? result.duration ?? 1) * fps)),
		sourceFilename: imported.filename, sourceContentHash: imported.contentHash, sourceSize: imported.bytes,
	};
}

export async function createPlatformDigitalHumanVideo(input: {
  digitalHumanId: string;
	lookId?: string;
	voiceId: string;
  engine?: string;
  voiceSettings?: { speed: number; pitch: number; locale?: string };
  title: string;
  segments: Array<{ title: string; script: string; expectedSeconds?: number }>;
  idempotencyKey: string;
}): Promise<PlatformDigitalHumanVideo> {
  return digitalHumanRequest<PlatformDigitalHumanVideo>('', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      digital_human_id: input.digitalHumanId, title: input.title,
	  look_id: input.lookId,
	  voice_id: input.voiceId,
      engine: input.engine,
      voice_settings: input.voiceSettings,
      resolution: '1080p', aspect_ratio: '16:9', idempotency_key: input.idempotencyKey,
      segments: input.segments.map((segment) => ({
        title: segment.title, script: segment.script, expected_seconds: segment.expectedSeconds,
      })),
    }),
  }, '/api/platform/digital-human-videos');
}

export async function quotePlatformDigitalHumanVideo(segments: Array<{ script: string; expectedSeconds?: number }>, engine?: string): Promise<{
  estimated_seconds: number;
  price_per_minute_cents: number;
  estimated_amount_cents: number;
}> {
  return digitalHumanRequest('', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine, segments: segments.map((segment) => ({ script: segment.script, expected_seconds: segment.expectedSeconds })) }),
  }, '/api/platform/digital-human-videos/quote');
}

export async function refreshPlatformDigitalHumanVideo(id: string): Promise<PlatformDigitalHumanVideo> {
  return digitalHumanRequest<PlatformDigitalHumanVideo>(`/${encodeURIComponent(id)}/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }, '/api/platform/digital-human-videos');
}

export async function retryPlatformDigitalHumanVideo(id: string): Promise<PlatformDigitalHumanVideo> {
  return digitalHumanRequest<PlatformDigitalHumanVideo>(`/${encodeURIComponent(id)}/retry`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }, '/api/platform/digital-human-videos');
}

export async function listPlatformDigitalHumanVideos(): Promise<PlatformDigitalHumanVideo[]> {
  const body = await digitalHumanRequest<{ items?: PlatformDigitalHumanVideo[] }>('', undefined, '/api/platform/digital-human-videos');
  return body.items ?? [];
}

export async function getPlatformDigitalHumanVideoUsage(): Promise<PlatformDigitalHumanVideoUsage> {
	return digitalHumanRequest<PlatformDigitalHumanVideoUsage>(
		'/usage', undefined, '/api/platform/digital-human-videos',
	);
}

export async function importPlatformDigitalHumanVideoSegment(
  segment: PlatformDigitalHumanVideoSegment,
  fps: number,
): Promise<MediaAsset> {
  if (!segment.video_url) throw new Error('数字人成片地址尚未就绪');
  const response = await fetch('/api/import-url', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: segment.video_url, name: `${segment.title || `课程片段 ${segment.index + 1}`}.mp4` }),
  });
  const imported = await response.json().catch(() => ({})) as ImportUrlResponse;
  if (!response.ok || !imported.ok || !imported.path) throw new Error(imported.error ?? `成片导入失败（HTTP ${response.status}）`);
  const seconds = imported.probe?.durationSeconds ?? segment.duration_seconds ?? 5;
  return {
    id: crypto.randomUUID(), name: `${segment.title || `课程片段 ${segment.index + 1}`}.mp4`, kind: 'video',
    src: imported.path, durationInFrames: Math.max(1, Math.round(seconds * fps)),
    sourceFilename: imported.filename, sourceContentHash: imported.contentHash, sourceSize: imported.bytes,
    width: imported.probe?.width, height: imported.probe?.height,
  };
}

export async function createPlatformDigitalHumanMediaJob(input: {
	kind: 'translation' | 'lipsync'; title: string;
	videoSource: string; videoContentType: string;
	audioSource?: string; audioContentType?: string;
	outputLanguage?: string; expectedSeconds: number; idempotencyKey: string;
}): Promise<PlatformDigitalHumanMediaJob> {
	return digitalHumanRequest<PlatformDigitalHumanMediaJob>('', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			kind: input.kind, title: input.title,
			video_source: input.videoSource, video_content_type: input.videoContentType,
			audio_source: input.audioSource, audio_content_type: input.audioContentType,
			output_languages: input.outputLanguage ? [input.outputLanguage] : [],
			expected_seconds: input.expectedSeconds, idempotency_key: input.idempotencyKey,
		}),
	}, '/api/platform/digital-human-media-jobs');
}

export async function quotePlatformDigitalHumanMediaJob(input: { kind: 'translation' | 'lipsync'; expectedSeconds: number }): Promise<{
	estimated_seconds: number; price_per_minute_cents: number; estimated_amount_cents: number;
}> {
	return digitalHumanRequest('/quote', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ kind: input.kind, expected_seconds: input.expectedSeconds }),
	}, '/api/platform/digital-human-media-jobs');
}

export async function listPlatformDigitalHumanMediaJobs(): Promise<PlatformDigitalHumanMediaJob[]> {
	const body = await digitalHumanRequest<{ items?: PlatformDigitalHumanMediaJob[] }>('', undefined, '/api/platform/digital-human-media-jobs');
	return body.items ?? [];
}

export async function refreshPlatformDigitalHumanMediaJob(id: string): Promise<PlatformDigitalHumanMediaJob> {
	return digitalHumanRequest<PlatformDigitalHumanMediaJob>(`/${encodeURIComponent(id)}/refresh`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
	}, '/api/platform/digital-human-media-jobs');
}

export async function deletePlatformDigitalHumanMediaJob(id: string): Promise<void> {
	await digitalHumanRequest<void>(`/${encodeURIComponent(id)}`, { method: 'DELETE' }, '/api/platform/digital-human-media-jobs');
}

export async function importPlatformDigitalHumanMediaJob(job: PlatformDigitalHumanMediaJob, fps: number): Promise<MediaAsset> {
	if (!job.video_url) throw new Error('处理后的视频尚未就绪');
	const response = await fetch('/api/import-url', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ url: job.video_url, name: `${job.title || (job.kind === 'translation' ? '视频翻译' : '精准口型')}.mp4` }),
	});
	const imported = await response.json().catch(() => ({})) as ImportUrlResponse;
	if (!response.ok || !imported.ok || !imported.path) throw new Error(imported.error ?? `视频导入失败（HTTP ${response.status}）`);
	const seconds = imported.probe?.durationSeconds ?? job.duration_seconds ?? 5;
	return {
		id: crypto.randomUUID(), name: `${job.title || 'HeyGen 处理结果'}.mp4`, kind: 'video', src: imported.path,
		durationInFrames: Math.max(1, Math.round(seconds * fps)), sourceFilename: imported.filename,
		sourceContentHash: imported.contentHash, sourceSize: imported.bytes,
		width: imported.probe?.width, height: imported.probe?.height,
	};
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

export interface PlatformMaterialsPage {
  /** Materials on this page, filtered to the importable kinds (video/image). */
  items: PlatformMaterial[];
  /** Raw total across all material kinds — drives "has more" for infinite scroll. */
  total: number;
  page: number;
  pageSize: number;
}

export async function listPlatformMaterials(
  keyword = '',
  page = 1,
  pageSize = 5,
): Promise<PlatformMaterialsPage> {
  const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (keyword.trim()) query.set('keyword', keyword.trim());
  const response = await fetch(`/api/platform/materials?${query}`);
  const body = await response.json().catch(() => ({})) as { items?: PlatformMaterial[]; total?: number; error?: string };
  if (!response.ok) throw new Error(body.error ?? `业务素材加载失败（HTTP ${response.status}）`);
  const raw = body.items ?? [];
  return {
    items: raw.filter((item) => item.type === 'VIDEO' || item.type === 'IMAGE'),
    total: typeof body.total === 'number' ? body.total : raw.length,
    page,
    pageSize,
  };
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
