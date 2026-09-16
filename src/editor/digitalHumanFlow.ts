import { submitVoice, type VoiceProvider } from '../generate/voice';
import { submitVideo } from '../generate/video';
import { patchTrackedJob, registerTrackedJob, resumeOpenGenerationJobs } from '../persist/jobRegistryStore';
import type { MediaAsset, TimelineState } from './types';

export interface DigitalHumanInput {
  script: string;
  provider: VoiceProvider;
  voiceId: string;
  imageId: string;
  likenessConsent: boolean;
}

export function avatarAudioWithinLimit(audio: MediaAsset, fps: number): boolean {
  return audio.kind === 'audio' && audio.durationInFrames > 0 && audio.durationInFrames <= fps * 15;
}

export async function createDigitalHuman(
  input: DigitalHumanInput,
  context: {
    projectId: string;
    getState: () => TimelineState;
    addAsset: (asset: MediaAsset) => void;
    onStage: (stage: 'voice' | 'avatar') => void;
  },
): Promise<string> {
  const script = input.script.trim();
  if (!script || !input.voiceId.trim()) throw new Error('请填写脚本并选择配音音色');
  if (!input.likenessConsent) throw new Error('请先确认形象使用授权');
  const image = context.getState().assets?.find((asset) => asset.id === input.imageId && asset.kind === 'image');
  if (!image || !/^\/media\/uploads\/[^?#]+\.(?:jpe?g|png)(?:[?#]|$)/i.test(image.src)) {
    throw new Error('请选择当前工程中的 JPG / PNG 单人形象图片');
  }

  context.onStage('voice');
  const voice = await submitVoice({
    provider: input.provider, voiceId: input.voiceId.trim(), text: script,
    name: `数字人配音 · ${image.name}`,
  }, context.getState());
  context.addAsset(voice);
  if (!avatarAudioWithinLimit(voice, context.getState().fps)) {
    throw new Error('配音已保存到媒体池，但超过数字人单段 15 秒限制。请缩短脚本后重试。');
  }

  context.onStage('avatar');
  const operationId = crypto.randomUUID();
  const args = {
    operationId, model: 'jimeng-avatar' as const, name: `数字人 · ${image.name}`,
    firstFrame: image.id, refAudios: [voice.id], likenessConsent: true,
  };
  const submittedAt = Date.now();
  await registerTrackedJob({
    operationId, jobId: operationId, projectId: context.projectId,
    kind: 'generation', label: args.name, status: 'submitting', toolName: 'submit_video',
    submitArgs: args, provider: 'jimeng-avatar', model: 'jimeng-avatar',
    timestamps: { submittedAt },
  });
  let submission;
  try {
    submission = await submitVideo(args, {
      ...context.getState(),
      assets: [...(context.getState().assets ?? []).filter((asset) => asset.id !== voice.id), voice],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = /\b(?:408|409|425|429|5\d\d)\b|network|fetch|timeout|temporar|unavailable/i.test(message);
    await patchTrackedJob(context.projectId, operationId, {
      status: 'failed', error: message, retryClass: retryable ? 'provider-retryable' : 'provider-terminal',
      timestamps: { failedAt: Date.now() },
    });
    throw error;
  }
  await registerTrackedJob({
    operationId: submission.operationId, jobId: submission.jobId, projectId: context.projectId,
    kind: 'generation', label: args.name, status: submission.status, toolName: 'submit_video',
    submitArgs: args, provider: submission.provider, model: 'jimeng-avatar',
    providerTaskId: submission.providerTaskId, sourceRevisions: submission.sourceRevisions,
    timestamps: { submittedAt, acceptedAt: submission.acceptedAt ?? Date.now() },
  });
  void resumeOpenGenerationJobs(context.projectId, {
    getState: context.getState,
    onAsset: context.addAsset,
    timeoutSeconds: 180,
  }).catch((error) => console.warn('[digital-human] background tracking failed', error));
  return submission.jobId;
}
