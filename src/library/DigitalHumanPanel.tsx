import { useEffect, useMemo, useRef, useState } from 'react';
import type { MediaAsset } from '../editor/types';
import { useT } from '../i18n/locale';
import { Icon } from '../components/icons';
import {
  clonePlatformDigitalHumanVoice, createPlatformDigitalHuman, createPlatformDigitalHumanConsent, createPlatformDigitalHumanLook, createPlatformDigitalHumanSpeech,
  createPlatformDigitalHumanVideo,
	createPlatformDigitalHumanMediaJob,
  deletePlatformDigitalHuman, deletePlatformDigitalHumanVoice,
  importPlatformDigitalHumanSpeech, importPlatformDigitalHumanVideoSegment, listPlatformDigitalHumans, listPlatformDigitalHumanVoices,
	importPlatformDigitalHumanMediaJob, listPlatformDigitalHumanMediaJobs, quotePlatformDigitalHumanMediaJob, refreshPlatformDigitalHumanMediaJob,
  listPlatformDigitalHumanLooks, listPlatformDigitalHumanVideos,
  platformManagedClient, quotePlatformDigitalHumanSpeech, quotePlatformDigitalHumanVideo, refreshPlatformDigitalHuman,
  quotePlatformDigitalHumanVoiceClone,
  refreshPlatformDigitalHumanVideo, refreshPlatformDigitalHumanVoice,
  retryPlatformDigitalHumanVideo, type PlatformDigitalHuman,
  type PlatformDigitalHumanLook, type PlatformDigitalHumanVideo, type PlatformDigitalHumanVoice,
	type PlatformDigitalHumanMediaJob,
} from '../platform/platformIntegration';
import {
  COURSE_DURATION_PRESETS,
  distributeCourseSeconds,
  estimateCourseScriptSeconds,
  normalizeCourseDurationMinutes,
  type CourseGenerationOptions,
} from './digitalHumanCourseDuration';

type CourseAction = 'script' | 'video';
type VoiceGenderFilter = 'all' | 'female' | 'male';
type AvatarCreationType = 'photo' | 'digital_twin' | 'prompt';
type DigitalHumanModule = 'avatars' | 'voices' | 'course' | 'media' | 'tasks';
interface VisualPreviewTarget {
  kind: 'avatar' | 'look';
  id: string;
  name: string;
  subtitle: string;
  imageUrl?: string;
  videoUrl?: string;
  ready: boolean;
}
interface Props {
  assets: MediaAsset[];
  fps: number;
  onImportMedia: (file: File) => Promise<MediaAsset>;
  onAddGeneratedMedia: (asset: MediaAsset) => void;
  onAddGeneratedMediaToTimeline: (assets: MediaAsset[]) => void;
  onGenerateCourse: (assets: MediaAsset[], action: CourseAction, digitalHuman?: PlatformDigitalHuman, options?: CourseGenerationOptions) => Promise<void> | void;
}

const isCourseware = (asset: MediaAsset): boolean => asset.kind === 'document'
  && /\.(?:pptx|pdf|docx|txt|md)$/i.test(asset.sourceFilename ?? asset.name);
const isAvatarImage = (asset: MediaAsset): boolean => asset.kind === 'image'
  && /^\/media\/uploads\//.test(asset.src)
  && /\.(?:jpe?g|png)$/i.test(asset.sourceFilename ?? asset.name ?? asset.src);
const isAvatarVideo = (asset: MediaAsset): boolean => asset.kind === 'video'
  && /^\/media\/uploads\//.test(asset.src)
  && /\.(?:mp4|webm)$/i.test(asset.sourceFilename ?? asset.name ?? asset.src);
const isVoiceAudio = (asset: MediaAsset): boolean => asset.kind === 'audio'
  && /^\/media\/uploads\//.test(asset.src)
  && /\.(?:mp3|wav|m4a|webm)$/i.test(asset.sourceFilename ?? asset.name ?? asset.src);
const contentTypeForAvatarSource = (asset: MediaAsset): string => {
  const sourceName = asset.sourceFilename ?? asset.name ?? asset.src;
  if (/\.png$/i.test(sourceName)) return 'image/png';
  if (/\.webm$/i.test(sourceName)) return 'video/webm';
  if (/\.mp4$/i.test(sourceName)) return 'video/mp4';
  return 'image/jpeg';
};
const contentTypeForVoiceSource = (asset: MediaAsset): string => {
  const sourceName = asset.sourceFilename ?? asset.name ?? asset.src;
  if (/\.wav$/i.test(sourceName)) return 'audio/wav';
  if (/\.m4a$/i.test(sourceName)) return 'audio/mp4';
  if (/\.webm$/i.test(sourceName)) return 'audio/webm';
  return 'audio/mpeg';
};
const isVoiceReady = (voice: PlatformDigitalHumanVoice): boolean => voice.type === 'public'
  || ['complete', 'completed', 'ready', 'done'].includes((voice.status ?? '').toLowerCase());
const isAvatarStatusReady = (status: string): boolean => ['completed', 'complete', 'ready', 'done'].includes(status.toLowerCase());
const isConsentReady = (status?: string): boolean => ['completed', 'complete', 'approved', 'accepted', 'verified', 'done'].includes((status ?? '').toLowerCase());
const isReady = (item: PlatformDigitalHuman): boolean => isAvatarStatusReady(item.status)
  && (item.type !== 'digital_twin' || isConsentReady(item.consent_status));
const needsAvatarRefresh = (item: PlatformDigitalHuman): boolean => {
  const status = item.status.toLowerCase();
  if (['failed', 'error', 'rejected', 'deleted'].includes(status)) return false;
  return !isAvatarStatusReady(status) || (item.type === 'digital_twin' && !isConsentReady(item.consent_status));
};
const pauseVoiceAudio = (audio: HTMLAudioElement): void => {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
};
const isPendingStatus = (status: string): boolean => ['processing', 'pending', 'queued', 'running', 'submitting'].includes(status.toLowerCase());
const statusLabel = (status: string): string => ({
  completed: '已完成', complete: '已完成', ready: '已就绪', failed: '失败', error: '失败',
  processing: '处理中', pending: '排队中', queued: '排队中', running: '处理中', submitting: '正在提交',
}[status.toLowerCase()] ?? status);

function splitConfirmedScript(value: string): string[] {
  const explicit = value.split(/\n\s*---+\s*\n/g).map((part) => part.trim()).filter(Boolean);
  const result: string[] = [];
  for (const section of explicit) {
    let current = '';
    for (const paragraph of section.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)) {
      if (current && [...current, ...paragraph].length > 6000) { result.push(current); current = ''; }
      current = current ? `${current}\n\n${paragraph}` : paragraph;
      while ([...current].length > 6000) {
        result.push([...current].slice(0, 6000).join(''));
        current = [...current].slice(6000).join('');
      }
    }
    if (current) result.push(current);
  }
  return result;
}

function WaveformBars({ active }: { active: boolean }) {
  return (
    <span className={`cc-waveform-bars${active ? ' playing' : ''}`} aria-hidden="true">
      <span className="cc-waveform-bar" />
      <span className="cc-waveform-bar" />
      <span className="cc-waveform-bar" />
      <span className="cc-waveform-bar" />
    </span>
  );
}

function VisualPreviewDialog({ target, selected, onClose, onSelect }: {
  target: VisualPreviewTarget;
  selected: boolean;
  onClose: () => void;
  onSelect: () => void;
}) {
  const t = useT();
  return <div className="cc-visual-preview-backdrop" role="dialog" aria-modal="true" aria-label={t('预览 {name}', { name: target.name })} onClick={onClose}>
    <section className="cc-visual-preview-dialog" onClick={(event) => event.stopPropagation()}>
      <header><div><span>{target.kind === 'avatar' ? t('数字人形象预览') : t('数字人造型预览')}</span><strong>{target.name}</strong></div><button type="button" aria-label={t('关闭')} onClick={onClose}><Icon name="x" size={16} /></button></header>
      <div className="cc-visual-preview-media">
        {target.videoUrl ? <video src={target.videoUrl} controls playsInline preload="metadata" poster={target.imageUrl} /> : target.imageUrl ? <img src={target.imageUrl} alt={target.name} /> : <div className="cc-visual-preview-placeholder"><Icon name={target.kind === 'avatar' ? 'users' : 'palette'} size={38} /><span>{t('暂无可用预览')}</span></div>}
      </div>
      <div className="cc-visual-preview-info"><div><strong>{target.name}</strong><small>{target.subtitle}</small></div><span className={target.ready ? 'ready' : 'pending'}>{target.ready ? t('可使用') : t('处理中')}</span></div>
      <footer><button type="button" onClick={onClose}>{t('关闭')}</button><button type="button" className="primary" disabled={!target.ready || selected} onClick={onSelect}><Icon name={selected ? 'check' : 'sparkles'} size={13} />{selected ? t('当前已选择') : target.kind === 'avatar' ? t('选择此形象') : t('选择此造型')}</button></footer>
    </section>
  </div>;
}

function getFormatBadge(filename: string): { label: string; color: string; bg: string } {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'pptx':
    case 'ppt':
      return { label: 'PPTX', color: '#ff6b4a', bg: 'rgba(255, 107, 74, 0.14)' };
    case 'pdf':
      return { label: 'PDF', color: '#ff4d4f', bg: 'rgba(255, 77, 79, 0.14)' };
    case 'docx':
    case 'doc':
      return { label: 'DOCX', color: '#2b7fff', bg: 'rgba(43, 127, 255, 0.14)' };
    case 'md':
      return { label: 'MD', color: '#a855f7', bg: 'rgba(168, 85, 247, 0.14)' };
    default:
      return { label: 'TXT', color: '#10b981', bg: 'rgba(16, 185, 129, 0.14)' };
  }
}

export function DigitalHumanPanel({ assets, fps, onImportMedia, onAddGeneratedMedia, onAddGeneratedMediaToTimeline, onGenerateCourse }: Props) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const voiceInputRef = useRef<HTMLInputElement>(null);
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);
  const importedVideoIds = useRef(new Set<string>());
	const importedMediaJobIds = useRef(new Set<string>());
  const [activeModule, setActiveModule] = useState<DigitalHumanModule>('course');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<CourseAction | 'avatar' | 'voice' | 'speech' | 'media' | 'refresh' | 'delete' | null>(null);
  const [consentBusyId, setConsentBusyId] = useState('');
  const [error, setError] = useState('');
  const [digitalHumans, setDigitalHumans] = useState<PlatformDigitalHuman[]>([]);
  const [selectedDigitalHumanId, setSelectedDigitalHumanId] = useState('');
	const [avatarLooks, setAvatarLooks] = useState<PlatformDigitalHumanLook[]>([]);
	const [selectedLookId, setSelectedLookId] = useState('');
	const [voices, setVoices] = useState<PlatformDigitalHumanVoice[]>([]);
	const [selectedVoiceId, setSelectedVoiceId] = useState('');
	const [selectedEngine, setSelectedEngine] = useState('');
	const [voiceSpeed, setVoiceSpeed] = useState(1);
	const [voicePitch, setVoicePitch] = useState(0);
	const [voiceLocale, setVoiceLocale] = useState('zh-CN');
	const [voiceQuery, setVoiceQuery] = useState('');
	const [voiceGender, setVoiceGender] = useState<VoiceGenderFilter>('all');
	const [previewingVoiceId, setPreviewingVoiceId] = useState('');
	const [previewLoadingVoiceId, setPreviewLoadingVoiceId] = useState('');
	const [voicePreviewError, setVoicePreviewError] = useState('');
	const [voiceCloneName, setVoiceCloneName] = useState('');
	const [voiceCloneAssetId, setVoiceCloneAssetId] = useState('');
	const [voiceCloneConsent, setVoiceCloneConsent] = useState(false);
	const [speechText, setSpeechText] = useState('');
	const [speechName, setSpeechName] = useState('课程旁白');
  const [avatarName, setAvatarName] = useState('');
  const [avatarType, setAvatarType] = useState<AvatarCreationType>('photo');
  const [avatarAssetId, setAvatarAssetId] = useState('');
  const [avatarPrompt, setAvatarPrompt] = useState('');
	const [lookName, setLookName] = useState('');
	const [lookPrompt, setLookPrompt] = useState('');
  const [likenessConsent, setLikenessConsent] = useState(false);
  const [confirmedScript, setConfirmedScript] = useState('');
  const [activeVideo, setActiveVideo] = useState<PlatformDigitalHumanVideo | null>(null);
	const [videoJobs, setVideoJobs] = useState<PlatformDigitalHumanVideo[]>([]);
	const [mediaJobs, setMediaJobs] = useState<PlatformDigitalHumanMediaJob[]>([]);
	const [targetMinutes, setTargetMinutes] = useState(5);
	const [mediaKind, setMediaKind] = useState<'translation' | 'lipsync'>('translation');
	const [mediaTitle, setMediaTitle] = useState('');
	const [mediaVideoAssetId, setMediaVideoAssetId] = useState('');
	const [mediaAudioAssetId, setMediaAudioAssetId] = useState('');
	const [mediaLanguage, setMediaLanguage] = useState('Chinese');
	const [activeMediaJob, setActiveMediaJob] = useState<PlatformDigitalHumanMediaJob | null>(null);
  const courseware = useMemo(() => assets.filter(isCourseware), [assets]);
  const avatarImages = useMemo(() => assets.filter(isAvatarImage), [assets]);
  const avatarVideos = useMemo(() => assets.filter(isAvatarVideo), [assets]);
  const voiceAudios = useMemo(() => assets.filter(isVoiceAudio), [assets]);
  const avatarSources = avatarType === 'photo' ? avatarImages : avatarType === 'digital_twin' ? avatarVideos : [];
  const selected = courseware.filter((asset) => selectedIds.includes(asset.id));
  const selectedDigitalHuman = digitalHumans.find((item) => item.id === selectedDigitalHumanId);
  const selectedLook = avatarLooks.find((item) => item.id === selectedLookId);
  const selectedVoice = voices.find((voice) => voice.voice_id === selectedVoiceId);
  const filteredVoices = useMemo(() => {
    const query = voiceQuery.trim().toLocaleLowerCase();
    return voices.filter((voice) => {
      if (voiceGender !== 'all' && voice.gender.toLocaleLowerCase() !== voiceGender) return false;
      if (!query) return true;
      return [voice.name, voice.language, voice.gender].some((value) => value.toLocaleLowerCase().includes(query));
    });
  }, [voiceGender, voiceQuery, voices]);
  const normalizedTargetMinutes = normalizeCourseDurationMinutes(targetMinutes);
  const targetSeconds = Math.round(normalizedTargetMinutes * 60);
  const estimatedScriptSeconds = useMemo(() => estimateCourseScriptSeconds(confirmedScript, voiceSpeed), [confirmedScript, voiceSpeed]);

  const [isAvatarPickerOpen, setIsAvatarPickerOpen] = useState(false);
  const [isVoicePickerOpen, setIsVoicePickerOpen] = useState(false);
  const [scriptViewMode, setScriptViewMode] = useState<'editor' | 'slides'>('editor');
  const [visualPreview, setVisualPreview] = useState<VisualPreviewTarget | null>(null);

  const scriptChapters = useMemo(() => {
    if (!confirmedScript.trim()) return [];
    const parts = splitConfirmedScript(confirmedScript);
    const expectedSeconds = distributeCourseSeconds(parts, targetSeconds);
    return parts.map((content, idx) => {
      const chars = [...content.replace(/\s+/g, '')].length;
      const estSec = estimateCourseScriptSeconds(content, voiceSpeed);
      return {
        index: idx + 1,
        content,
        characters: chars,
        estimatedSeconds: estSec,
        allocatedSeconds: expectedSeconds[idx] ?? estSec,
      };
    });
  }, [confirmedScript, targetSeconds, voiceSpeed]);

  useEffect(() => {
    if (!visualPreview) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setVisualPreview(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [visualPreview]);

  const confirmedScriptChars = useMemo(() => [...confirmedScript.replace(/\s+/g, '')].length, [confirmedScript]);
  const pacingDelta = estimatedScriptSeconds - targetSeconds;
  const pacingTolerance = Math.max(15, targetSeconds * 0.18);
  const pacingStatus: 'empty' | 'perfect' | 'long' | 'short' = !confirmedScript.trim()
    ? 'empty'
    : Math.abs(pacingDelta) <= pacingTolerance
    ? 'perfect'
    : pacingDelta > pacingTolerance
    ? 'long'
    : 'short';

  const pacingFeedback = useMemo(() => {
    if (!confirmedScript.trim()) return '';
    if (pacingStatus === 'perfect') {
      return t('时长极佳（目标 {target} 分钟，当前约 {actual} 分钟）', {
        target: String(normalizedTargetMinutes),
        actual: (estimatedScriptSeconds / 60).toFixed(1),
      });
    }
    if (pacingStatus === 'long') {
      return t('讲稿偏长（超出目标约 {sec} 秒，建议精简）', {
        sec: String(Math.round(pacingDelta)),
      });
    }
    return t('讲稿偏短（距目标差约 {sec} 秒，可丰富讲义细节）', {
      sec: String(Math.round(Math.abs(pacingDelta))),
    });
  }, [confirmedScript, estimatedScriptSeconds, normalizedTargetMinutes, pacingDelta, pacingStatus, t]);

  const stopVoicePreview = () => {
    const audio = voiceAudioRef.current;
    voiceAudioRef.current = null;
    if (audio) pauseVoiceAudio(audio);
    setPreviewingVoiceId('');
    setPreviewLoadingVoiceId('');
  };
  const selectVoice = (voiceId: string) => {
    if (voiceId !== selectedVoiceId) stopVoicePreview();
    setSelectedVoiceId(voiceId);
  };
  const toggleVoicePreview = async (voice: PlatformDigitalHumanVoice) => {
    if (!voice.preview_audio_url) {
      setVoicePreviewError(t('这个音色暂时没有可试听的样音。'));
      return;
    }
    if (previewingVoiceId === voice.voice_id || previewLoadingVoiceId === voice.voice_id) {
      stopVoicePreview();
      return;
    }
    stopVoicePreview();
    setVoicePreviewError('');
    setPreviewLoadingVoiceId(voice.voice_id);
    const audio = new Audio(voice.preview_audio_url);
    audio.preload = 'auto';
    voiceAudioRef.current = audio;
    audio.onplaying = () => {
      if (voiceAudioRef.current !== audio) return;
      setPreviewLoadingVoiceId('');
      setPreviewingVoiceId(voice.voice_id);
    };
    audio.onended = () => {
      if (voiceAudioRef.current !== audio) return;
      voiceAudioRef.current = null;
      setPreviewingVoiceId('');
      setPreviewLoadingVoiceId('');
    };
    audio.onerror = () => {
      if (voiceAudioRef.current !== audio) return;
      voiceAudioRef.current = null;
      setPreviewingVoiceId('');
      setPreviewLoadingVoiceId('');
      setVoicePreviewError(t('试听加载失败，请稍后重试。'));
    };
    try {
      await audio.play();
    } catch {
      if (voiceAudioRef.current !== audio) return;
      voiceAudioRef.current = null;
      setPreviewingVoiceId('');
      setPreviewLoadingVoiceId('');
      setVoicePreviewError(t('试听播放失败，请检查网络后重试。'));
    }
  };

  const reload = async () => {
    if (!platformManagedClient()) return;
    const items = await listPlatformDigitalHumans();
    setDigitalHumans(items);
    setSelectedDigitalHumanId((current) => items.some((item) => item.id === current) ? current : (items.find(isReady)?.id ?? ''));
  };
  const reloadVoices = async () => {
	if (!platformManagedClient()) return;
	const results = await Promise.allSettled([
		listPlatformDigitalHumanVoices('Chinese', 'public'),
		listPlatformDigitalHumanVoices('', 'private'),
	]);
	const publicItems = results[0].status === 'fulfilled' ? results[0].value : [];
	const privateItems = results[1].status === 'fulfilled' ? results[1].value : [];
	const items = [...privateItems, ...publicItems];
	if (items.length === 0) {
		const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
		if (failure) throw failure.reason;
	}
	setVoices(items);
	setSelectedVoiceId((current) => items.some((item) => item.voice_id === current && isVoiceReady(item))
		? current : (items.find(isVoiceReady)?.voice_id ?? ''));
  };
  const reloadJobs = async () => {
	if (!platformManagedClient()) return;
	const [videos, media] = await Promise.all([listPlatformDigitalHumanVideos(), listPlatformDigitalHumanMediaJobs()]);
	setVideoJobs(videos);
	setMediaJobs(media);
	setActiveVideo((current) => videos.find((item) => item.id === current?.id) ?? videos.find((item) => isPendingStatus(item.status)) ?? videos[0] ?? null);
	setActiveMediaJob((current) => media.find((item) => item.id === current?.id) ?? media.find((item) => isPendingStatus(item.status)) ?? media[0] ?? null);
  };
  useEffect(() => {
	void reload().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
	void reloadVoices().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
	void reloadJobs().catch(() => undefined);
  }, []);
	useEffect(() => {
		if (!platformManagedClient() || !digitalHumans.some(needsAvatarRefresh)) return undefined;
		const timer = window.setTimeout(() => {
			void Promise.all(digitalHumans.filter(needsAvatarRefresh).map(async (item) => {
				try { return await refreshPlatformDigitalHuman(item.id); }
				catch { return null; }
			})).then((updates) => {
				const completedUpdates = updates.filter((item): item is PlatformDigitalHuman => item !== null);
				if (completedUpdates.length === 0) return;
				const byId = new Map(completedUpdates.map((item) => [item.id, item]));
				setDigitalHumans((current) => current.map((item) => byId.get(item.id) ?? item));
			});
		}, 10_000);
		return () => window.clearTimeout(timer);
	}, [digitalHumans]);
	useEffect(() => {
		const pending = voices.filter((voice) => voice.type === 'private' && voice.id && !isVoiceReady(voice) && !['failed', 'error'].includes((voice.status ?? '').toLowerCase()));
		if (pending.length === 0) return undefined;
		const timer = window.setTimeout(() => {
			void Promise.all(pending.map(async (voice) => {
				try { return await refreshPlatformDigitalHumanVoice(voice.id!); }
				catch { return null; }
			})).then((updates) => {
				const completedUpdates = updates.filter((item): item is PlatformDigitalHumanVoice => item !== null);
				if (completedUpdates.length === 0) return;
				const byId = new Map(completedUpdates.map((item) => [item.id, item]));
				setVoices((current) => current.map((item) => item.id && byId.get(item.id) ? byId.get(item.id)! : item));
			});
		}, 10_000);
		return () => window.clearTimeout(timer);
	}, [voices]);
	useEffect(() => () => {
		const audio = voiceAudioRef.current;
		voiceAudioRef.current = null;
		if (audio) pauseVoiceAudio(audio);
	}, []);
	useEffect(() => {
		const preferred = selectedDigitalHuman?.provider_voice_id;
		if (preferred && preferred !== selectedVoiceId && voices.some((voice) => voice.voice_id === preferred)) {
			stopVoicePreview();
			setSelectedVoiceId(preferred);
		}
	}, [selectedDigitalHumanId, selectedDigitalHuman?.provider_voice_id, selectedVoiceId, voices]);
	useEffect(() => {
		const supported = selectedLook?.supported_api_engines ?? selectedDigitalHuman?.supported_api_engines ?? [];
		setSelectedEngine((current) => supported.includes(current) ? current : (supported[0] ?? ''));
	}, [selectedDigitalHumanId, selectedDigitalHuman?.supported_api_engines, selectedLookId, selectedLook?.supported_api_engines]);
	useEffect(() => {
		if (!selectedDigitalHumanId) { setAvatarLooks([]); setSelectedLookId(''); return; }
		void listPlatformDigitalHumanLooks(selectedDigitalHumanId).then((items) => {
			setAvatarLooks(items);
			setSelectedLookId((current) => items.some((item) => item.id === current) ? current
				: (items.find((item) => item.id === selectedDigitalHuman?.provider_look_id)?.id ?? items[0]?.id ?? ''));
		}).catch(() => { setAvatarLooks([]); setSelectedLookId(''); });
	}, [selectedDigitalHumanId, selectedDigitalHuman?.provider_look_id]);
	useEffect(() => {
		if (!selectedDigitalHumanId || !avatarLooks.some((item) => !isAvatarStatusReady(item.status))) return undefined;
		const timer = window.setTimeout(() => {
			void listPlatformDigitalHumanLooks(selectedDigitalHumanId).then(setAvatarLooks).catch(() => undefined);
		}, 10_000);
		return () => window.clearTimeout(timer);
	}, [avatarLooks, selectedDigitalHumanId]);
  useEffect(() => {
    if (!activeVideo || !['processing', 'submitting'].includes(activeVideo.status)) return undefined;
    const timer = window.setTimeout(() => {
      void refreshPlatformDigitalHumanVideo(activeVideo.id).then(async (updated) => {
        setActiveVideo(updated);
		setVideoJobs((current) => current.map((item) => item.id === updated.id ? updated : item));
        if (updated.status !== 'completed' || importedVideoIds.current.has(updated.id)) return;
        const imported = await Promise.all(updated.segments.map((segment) => importPlatformDigitalHumanVideoSegment(segment, fps)));
        imported.forEach(onAddGeneratedMedia);
        importedVideoIds.current.add(updated.id);
      }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [activeVideo, fps, onAddGeneratedMedia]);
	useEffect(() => {
		if (!activeMediaJob || !['processing', 'pending', 'queued', 'running', 'submitting'].includes(activeMediaJob.status.toLowerCase())) return undefined;
		const timer = window.setTimeout(() => {
			void refreshPlatformDigitalHumanMediaJob(activeMediaJob.id).then(async (updated) => {
				setActiveMediaJob(updated);
				setMediaJobs((current) => current.map((item) => item.id === updated.id ? updated : item));
				if (updated.status.toLowerCase() !== 'completed' || importedMediaJobIds.current.has(updated.id)) return;
				const asset = await importPlatformDigitalHumanMediaJob(updated, fps);
				onAddGeneratedMedia(asset); onAddGeneratedMediaToTimeline([asset]);
				importedMediaJobIds.current.add(updated.id);
			}).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
		}, 12_000);
		return () => window.clearTimeout(timer);
	}, [activeMediaJob, fps, onAddGeneratedMedia, onAddGeneratedMediaToTimeline]);

  const toggle = (id: string) => setSelectedIds((current) => current.includes(id)
    ? current.filter((value) => value !== id) : [...current, id]);
  const importFiles = async (files: File[]) => {
    setError('');
    for (const file of files) {
      if (!/\.(?:pptx|pdf|docx|txt|md)$/i.test(file.name)) {
        setError(t('智能制课仅支持 PPTX、PDF、DOCX、TXT 或 Markdown 课件。')); continue;
      }
      try {
        const asset = await onImportMedia(file);
        setSelectedIds((current) => current.includes(asset.id) ? current : [...current, asset.id]);
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    }
  };
  const importAvatarSource = async (file: File) => {
    setError('');
    const validPhoto = avatarType === 'photo' && /^image\/(?:jpeg|png)$/.test(file.type) && /\.(?:jpe?g|png)$/i.test(file.name);
    const validTwin = avatarType === 'digital_twin' && /^video\/(?:mp4|webm)$/.test(file.type) && /\.(?:mp4|webm)$/i.test(file.name);
    if (!validPhoto && !validTwin) {
      setError(avatarType === 'photo' ? t('照片数字人仅支持 JPG 或 PNG 图片。') : t('视频数字分身仅支持 MP4 或 WebM 视频。')); return;
    }
    try {
      const asset = await onImportMedia(file);
      setAvatarAssetId(asset.id);
      if (!avatarName) setAvatarName(file.name.replace(/\.[^.]+$/, ''));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const createAvatar = async () => {
    const source = avatarSources.find((item) => item.id === avatarAssetId);
    if (!avatarName.trim() || busy || (avatarType === 'prompt' ? !avatarPrompt.trim() : (!source || !likenessConsent))) return;
    setBusy('avatar'); setError('');
    try {
      const created = await createPlatformDigitalHuman({
        name: avatarName.trim(), type: avatarType, source: source?.src,
        sourceContentType: source ? contentTypeForAvatarSource(source) : undefined,
        prompt: avatarType === 'prompt' ? avatarPrompt.trim() : undefined, aspectRatio: '16:9', likenessConsent,
      });
      setDigitalHumans((current) => [created, ...current]);
      setSelectedDigitalHumanId(created.id);
      setAvatarName(''); setAvatarAssetId(''); setAvatarPrompt(''); setLikenessConsent(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
  const startAvatarConsent = async (item: PlatformDigitalHuman) => {
    if (consentBusyId || item.type !== 'digital_twin') return;
    setConsentBusyId(item.id); setError('');
    try {
      const result = await createPlatformDigitalHumanConsent(item.id);
      setDigitalHumans((current) => current.map((candidate) => candidate.id === item.id
        ? { ...candidate, consent_status: result.consent_status ?? candidate.consent_status } : candidate));
      if (!result.url) throw new Error(t('未获取到本人授权页面，请稍后重试。'));
      window.open(result.url, '_blank', 'noopener,noreferrer');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setConsentBusyId(''); }
  };
  const createAvatarLook = async () => {
    if (!selectedDigitalHuman || !lookName.trim() || !lookPrompt.trim() || busy) return;
    setBusy('avatar'); setError('');
    try {
      const created = await createPlatformDigitalHumanLook(selectedDigitalHuman.id, {
        name: lookName.trim(), prompt: lookPrompt.trim(), baseLookId: selectedLookId || selectedDigitalHuman.provider_look_id, aspectRatio: '16:9',
      });
      setAvatarLooks((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setSelectedLookId(created.id); setLookName(''); setLookPrompt('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
  const refreshAvatar = async (id: string) => {
    if (busy) return;
    setBusy('refresh'); setError('');
    try {
      const updated = await refreshPlatformDigitalHuman(id);
      setDigitalHumans((current) => current.map((item) => item.id === id ? updated : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
  const removeAvatar = async (item: PlatformDigitalHuman) => {
    if (busy || !window.confirm(t('确定删除数字人「{name}」吗？', { name: item.name }))) return;
    setBusy('delete'); setError('');
    try {
      await deletePlatformDigitalHuman(item.id);
      setDigitalHumans((current) => current.filter((candidate) => candidate.id !== item.id));
      if (selectedDigitalHumanId === item.id) setSelectedDigitalHumanId('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
  const importVoiceAudio = async (file: File) => {
    setError('');
    if (!/^audio\/(?:mpeg|mp3|wav|x-wav|mp4|webm)$/.test(file.type) || !/\.(?:mp3|wav|m4a|webm)$/i.test(file.name)) {
      setError(t('声音克隆仅支持 MP3、WAV、M4A 或 WebM 音频。')); return;
    }
    try {
      const asset = await onImportMedia(file);
      setVoiceCloneAssetId(asset.id);
      if (!voiceCloneName) setVoiceCloneName(file.name.replace(/\.[^.]+$/, ''));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const cloneVoice = async () => {
    const source = voiceAudios.find((item) => item.id === voiceCloneAssetId);
    if (!source || !voiceCloneName.trim() || !voiceCloneConsent || busy) return;
    setBusy('voice'); setError('');
    try {
      const quote = await quotePlatformDigitalHumanVoiceClone();
      if (!window.confirm(t('声音克隆费用 ¥{amount}，确认提交吗？', { amount: (quote.price_cents / 100).toFixed(2) }))) return;
      const created = await clonePlatformDigitalHumanVoice({
        name: voiceCloneName.trim(), source: source.src, sourceContentType: contentTypeForVoiceSource(source),
        language: 'zh', removeBackgroundNoise: true, voiceConsent: voiceCloneConsent, idempotencyKey: crypto.randomUUID(),
      });
      setVoices((current) => [created, ...current]);
      setVoiceCloneName(''); setVoiceCloneAssetId(''); setVoiceCloneConsent(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
  const removeVoice = async (voice: PlatformDigitalHumanVoice) => {
    if (!voice.id || busy || !window.confirm(t('确定删除私有音色「{name}」吗？', { name: voice.name }))) return;
    setBusy('delete'); setError('');
    try {
      await deletePlatformDigitalHumanVoice(voice.id);
      setVoices((current) => current.filter((candidate) => candidate.id !== voice.id));
      if (selectedVoiceId === voice.voice_id) setSelectedVoiceId('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
  const generateSpeech = async () => {
    if (!selectedVoice || !isVoiceReady(selectedVoice) || !speechText.trim() || busy) return;
    setBusy('speech'); setError('');
    try {
      const input = { voiceId: selectedVoice.voice_id, voiceType: selectedVoice.type, text: speechText.trim(), speed: voiceSpeed, locale: voiceLocale.trim() || undefined };
      const quote = await quotePlatformDigitalHumanSpeech(input);
      const confirmed = window.confirm(t('预计时长约 {seconds} 秒，预计费用 ¥{amount}。确认生成配音并加入时间线吗？', {
        seconds: String(quote.estimated_seconds), amount: (quote.estimated_amount_cents / 100).toFixed(2),
      }));
      if (!confirmed) return;
      const result = await createPlatformDigitalHumanSpeech({ ...input, idempotencyKey: crypto.randomUUID() });
      const asset = await importPlatformDigitalHumanSpeech(result, speechName.trim() || t('课程旁白'), fps);
      onAddGeneratedMedia(asset);
      onAddGeneratedMediaToTimeline([asset]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
	const startMediaJob = async () => {
		const video = avatarVideos.find((asset) => asset.id === mediaVideoAssetId);
		const audio = voiceAudios.find((asset) => asset.id === mediaAudioAssetId);
		if (!video || (mediaKind === 'lipsync' && !audio) || !mediaTitle.trim() || busy) return;
		setBusy('media'); setError('');
		try {
			const expectedSeconds = Math.max(1, Math.ceil(video.durationInFrames / fps));
			const quote = await quotePlatformDigitalHumanMediaJob({ kind: mediaKind, expectedSeconds });
			if (!window.confirm(t('预计时长约 {seconds} 秒，预计费用 ¥{amount}。确认提交吗？', {
				seconds: String(quote.estimated_seconds), amount: (quote.estimated_amount_cents / 100).toFixed(2),
			}))) return;
			const created = await createPlatformDigitalHumanMediaJob({
				kind: mediaKind, title: mediaTitle.trim(), videoSource: video.src,
				videoContentType: contentTypeForAvatarSource(video), audioSource: audio?.src,
				audioContentType: audio ? contentTypeForVoiceSource(audio) : undefined,
				outputLanguage: mediaKind === 'translation' ? mediaLanguage : undefined,
				expectedSeconds, idempotencyKey: crypto.randomUUID(),
			});
			setActiveMediaJob(created);
			setMediaJobs((current) => [created, ...current.filter((item) => item.id !== created.id)]);
			setActiveModule('tasks');
		} catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setBusy(null); }
	};
  const run = async (action: CourseAction) => {
    if (!selected.length || busy) return;
    if (action === 'video' && (!selectedDigitalHuman || !isReady(selectedDigitalHuman))) {
      setError(t('请先选择一个已就绪的自定义数字人。')); return;
    }
    if (action === 'video' && !confirmedScript.trim()) {
      setError(t('请先确认讲稿，并粘贴到“已确认讲稿”输入框。')); return;
    }
	if (action === 'video' && !selectedVoiceId) {
	  setError(t('请选择课程配音。')); return;
	}
	if (action === 'video' && selectedVoice && !isVoiceReady(selectedVoice)) {
	  setError(t('所选私有音色仍在处理中，请稍后再试。')); return;
	}
    setError(''); setBusy(action);
    try {
      if (action === 'script') {
        await onGenerateCourse(selected, action, selectedDigitalHuman, { targetMinutes: normalizedTargetMinutes });
      } else if (selectedDigitalHuman) {
        const parts = splitConfirmedScript(confirmedScript);
        const title = selected[0]?.name.replace(/\.[^.]+$/, '') || t('智能课程');
        const expectedSeconds = distributeCourseSeconds(parts, targetSeconds);
        const segments = parts.map((script, index) => ({ script, expectedSeconds: expectedSeconds[index] }));
        const quote = await quotePlatformDigitalHumanVideo(segments, selectedEngine || undefined);
        const confirmed = window.confirm(t(
          '预计时长约 {seconds} 秒，预计费用 ¥{amount}。实际按当前平台定价与预留额度结算，确认生成吗？',
          { seconds: String(quote.estimated_seconds), amount: (quote.estimated_amount_cents / 100).toFixed(2) },
        ));
        if (!confirmed) return;
        const created = await createPlatformDigitalHumanVideo({
          digitalHumanId: selectedDigitalHuman.id, voiceId: selectedVoiceId, title,
          lookId: selectedLookId || undefined,
          engine: selectedEngine || undefined,
          voiceSettings: { speed: voiceSpeed, pitch: voicePitch, locale: voiceLocale.trim() || undefined },
          idempotencyKey: crypto.randomUUID(),
          segments: parts.map((script, index) => ({ title: `${title} ${index + 1}`, script, expectedSeconds: expectedSeconds[index] })),
        });
        setActiveVideo(created);
		setVideoJobs((current) => [created, ...current.filter((item) => item.id !== created.id)]);
		setActiveModule('tasks');
      }
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
  const retryVideo = async (job: PlatformDigitalHumanVideo | null = activeVideo) => {
    if (!job || busy) return;
    setBusy('video'); setError('');
    try {
		const updated = await retryPlatformDigitalHumanVideo(job.id);
		setActiveVideo(updated);
		setVideoJobs((current) => current.map((item) => item.id === updated.id ? updated : item));
	}
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
	const refreshVideoTask = async (job: PlatformDigitalHumanVideo) => {
		setBusy('refresh'); setError('');
		try {
			const updated = await refreshPlatformDigitalHumanVideo(job.id);
			setActiveVideo(updated);
			setVideoJobs((current) => current.map((item) => item.id === updated.id ? updated : item));
		} catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setBusy(null); }
	};
	const importVideoTask = async (job: PlatformDigitalHumanVideo) => {
		if (job.status !== 'completed' || importedVideoIds.current.has(job.id)) return;
		setBusy('refresh'); setError('');
		try {
			const imported = await Promise.all(job.segments.filter((segment) => segment.video_url).map((segment) => importPlatformDigitalHumanVideoSegment(segment, fps)));
			imported.forEach(onAddGeneratedMedia);
			if (imported.length > 0) onAddGeneratedMediaToTimeline(imported);
			importedVideoIds.current.add(job.id);
		} catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setBusy(null); }
	};
	const refreshMediaTask = async (job: PlatformDigitalHumanMediaJob) => {
		setBusy('refresh'); setError('');
		try {
			const updated = await refreshPlatformDigitalHumanMediaJob(job.id);
			setActiveMediaJob(updated);
			setMediaJobs((current) => current.map((item) => item.id === updated.id ? updated : item));
		} catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setBusy(null); }
	};
	const importMediaTask = async (job: PlatformDigitalHumanMediaJob) => {
		if (job.status.toLowerCase() !== 'completed' || importedMediaJobIds.current.has(job.id)) return;
		setBusy('refresh'); setError('');
		try {
			const asset = await importPlatformDigitalHumanMediaJob(job, fps);
			onAddGeneratedMedia(asset); onAddGeneratedMediaToTimeline([asset]);
			importedMediaJobIds.current.add(job.id);
		} catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setBusy(null); }
	};

  const modules: Array<{ id: DigitalHumanModule; label: string; icon: 'users' | 'mic' | 'bookOpen' | 'video' | 'history' }> = [
    { id: 'course', label: t('智能制课'), icon: 'bookOpen' },
    { id: 'avatars', label: t('形象库'), icon: 'users' },
    { id: 'voices', label: t('声音与配音'), icon: 'mic' },
    { id: 'media', label: t('翻译与口型'), icon: 'video' },
    { id: 'tasks', label: t('任务与成品'), icon: 'history' },
  ];

  return <div className="cc-digital-human-panel">
    <div className="cc-digital-human-module-nav" role="tablist" aria-label={t('数字人制课功能')}>
      {modules.map((module) => <button key={module.id} type="button" role="tab" aria-selected={activeModule === module.id}
        className={activeModule === module.id ? 'selected' : ''} onClick={() => setActiveModule(module.id)}>
        <Icon name={module.icon} size={14} /><span>{module.label}</span>
        {module.id === 'tasks' && (videoJobs.some((item) => isPendingStatus(item.status)) || mediaJobs.some((item) => isPendingStatus(item.status))) && <i />}
      </button>)}
    </div>

    {!platformManagedClient() ? <div className="cc-digital-human-note">{t('登录业务平台后即可使用云端数字人与智能制课。')}</div> : <>
      {activeModule === 'course' && <section className="cc-digital-human-module-body">
        {/* Section 1: 课件载入卡片 */}
        <div className="cc-course-card">
          <div className="cc-course-card-header">
            <div className="cc-course-card-title">
              <Icon name="upload" size={14} />
              <span>{t('课件素材')}</span>
              <span className="cc-course-badge-pro">{courseware.length}</span>
            </div>
            <span className="cc-course-card-subtitle">
              {selected.length > 0 ? t('已选 {count} 个课件', { count: String(selected.length) }) : t('支持多选参与制课')}
            </span>
          </div>

          <button
            type="button"
            className="cc-courseware-drop"
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); void importFiles(Array.from(event.dataTransfer.files)); }}
          >
            <Icon name="upload" size={22} />
            <strong>{t('上传课件并自动解析')}</strong>
            <small>{t('拖拽或点击上传，智能提炼章节重点与时间分配')}</small>
            <div className="cc-courseware-formats">
              <span className="cc-format-badge" style={{ color: '#ff6b4a', background: 'rgba(255, 107, 74, 0.14)' }}>PPTX</span>
              <span className="cc-format-badge" style={{ color: '#ff4d4f', background: 'rgba(255, 77, 79, 0.14)' }}>PDF</span>
              <span className="cc-format-badge" style={{ color: '#2b7fff', background: 'rgba(43, 127, 255, 0.14)' }}>DOCX</span>
              <span className="cc-format-badge" style={{ color: '#a855f7', background: 'rgba(168, 85, 247, 0.14)' }}>MD</span>
              <span className="cc-format-badge" style={{ color: '#10b981', background: 'rgba(16, 185, 129, 0.14)' }}>TXT</span>
            </div>
            <input
              ref={inputRef}
              type="file"
              hidden
              multiple
              accept=".pptx,.pdf,.docx,.txt,.md,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation"
              onChange={(event) => { if (event.target.files) void importFiles(Array.from(event.target.files)); event.target.value = ''; }}
            />
          </button>

          {courseware.length > 0 && (
            <div className="cc-courseware-list" role="listbox">
              <div className="cc-courseware-list-heading">
                <span>{t('课件列表')}</span>
                <small>{t('{selected}/{total} 已选中', { selected: String(selected.length), total: String(courseware.length) })}</small>
              </div>
              {courseware.map((asset) => {
                const isSelected = selectedIds.includes(asset.id);
                const badge = getFormatBadge(asset.name);
                return (
                  <button
                    key={asset.id}
                    type="button"
                    className={`cc-courseware-item${isSelected ? ' selected' : ''}`}
                    onClick={() => toggle(asset.id)}
                  >
                    <span className="cc-format-badge" style={{ color: badge.color, background: badge.bg }}>
                      {badge.label}
                    </span>
                    <span className="cc-courseware-item-name" title={asset.name}>
                      {asset.name}
                    </span>
                    {isSelected ? <span className="cc-courseware-item-check"><Icon name="check" size={13} /></span> : <span style={{ width: 13 }} />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Section 2: 讲师与音色配对卡片 */}
        <div className="cc-course-pair-cards">
          {/* Presenter Card */}
          <div className="cc-pair-card">
            <div className="cc-pair-card-top">
              {selectedDigitalHuman?.preview_image_url ? (
                <img src={selectedDigitalHuman.preview_image_url} alt={selectedDigitalHuman.name} className="cc-pair-avatar-thumb" />
              ) : (
                <div className="cc-pair-avatar-placeholder">
                  <Icon name="users" size={18} />
                </div>
              )}
              <div className="cc-pair-card-meta">
                <div className="cc-pair-card-tag-row">
                  <span className="cc-pair-card-type-tag">{t('授课讲师')}</span>
                  {selectedDigitalHuman && (
                    <span className={`cc-status-chip ${isReady(selectedDigitalHuman) ? 'ready' : 'pending'}`}>
                      {isReady(selectedDigitalHuman) ? t('就绪') : t('处理中')}
                    </span>
                  )}
                </div>
                <div className="cc-pair-card-name" title={selectedDigitalHuman?.name ?? t('未选择形象')}>
                  {selectedDigitalHuman?.name ?? t('未选择形象')}
                </div>
                <div className="cc-pair-card-sub">
                  {selectedDigitalHuman
                    ? (selectedDigitalHuman.type === 'digital_twin' ? t('真人视频分身') : t('照片数字人'))
                    : t('点击下方挑选')}
                </div>
              </div>
            </div>
            <div className="cc-pair-card-actions">
              <button
                type="button"
                className="cc-btn-switch"
                onClick={() => setIsAvatarPickerOpen(true)}
                title={t('更换数字人形象')}
              >
                <Icon name="refresh" size={11} />
                <span>{selectedDigitalHuman ? t('更换') : t('挑选')}</span>
              </button>
            </div>
          </div>

          {/* Voice Card */}
          <div className="cc-pair-card">
            <div className="cc-pair-card-top">
              <div className="cc-pair-avatar-placeholder">
                <Icon name="mic" size={18} />
              </div>
              <div className="cc-pair-card-meta">
                <div className="cc-pair-card-tag-row">
                  <span className="cc-pair-card-type-tag">{t('配音音色')}</span>
                  {selectedVoice && (
                    <span className="cc-status-chip ready">
                      {selectedVoice.gender === 'female' ? t('女声') : selectedVoice.gender === 'male' ? t('男声') : t('原声')}
                    </span>
                  )}
                </div>
                <div className="cc-pair-card-name" title={selectedVoice?.name ?? t('未选择声音')}>
                  {selectedVoice?.name ?? t('未选择声音')}
                </div>
                <div className="cc-pair-card-sub">
                  {selectedVoice?.language || t('中文普通话')}
                </div>
              </div>
            </div>
            <div className="cc-pair-card-actions">
              <div className="cc-speed-pills">
                {[0.9, 1.0, 1.15].map((speed) => (
                  <button
                    key={speed}
                    type="button"
                    className={`cc-speed-pill${Math.abs(voiceSpeed - speed) < 0.03 ? ' selected' : ''}`}
                    onClick={() => setVoiceSpeed(speed)}
                  >
                    {speed}x
                  </button>
                ))}
              </div>
              <button
                type="button"
                className={`cc-waveform-btn${previewingVoiceId === selectedVoiceId ? ' playing' : ''}`}
                disabled={!selectedVoice?.preview_audio_url}
                onClick={() => { if (selectedVoice) void toggleVoicePreview(selectedVoice); }}
                title={t('试听配音')}
              >
                <WaveformBars active={previewingVoiceId === selectedVoiceId} />
                <Icon
                  name={previewLoadingVoiceId === selectedVoiceId ? 'clock' : previewingVoiceId === selectedVoiceId ? 'pause' : 'play'}
                  size={11}
                />
              </button>
              <button
                type="button"
                className="cc-btn-switch"
                onClick={() => setIsVoicePickerOpen(true)}
                title={t('更换音色')}
              >
                <Icon name="refresh" size={11} />
                <span>{selectedVoice ? t('更换') : t('挑选')}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Section 3: 目标时长与节奏规划 */}
        <div className="cc-course-duration-card">
          <div className="cc-course-duration-header">
            <div className="cc-course-duration-header-left">
              <Icon name="clock" size={14} />
              <span>{t('成片目标时长')}</span>
            </div>
            <span className="cc-duration-value-tag">{normalizedTargetMinutes} {t('分钟')}</span>
          </div>

          <div className="cc-course-duration-presets">
            {COURSE_DURATION_PRESETS.map((minutes) => (
              <button
                key={minutes}
                type="button"
                className={targetMinutes === minutes ? 'selected' : ''}
                onClick={() => setTargetMinutes(minutes)}
              >
                {minutes} {t('分钟')}
              </button>
            ))}
            <label className={(COURSE_DURATION_PRESETS as readonly number[]).includes(targetMinutes) ? '' : 'selected'}>
              <span>{t('自定义')}</span>
              <input
                type="number"
                min="0.5"
                max="120"
                step="0.5"
                value={targetMinutes}
                onChange={(event) => setTargetMinutes(Number(event.target.value))}
                onBlur={() => setTargetMinutes(normalizeCourseDurationMinutes(targetMinutes))}
              />
            </label>
          </div>

          {confirmedScript.trim() && (
            <>
              <div className="cc-pacing-bar-track">
                <div
                  className={`cc-pacing-bar-fill ${pacingStatus}`}
                  style={{
                    width: `${Math.min(100, Math.max(5, Math.round((estimatedScriptSeconds / (targetSeconds || 1)) * 100)))}%`,
                  }}
                />
              </div>
              <div className={`cc-course-duration-match ${pacingStatus === 'perfect' ? 'perfect' : 'warning'}`}>
                <span>
                  <Icon name={pacingStatus === 'perfect' ? 'check' : 'info'} size={12} />
                  {' '}
                  {pacingFeedback}
                </span>
                <span>{confirmedScriptChars} {t('字')}</span>
              </div>
            </>
          )}
        </div>

        {/* Section 4: 讲稿与章节编排 */}
        <div className="cc-script-studio">
          <div className="cc-script-toolbar">
            <div className="cc-script-toolbar-left">
              <Icon name="text" size={13} />
              <span>{t('AI 提炼讲稿与章节编排')}</span>
              {scriptChapters.length > 0 && (
                <span className="cc-chapter-count-badge">
                  {t('{count} 个分页', { count: String(scriptChapters.length) })}
                </span>
              )}
            </div>
            <div className="cc-script-toolbar-actions">
              <button
                type="button"
                className="cc-btn-ghost-sm"
                onClick={() => setScriptViewMode((m) => (m === 'editor' ? 'slides' : 'editor'))}
                title={scriptViewMode === 'editor' ? t('切换到逐页章节预览') : t('切换到全文编辑')}
              >
                <Icon name={scriptViewMode === 'editor' ? 'bookOpen' : 'text'} size={11} />
                <span>{scriptViewMode === 'editor' ? t('逐页卡片') : t('全文编辑')}</span>
              </button>
              <button
                type="button"
                className="cc-btn-ghost-sm"
                onClick={() => {
                  setConfirmedScript((prev) => (prev ? `${prev.trimEnd()}\n\n---\n\n` : ''));
                }}
                title={t('在末尾插入分页符 ---')}
              >
                <Icon name="plus" size={11} />
                <span>{t('分页符')}</span>
              </button>
            </div>
          </div>

          {scriptViewMode === 'editor' ? (
            <textarea
              className="cc-script-textarea"
              value={confirmedScript}
              placeholder={t('点击下方「AI 提炼逐页讲稿」自动根据课件大纲生成，或在此直接粘贴/编写。\n每一段代表一页 PPT 讲义，使用单独一行的 --- 分隔各个页面。')}
              onChange={(event) => setConfirmedScript(event.target.value)}
            />
          ) : (
            <div className="cc-chapter-cards-list">
              {scriptChapters.length > 0 ? (
                scriptChapters.map((chap) => (
                  <div key={chap.index} className="cc-chapter-card">
                    <div className="cc-chapter-card-header">
                      <strong>{t('第 {idx} 页 / 章节', { idx: String(chap.index) })}</strong>
                      <span>{chap.characters} {t('字')} · ≈{Math.round(chap.estimatedSeconds)} {t('秒')}</span>
                    </div>
                    <p>{chap.content}</p>
                  </div>
                ))
              ) : (
                <div className="cc-voice-picker-empty">
                  {t('暂无讲稿章节，输入讲稿并使用 --- 分隔即可生成章节卡片')}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 高级参数微调 */}
        <details className="cc-course-advanced-details">
          <summary>
            <Icon name="sliders" size={13} />
            <span>{t('高级参数微调 (造型、合成引擎、语速与音调)')}</span>
          </summary>
          <div className="cc-course-advanced-body">
            <div className="cc-advanced-row">
              <span>{t('数字人造型')}</span>
              <select
                value={selectedLookId}
                disabled={!selectedDigitalHuman || avatarLooks.length === 0}
                onChange={(event) => setSelectedLookId(event.target.value)}
              >
                {avatarLooks.length > 0 ? (
                  avatarLooks.map((look) => (
                    <option key={look.id} value={look.id}>
                      {look.name || t('造型 {id}', { id: look.id.slice(0, 8) })}
                    </option>
                  ))
                ) : (
                  <option value="">{t('当前默认造型')}</option>
                )}
              </select>
            </div>

            <div className="cc-advanced-row">
              <span>{t('合成渲染引擎')}</span>
              <select
                value={selectedEngine}
                disabled={!selectedDigitalHuman || ((selectedLook?.supported_api_engines ?? selectedDigitalHuman.supported_api_engines)?.length ?? 0) === 0}
                onChange={(event) => setSelectedEngine(event.target.value)}
              >
                {(selectedLook?.supported_api_engines ?? selectedDigitalHuman?.supported_api_engines ?? []).length > 0 ? (
                  (selectedLook?.supported_api_engines ?? selectedDigitalHuman?.supported_api_engines ?? []).map((engine) => (
                    <option key={engine} value={engine}>
                      {engine.replaceAll('_', ' ').toUpperCase()}
                    </option>
                  ))
                ) : (
                  <option value="">{t('选择数字人后自动匹配')}</option>
                )}
              </select>
            </div>

            <div className="cc-advanced-row">
              <span>{t('语速调节：{value}x', { value: voiceSpeed.toFixed(2) })}</span>
              <input
                type="range"
                min="0.5"
                max="1.5"
                step="0.05"
                value={voiceSpeed}
                onChange={(event) => setVoiceSpeed(Number(event.target.value))}
              />
            </div>

            <div className="cc-advanced-row">
              <span>{t('音调调节：{value}', { value: String(voicePitch) })}</span>
              <input
                type="range"
                min="-50"
                max="50"
                step="1"
                value={voicePitch}
                onChange={(event) => setVoicePitch(Number(event.target.value))}
              />
            </div>

            <div className="cc-advanced-row">
              <span>{t('语言区域')}</span>
              <input
                type="text"
                value={voiceLocale}
                maxLength={35}
                placeholder="zh-CN"
                onChange={(event) => setVoiceLocale(event.target.value)}
              />
            </div>
          </div>
        </details>

        {/* 底部操作按钮 */}
        <div className="cc-courseware-actions">
          <button
            type="button"
            className="cc-courseware-secondary"
            disabled={!selected.length || !!busy}
            onClick={() => { void run('script'); }}
          >
            <Icon name={busy === 'script' ? 'clock' : 'text'} size={14} />
            <span>{busy === 'script' ? t('正在提炼讲稿…') : t('AI 提炼逐页讲稿')}</span>
          </button>
          <button
            type="button"
            className="cc-digital-human-submit"
            disabled={!selected.length || !confirmedScript.trim() || !selectedDigitalHuman || !isReady(selectedDigitalHuman) || !selectedVoiceId || !!busy}
            onClick={() => { void run('video'); }}
          >
            <Icon name={busy === 'video' ? 'clock' : 'sparkles'} size={15} />
            <span>{busy === 'video' ? t('正在提交课程视频…') : t('确认并生成课程视频')}</span>
          </button>
        </div>

        {/* 内嵌数字人快捷挑选浮层 */}
        {isAvatarPickerOpen && (
          <div className="cc-quick-picker-backdrop" onClick={() => setIsAvatarPickerOpen(false)}>
            <div className="cc-quick-picker-modal" onClick={(e) => e.stopPropagation()}>
              <div className="cc-quick-picker-header">
                <div className="cc-quick-picker-title">
                  <Icon name="users" size={15} />
                  <span>{t('选择授课数字人')}</span>
                </div>
                <div className="cc-quick-picker-actions">
                  <button
                    type="button"
                    className="cc-btn-ghost-sm"
                    onClick={() => {
                      setIsAvatarPickerOpen(false);
                      setActiveModule('avatars');
                    }}
                  >
                    <Icon name="plus" size={11} />
                    <span>{t('形象库')}</span>
                  </button>
                  <button
                    type="button"
                    className="cc-btn-icon-sm"
                    onClick={() => setIsAvatarPickerOpen(false)}
                  >
                    <Icon name="x" size={13} />
                  </button>
                </div>
              </div>
              <div className="cc-quick-picker-body">
                {digitalHumans.length > 0 ? (
                  <div className="cc-digital-human-list">
                    {digitalHumans.map((item) => {
                      const isCurrent = selectedDigitalHumanId === item.id;
                      const ready = isReady(item);
                      return (
                        <article key={item.id} className={`cc-digital-human-card${isCurrent ? ' selected' : ''}`}>
                          <button
                            type="button"
                            className="cc-digital-human-card-main"
                            disabled={!ready}
                            onClick={() => {
                              setSelectedDigitalHumanId(item.id);
                              setIsAvatarPickerOpen(false);
                            }}
                          >
                            {item.preview_image_url ? (
                              <img src={item.preview_image_url} alt={item.name} />
                            ) : (
                              <span className="cc-digital-human-placeholder">
                                <Icon name="users" size={22} />
                              </span>
                            )}
                            <span className="cc-digital-human-card-copy">
                              <strong>{item.name}</strong>
                              <small>
                                {ready
                                  ? (item.type === 'digital_twin' ? t('视频分身 · 就绪') : t('照片数字人 · 就绪'))
                                  : t('处理中 / 待授权')}
                              </small>
                            </span>
                            {isCurrent && (
                              <span className="cc-avatar-selected-label">
                                <Icon name="check" size={11} />
                                {t('已选')}
                              </span>
                            )}
                          </button>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="cc-avatar-library-empty">
                    <span><Icon name="users" size={20} /></span>
                    <div>
                      <strong>{t('还没有数字人形象')}</strong>
                      <small>{t('点击右上角「形象库」创建您的第一个数字人')}</small>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 内嵌配音快捷挑选浮层 */}
        {isVoicePickerOpen && (
          <div className="cc-quick-picker-backdrop" onClick={() => setIsVoicePickerOpen(false)}>
            <div className="cc-quick-picker-modal" onClick={(e) => e.stopPropagation()}>
              <div className="cc-quick-picker-header">
                <div className="cc-quick-picker-title">
                  <Icon name="mic" size={15} />
                  <span>{t('选择课程配音')}</span>
                </div>
                <div className="cc-quick-picker-actions">
                  <button
                    type="button"
                    className="cc-btn-ghost-sm"
                    onClick={() => {
                      setIsVoicePickerOpen(false);
                      setActiveModule('voices');
                    }}
                  >
                    <Icon name="plus" size={11} />
                    <span>{t('声音库')}</span>
                  </button>
                  <button
                    type="button"
                    className="cc-btn-icon-sm"
                    onClick={() => setIsVoicePickerOpen(false)}
                  >
                    <Icon name="x" size={13} />
                  </button>
                </div>
              </div>
              <div className="cc-quick-picker-body">
                <div className="cc-voice-filters">
                  <label>
                    <Icon name="search" size={13} />
                    <input
                      value={voiceQuery}
                      onChange={(event) => setVoiceQuery(event.target.value)}
                      placeholder={t('搜索音色名称')}
                    />
                  </label>
                  <div className="cc-voice-gender-filter">
                    {(['all', 'female', 'male'] as VoiceGenderFilter[]).map((gender) => (
                      <button
                        key={gender}
                        type="button"
                        className={voiceGender === gender ? 'selected' : ''}
                        onClick={() => setVoiceGender(gender)}
                      >
                        {gender === 'all' ? t('全部') : gender === 'female' ? t('女声') : t('男声')}
                      </button>
                    ))}
                  </div>
                </div>
                <ul className="cc-voice-list">
                  {filteredVoices.map((voice) => {
                    const ready = isVoiceReady(voice);
                    const isCurrent = voice.voice_id === selectedVoiceId;
                    const playing = previewingVoiceId === voice.voice_id;
                    return (
                      <li key={voice.voice_id} className={`cc-voice-card${isCurrent ? ' selected' : ''}`}>
                        <button
                          type="button"
                          className="cc-voice-card-main"
                          disabled={!ready}
                          onClick={() => {
                            selectVoice(voice.voice_id);
                            setIsVoicePickerOpen(false);
                          }}
                        >
                          <span className="cc-voice-card-icon">
                            <Icon name="volume" size={14} />
                          </span>
                          <span className="cc-voice-card-copy">
                            <strong>{voice.name}</strong>
                            <small>
                              {voice.type === 'private' ? t('私有音色') : voice.gender === 'female' ? t('女声') : voice.gender === 'male' ? t('男声') : t('未标注')}
                              {' · '}
                              {ready ? (voice.language || t('中文')) : t('处理中')}
                            </small>
                          </span>
                          {isCurrent && <Icon name="check" size={13} />}
                        </button>
                        <button
                          type="button"
                          className={`cc-voice-card-preview${playing ? ' playing' : ''}`}
                          disabled={!voice.preview_audio_url}
                          onClick={() => { void toggleVoicePreview(voice); }}
                        >
                          <Icon
                            name={previewLoadingVoiceId === voice.voice_id ? 'clock' : playing ? 'pause' : 'play'}
                            size={12}
                          />
                        </button>
                      </li>
                    );
                  })}
                  {filteredVoices.length === 0 && (
                    <li className="cc-voice-picker-empty">{t('没有找到符合条件的音色')}</li>
                  )}
                </ul>
              </div>
            </div>
          </div>
        )}
      </section>}

      {activeModule === 'avatars' && <section className="cc-digital-human-module-body">
        <div className="cc-digital-human-field"><span>{t('创建新形象')}</span>
          <select value={avatarType} onChange={(event) => { setAvatarType(event.target.value as AvatarCreationType); setAvatarAssetId(''); }}>
            <option value="photo">{t('照片数字人')}</option><option value="digital_twin">{t('视频数字分身（效果更自然）')}</option><option value="prompt">{t('文字创建合成数字人')}</option>
          </select>
          <input value={avatarName} maxLength={120} placeholder={t('给数字人起个名字')} onChange={(event) => setAvatarName(event.target.value)} />
          {avatarType === 'prompt' ? <textarea value={avatarPrompt} maxLength={1000} placeholder={t('描述年龄、表情、发型、服装、场景和光线；该形象为完全合成，不会使用平台公共人物。')} onChange={(event) => setAvatarPrompt(event.target.value)} /> : <>
            <select value={avatarAssetId} onChange={(event) => setAvatarAssetId(event.target.value)}><option value="">{avatarType === 'photo' ? t('选择一张本人 JPG / PNG 照片') : t('选择一段本人 MP4 / WebM 视频')}</option>{avatarSources.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select>
            <button type="button" className="cc-courseware-secondary" onClick={() => avatarInputRef.current?.click()}><Icon name="upload" size={14} />{avatarType === 'photo' ? t('上传新照片') : t('上传训练视频')}</button>
            <input ref={avatarInputRef} type="file" hidden accept={avatarType === 'photo' ? 'image/jpeg,image/png,.jpg,.jpeg,.png' : 'video/mp4,video/webm,.mp4,.webm'} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importAvatarSource(file); event.target.value = ''; }} />
          </>}
          {avatarType === 'digital_twin' && <small>{t('建议上传 15 秒至 10 分钟、正脸清晰、声音干净的本人视频；创建后还需完成一次真人授权。')}</small>}
        </div>
        {avatarType !== 'prompt' && <label className="cc-digital-human-consent"><input type="checkbox" checked={likenessConsent} onChange={(event) => setLikenessConsent(event.target.checked)} /><span>{t('我确认已获得素材中人物的明确授权，并同意用于创建数字人形象。')}</span></label>}
        <button type="button" className="cc-digital-human-submit" disabled={!avatarName.trim() || !!busy || (avatarType === 'prompt' ? !avatarPrompt.trim() : (!avatarAssetId || !likenessConsent))} onClick={() => { void createAvatar(); }}><Icon name="sparkles" size={15} />{busy === 'avatar' ? t('正在创建…') : t('创建我的数字人')}</button>
        <section className="cc-avatar-library" aria-labelledby="cc-avatar-library-title">
          <div className="cc-avatar-library-heading"><div><span id="cc-avatar-library-title">{t('我的数字人')}</span><small>{t('选中的形象会用于智能制课')}</small></div><span>{t('{count} 个形象', { count: String(digitalHumans.length) })}</span></div>
          {digitalHumans.length > 0 ? <div className="cc-digital-human-list">{digitalHumans.map((item) => {
            const selectedAvatar = selectedDigitalHumanId === item.id;
            const waitingForConsent = item.type === 'digital_twin' && !isConsentReady(item.consent_status);
            return <article key={item.id} className={`cc-digital-human-card${selectedAvatar ? ' selected' : ''}`}>
              <button type="button" className="cc-digital-human-card-main" aria-haspopup="dialog" aria-label={t('预览数字人形象：{name}', { name: item.name })} onClick={() => setVisualPreview({ kind: 'avatar', id: item.id, name: item.name, subtitle: isReady(item) ? t('已就绪，可用于课程') : waitingForConsent ? t('等待本人授权：{status}', { status: item.consent_status || 'pending' }) : t('处理中：{status}', { status: item.status || 'processing' }), imageUrl: item.preview_image_url, videoUrl: item.preview_video_url, ready: isReady(item) })}>
                {item.preview_image_url ? <img src={item.preview_image_url} alt={item.name} /> : <span className="cc-digital-human-placeholder"><Icon name="users" size={22} /></span>}
                <span className="cc-digital-human-card-copy"><strong>{item.name}</strong><small>{isReady(item) ? t('已就绪，可用于课程') : waitingForConsent ? t('等待本人授权：{status}', { status: item.consent_status || 'pending' }) : t('处理中：{status}', { status: item.status || 'processing' })}</small></span>
                {selectedAvatar && <span className="cc-avatar-selected-label"><Icon name="check" size={11} />{t('已选择')}</span>}
              </button>
              <div className="cc-digital-human-card-actions">
                {waitingForConsent && <button type="button" title={t('去完成本人授权')} disabled={!!consentBusyId} onClick={() => { void startAvatarConsent(item); }}><Icon name={consentBusyId === item.id ? 'clock' : 'video'} size={13} /></button>}
                <button type="button" title={t('刷新状态')} disabled={!!busy} onClick={() => { void refreshAvatar(item.id); }}><Icon name="refresh" size={13} /></button>
                <button type="button" title={t('删除')} disabled={!!busy} onClick={() => { void removeAvatar(item); }}><Icon name="trash" size={13} /></button>
              </div>{item.failure_message && <small className="cc-digital-human-error">{item.failure_message}</small>}
            </article>;
          })}</div> : <div className="cc-avatar-library-empty"><span><Icon name="users" size={20} /></span><div><strong>{t('还没有数字人形象')}</strong><small>{t('在上方上传本人照片或视频并完成授权后创建')}</small></div></div>}
        </section>
        <section className="cc-look-library" aria-labelledby="cc-look-library-title">
          <div className="cc-avatar-library-heading"><div><span id="cc-look-library-title">{t('我的造型库')}</span><small>{t('为选中的数字人保存并切换服装与场景造型')}</small></div><span>{selectedDigitalHuman ? t('{count} 个造型', { count: String(avatarLooks.filter((look) => look.id !== selectedDigitalHuman.provider_look_id).length + 1) }) : t('未选择形象')}</span></div>
          {selectedDigitalHuman ? <>
            <div className="cc-look-library-grid">
              <button type="button" className={`cc-look-card${!selectedLookId || selectedLookId === selectedDigitalHuman.provider_look_id ? ' selected' : ''}`} aria-haspopup="dialog" aria-label={t('预览数字人造型：{name}', { name: t('默认造型') })} onClick={() => setVisualPreview({ kind: 'look', id: selectedDigitalHuman.provider_look_id, name: t('默认造型'), subtitle: t('数字人基础形象'), imageUrl: selectedDigitalHuman.preview_image_url, videoUrl: selectedDigitalHuman.preview_video_url, ready: true })}>
                <span className="cc-look-card-preview">{selectedDigitalHuman.preview_image_url ? <img src={selectedDigitalHuman.preview_image_url} alt={t('默认造型')} /> : <Icon name="users" size={22} />}</span>
                <span className="cc-look-card-meta"><strong>{t('默认造型')}</strong><small>{t('数字人基础形象')}</small></span>
                {(!selectedLookId || selectedLookId === selectedDigitalHuman.provider_look_id) && <span className="cc-look-card-selected"><Icon name="check" size={11} />{t('已选择')}</span>}
              </button>
              {avatarLooks.filter((look) => look.id !== selectedDigitalHuman.provider_look_id).map((look) => {
                const ready = isAvatarStatusReady(look.status);
                const selectedAvatarLook = selectedLookId === look.id;
                const displayName = look.name || t('造型 {id}', { id: look.id.slice(0, 8) });
                return <button key={look.id} type="button" className={`cc-look-card${selectedAvatarLook ? ' selected' : ''}`} aria-haspopup="dialog" aria-label={t('预览数字人造型：{name}', { name: displayName })} onClick={() => setVisualPreview({ kind: 'look', id: look.id, name: displayName, subtitle: ready ? t('可用于智能制课') : t('处理中：{status}', { status: statusLabel(look.status) }), imageUrl: look.preview_image_url, videoUrl: look.preview_video_url, ready })}>
                  <span className="cc-look-card-preview">{look.preview_image_url ? <img src={look.preview_image_url} alt={look.name || t('数字人造型')} /> : <Icon name={ready ? 'palette' : 'clock'} size={22} />}</span>
                  <span className="cc-look-card-meta"><strong>{displayName}</strong><small>{ready ? t('可用于智能制课') : t('处理中：{status}', { status: statusLabel(look.status) })}</small></span>
                  {selectedAvatarLook && <span className="cc-look-card-selected"><Icon name="check" size={11} />{t('已选择')}</span>}
                </button>;
              })}
            </div>
            <details className="cc-look-create">
              <summary><span><Icon name="sparkles" size={13} />{t('创建新造型')}</span><Icon name="chevronDown" size={13} /></summary>
              <div className="cc-look-create-fields"><input value={lookName} maxLength={120} placeholder={t('新造型名称')} onChange={(event) => setLookName(event.target.value)} /><textarea value={lookPrompt} maxLength={1000} placeholder={t('例如：穿深蓝色西装，在明亮现代教室，柔和自然光，正面半身。')} onChange={(event) => setLookPrompt(event.target.value)} /><button type="button" className="cc-courseware-secondary" disabled={!lookName.trim() || !lookPrompt.trim() || !!busy} onClick={() => { void createAvatarLook(); }}><Icon name="sparkles" size={13} />{busy === 'avatar' ? t('正在生成…') : t('生成新造型')}</button></div>
            </details>
          </> : <div className="cc-avatar-library-empty"><span><Icon name="palette" size={20} /></span><div><strong>{t('请先选择数字人形象')}</strong><small>{t('选择形象后即可查看和创建专属造型')}</small></div></div>}
        </section>
      </section>}

      {activeModule === 'voices' && <section className="cc-digital-human-module-body">
        <section className="cc-voice-picker" aria-labelledby="cc-voice-picker-title">
          <div className="cc-voice-picker-heading"><div><span id="cc-voice-picker-title">{t('可用声音')}</span><small>{t('选中的声音会用于课程视频')}</small></div><span className="cc-voice-picker-count">{t('{count} 个音色', { count: String(voices.length) })}</span></div>
          <details className="cc-digital-human-field"><summary>{t('克隆我的声音')}</summary>
            <input value={voiceCloneName} maxLength={120} placeholder={t('给私有音色起个名字')} onChange={(event) => setVoiceCloneName(event.target.value)} />
            <select value={voiceCloneAssetId} onChange={(event) => setVoiceCloneAssetId(event.target.value)}><option value="">{t('选择一段本人录音')}</option>{voiceAudios.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select>
            <button type="button" className="cc-courseware-secondary" onClick={() => voiceInputRef.current?.click()}><Icon name="upload" size={14} />{t('上传录音')}</button>
            <input ref={voiceInputRef} type="file" hidden accept="audio/mpeg,audio/wav,audio/mp4,audio/webm,.mp3,.wav,.m4a,.webm" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importVoiceAudio(file); event.target.value = ''; }} />
            <label className="cc-digital-human-consent"><input type="checkbox" checked={voiceCloneConsent} onChange={(event) => setVoiceCloneConsent(event.target.checked)} /><span>{t('我确认这是本人声音或已取得声音权利人的明确授权。')}</span></label>
            <button type="button" className="cc-digital-human-submit" disabled={!voiceCloneName.trim() || !voiceCloneAssetId || !voiceCloneConsent || !!busy} onClick={() => { void cloneVoice(); }}><Icon name={busy === 'voice' ? 'clock' : 'mic'} size={14} />{busy === 'voice' ? t('正在提交克隆…') : t('创建私有音色')}</button>
          </details>
          <details className="cc-digital-human-field"><summary>{t('文字生成独立配音')}</summary><input value={speechName} maxLength={120} placeholder={t('配音素材名称')} onChange={(event) => setSpeechName(event.target.value)} /><textarea value={speechText} maxLength={5000} placeholder={t('输入要朗读的文字；生成后会下载到本地素材库并自动加入时间线。')} onChange={(event) => setSpeechText(event.target.value)} /><button type="button" className="cc-digital-human-submit" disabled={!selectedVoice || !isVoiceReady(selectedVoice) || !speechText.trim() || !!busy} onClick={() => { void generateSpeech(); }}><Icon name={busy === 'speech' ? 'clock' : 'volume'} size={14} />{busy === 'speech' ? t('正在生成配音…') : t('生成配音并加入时间线')}</button></details>
          {selectedVoice ? <div className="cc-voice-selected"><div className="cc-voice-mark"><Icon name="mic" size={17} /></div><div className="cc-voice-selected-copy"><small>{t('当前配音')}</small><strong>{selectedVoice.name}</strong><span>{selectedVoice.gender === 'female' ? t('女声') : selectedVoice.gender === 'male' ? t('男声') : t('未标注')}{' · '}{selectedVoice.language || t('中文')}</span></div><button type="button" className={`cc-voice-preview${previewingVoiceId === selectedVoice.voice_id ? ' playing' : ''}`} disabled={!selectedVoice.preview_audio_url} onClick={() => { void toggleVoicePreview(selectedVoice); }}><Icon name={previewLoadingVoiceId === selectedVoice.voice_id ? 'clock' : previewingVoiceId === selectedVoice.voice_id ? 'pause' : 'play'} size={13} /><span>{previewLoadingVoiceId === selectedVoice.voice_id ? t('加载中') : previewingVoiceId === selectedVoice.voice_id ? t('暂停') : t('试听')}</span></button></div> : <div className="cc-voice-picker-empty">{t('从下方选择一个课程音色')}</div>}
          <div className="cc-voice-filters"><label><Icon name="search" size={13} /><input value={voiceQuery} onChange={(event) => setVoiceQuery(event.target.value)} placeholder={t('搜索音色名称')} /></label><div className="cc-voice-gender-filter">{(['all', 'female', 'male'] as VoiceGenderFilter[]).map((gender) => <button key={gender} type="button" className={voiceGender === gender ? 'selected' : ''} onClick={() => setVoiceGender(gender)}>{gender === 'all' ? t('全部') : gender === 'female' ? t('女声') : t('男声')}</button>)}</div></div>
          <ul className="cc-voice-list">{filteredVoices.map((voice) => { const ready = isVoiceReady(voice); const selectedCard = voice.voice_id === selectedVoiceId; const playing = previewingVoiceId === voice.voice_id; return <li key={voice.voice_id} className={`cc-voice-card${selectedCard ? ' selected' : ''}`}><button type="button" className="cc-voice-card-main" disabled={!ready} onClick={() => selectVoice(voice.voice_id)}><span className="cc-voice-card-icon"><Icon name="volume" size={14} /></span><span className="cc-voice-card-copy"><strong>{voice.name}</strong><small>{voice.type === 'private' ? t('私有音色') : voice.gender === 'female' ? t('女声') : voice.gender === 'male' ? t('男声') : t('未标注')}{' · '}{ready ? (voice.language || t('中文')) : t('处理中')}</small></span>{selectedCard && <Icon name="check" size={13} />}</button><button type="button" className={`cc-voice-card-preview${playing ? ' playing' : ''}`} disabled={!voice.preview_audio_url} onClick={() => { void toggleVoicePreview(voice); }}><Icon name={previewLoadingVoiceId === voice.voice_id ? 'clock' : playing ? 'pause' : 'play'} size={12} /></button>{voice.type === 'private' && voice.id && <button type="button" className="cc-voice-card-preview" disabled={!!busy} onClick={() => { void removeVoice(voice); }}><Icon name="trash" size={12} /></button>}</li>; })}{filteredVoices.length === 0 && <li className="cc-voice-picker-empty">{t('没有找到符合条件的音色')}</li>}</ul>
          {voicePreviewError && <small className="cc-digital-human-error">{voicePreviewError}</small>}
        </section>
      </section>}

      {activeModule === 'media' && <section className="cc-digital-human-module-body">
        <div className="cc-digital-human-field"><select value={mediaKind} onChange={(event) => setMediaKind(event.target.value as 'translation' | 'lipsync')}><option value="translation">{t('精准视频翻译')}</option><option value="lipsync">{t('精准口型同步')}</option></select><input value={mediaTitle} maxLength={160} placeholder={t('任务名称')} onChange={(event) => setMediaTitle(event.target.value)} /><select value={mediaVideoAssetId} onChange={(event) => setMediaVideoAssetId(event.target.value)}><option value="">{t('选择本地视频素材')}</option>{avatarVideos.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select>{mediaKind === 'translation' ? <select value={mediaLanguage} onChange={(event) => setMediaLanguage(event.target.value)}><option value="Chinese">{t('中文')}</option><option value="English">English</option><option value="Japanese">日本語</option><option value="Korean">한국어</option><option value="Spanish">Español</option><option value="French">Français</option></select> : <select value={mediaAudioAssetId} onChange={(event) => setMediaAudioAssetId(event.target.value)}><option value="">{t('选择本地配音素材')}</option>{voiceAudios.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select>}<button type="button" className="cc-digital-human-submit" disabled={!mediaTitle.trim() || !mediaVideoAssetId || (mediaKind === 'lipsync' && !mediaAudioAssetId) || !!busy} onClick={() => { void startMediaJob(); }}><Icon name={busy === 'media' ? 'clock' : 'sparkles'} size={14} />{busy === 'media' ? t('正在提交…') : mediaKind === 'translation' ? t('开始精准翻译') : t('开始口型同步')}</button></div>
      </section>}

      {activeModule === 'tasks' && <section className="cc-digital-human-module-body">
        <button type="button" className="cc-courseware-secondary" disabled={busy === 'refresh'} onClick={() => { void reloadJobs(); }}><Icon name="refresh" size={14} />{t('刷新全部任务')}</button>
        <div className="cc-task-section"><div className="cc-task-section-title"><span>{t('数字人课程视频')}</span><small>{videoJobs.length}</small></div>{videoJobs.length ? videoJobs.map((job) => <article key={job.id} className="cc-generation-task-card"><div className="cc-generation-task-main"><span className={`cc-generation-task-status ${job.status.toLowerCase()}`}><Icon name={job.status === 'completed' ? 'check' : job.status === 'failed' ? 'info' : 'clock'} size={13} /></span><div><strong>{job.title}</strong><small>{statusLabel(job.status)} · {job.segments.filter((segment) => segment.status === 'completed').length}/{job.segments.length} {t('个片段')}</small></div><time>{new Date(job.created_at).toLocaleDateString()}</time></div>{job.segments.some((segment) => segment.failure_message) && <small className="cc-digital-human-error">{job.segments.find((segment) => segment.failure_message)?.failure_message}</small>}<div className="cc-generation-task-actions"><button type="button" onClick={() => { void refreshVideoTask(job); }} disabled={!!busy}><Icon name="refresh" size={12} />{t('刷新')}</button>{job.status === 'failed' && <button type="button" onClick={() => { void retryVideo(job); }} disabled={!!busy}><Icon name="refresh" size={12} />{t('重试')}</button>}{job.status === 'completed' && <button type="button" onClick={() => { void importVideoTask(job); }} disabled={!!busy || importedVideoIds.current.has(job.id)}><Icon name="download" size={12} />{importedVideoIds.current.has(job.id) ? t('已导入') : t('导入本地')}</button>}</div></article>) : <div className="cc-task-empty">{t('还没有课程视频任务')}</div>}</div>
        <div className="cc-task-section"><div className="cc-task-section-title"><span>{t('翻译与口型任务')}</span><small>{mediaJobs.length}</small></div>{mediaJobs.length ? mediaJobs.map((job) => <article key={job.id} className="cc-generation-task-card"><div className="cc-generation-task-main"><span className={`cc-generation-task-status ${job.status.toLowerCase()}`}><Icon name={job.status.toLowerCase() === 'completed' ? 'check' : job.status.toLowerCase() === 'failed' ? 'info' : 'clock'} size={13} /></span><div><strong>{job.title}</strong><small>{job.kind === 'translation' ? t('视频翻译') : t('口型同步')} · {statusLabel(job.status)}</small></div><time>{new Date(job.created_at).toLocaleDateString()}</time></div>{job.failure_message && <small className="cc-digital-human-error">{job.failure_message}</small>}<div className="cc-generation-task-actions"><button type="button" onClick={() => { void refreshMediaTask(job); }} disabled={!!busy}><Icon name="refresh" size={12} />{t('刷新')}</button>{job.status.toLowerCase() === 'completed' && <button type="button" onClick={() => { void importMediaTask(job); }} disabled={!!busy || importedMediaJobIds.current.has(job.id)}><Icon name="download" size={12} />{importedMediaJobIds.current.has(job.id) ? t('已导入') : t('导入本地')}</button>}</div></article>) : <div className="cc-task-empty">{t('还没有翻译或口型任务')}</div>}</div>
      </section>}
    </>}
    {error && <div className="cc-digital-human-error" role="alert">{t(error)}</div>}
    {visualPreview && <VisualPreviewDialog
      target={visualPreview}
      selected={visualPreview.kind === 'avatar'
        ? selectedDigitalHumanId === visualPreview.id
        : selectedLookId ? selectedLookId === visualPreview.id : selectedDigitalHuman?.provider_look_id === visualPreview.id}
      onClose={() => setVisualPreview(null)}
      onSelect={() => {
        if (visualPreview.kind === 'avatar') setSelectedDigitalHumanId(visualPreview.id);
        else setSelectedLookId(visualPreview.id);
        setVisualPreview(null);
      }}
    />}
  </div>;
}
