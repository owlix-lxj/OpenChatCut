import { getKey } from '../keystore.ts';
import { DEFAULT_PLATFORM_API_BASE_URL } from '../../shared/platform-config.ts';
import { activePlatformSessionToken, platformManaged } from '../platform-session.ts';
import type { TranscriptionOptions } from './transcription-types.ts';
import type { AiVoiceOptions } from './voice-types.ts';

export function versionedApiBaseUrl(baseUrl: string, version: string): string {
  const clean = baseUrl.replace(/\/+$/, '');
  return /\/v\d+(?:beta)?$/i.test(clean) ? clean : `${clean}/${version}`;
}

/** Build a DashScope service URL from either a root URL, a /v1 URL, or the
 * OpenAI-compatible Qwen URL saved by the Agent settings page. */
export function dashScopeServiceUrl(baseUrl: string, servicePath: string): string {
  const raw = (baseUrl || 'https://dashscope.aliyuncs.com').trim().replace(/\/+$/, '');
  const path = servicePath.startsWith('/') ? servicePath : `/${servicePath}`;
  // Platform mode points at the authenticated API Gateway prefix instead of
  // DashScope's public root. Preserve that prefix verbatim.
  if (/\/qwen-audio$/i.test(raw)) return `${raw}${path}`;
  let root = raw;
  try {
    const parsed = new URL(raw);
    root = `${parsed.protocol}//${parsed.host}`;
    if (/\/api\/v\d+(?:beta)?$/i.test(parsed.pathname)) {
      root = `${parsed.origin}${parsed.pathname}`;
    }
  } catch {
    root = raw
      .replace(/\/compatible-mode\/v\d+(?:beta)?$/i, '')
      .replace(/\/api\/v\d+(?:beta)?$/i, '')
      .replace(/\/v\d+(?:beta)?$/i, '')
      .replace(/\/+$/, '');
  }
  if (/\/api\/v\d+(?:beta)?$/i.test(root)) return `${root}${path}`;
  return `${root}/api/v1${path}`;
}

export function aiVoiceOptions(): AiVoiceOptions {
  return {
    get openaiBaseUrl() { return getKey('IMAGE_BASE_URL') || 'https://api.openai.com'; },
    get openaiApiKey() { return getKey('OPENAI_API_KEY'); },
    get openaiModel() { return getKey('OPENAI_TTS_MODEL') || 'gpt-4o-mini-tts'; },
    get geminiBaseUrl() { return getKey('GEMINI_BASE_URL') || 'https://generativelanguage.googleapis.com'; },
    get geminiApiKey() { return getKey('GEMINI_API_KEY'); },
    get geminiModel() { return getKey('GEMINI_TTS_MODEL') || 'gemini-2.5-flash-preview-tts'; },
    get mistralBaseUrl() { return getKey('LLM_MISTRAL_BASE_URL') || 'https://api.mistral.ai/v1'; },
    get mistralApiKey() { return getKey('LLM_MISTRAL_API_KEY'); },
    get mistralModel() { return getKey('MISTRAL_TTS_MODEL') || 'voxtral-mini-tts-2603'; },
    get cartesiaApiKey() { return getKey('CARTESIA_API_KEY'); },
    get cartesiaModel() { return getKey('CARTESIA_TTS_MODEL') || 'sonic-3'; },
  };
}

export function transcriptionOptions(): TranscriptionOptions {
  return {
    get openaiBaseUrl() { return getKey('IMAGE_BASE_URL') || 'https://api.openai.com'; },
    get openaiApiKey() { return getKey('OPENAI_API_KEY'); },
    get openaiModel() { return getKey('OPENAI_TRANSCRIPTION_MODEL') || 'gpt-4o-mini-transcribe'; },
    get mistralBaseUrl() { return getKey('LLM_MISTRAL_BASE_URL') || 'https://api.mistral.ai/v1'; },
    get mistralApiKey() { return getKey('LLM_MISTRAL_API_KEY'); },
    get mistralModel() { return getKey('MISTRAL_TRANSCRIPTION_MODEL') || 'voxtral-mini-latest'; },
    get deepgramApiKey() { return getKey('DEEPGRAM_API_KEY'); },
    get deepgramModel() { return getKey('DEEPGRAM_TRANSCRIPTION_MODEL') || 'nova-3'; },
    get groqBaseUrl() { return getKey('GROQ_BASE_URL') || 'https://api.groq.com/openai/v1'; },
    get groqApiKey() { return getKey('GROQ_API_KEY'); },
    get groqModel() { return getKey('GROQ_TRANSCRIPTION_MODEL') || 'whisper-large-v3-turbo'; },
    get elevenApiKey() { return getKey('ELEVENLABS_API_KEY'); },
    get elevenModel() { return getKey('ELEVENLABS_TRANSCRIPTION_MODEL') || 'scribe_v2'; },
    get cartesiaApiKey() { return getKey('CARTESIA_API_KEY'); },
    get cartesiaModel() { return getKey('CARTESIA_TRANSCRIPTION_MODEL') || 'ink-whisper'; },
    get qwenBaseUrl() {
      if (platformManaged()) {
        const base = (process.env.OPENCHATCUT_PLATFORM_API_BASE_URL || DEFAULT_PLATFORM_API_BASE_URL)
          .trim().replace(/\/+$/, '');
        return `${base}/v1/video-editor/qwen-audio`;
      }
      return getKey('QWEN_AUDIO_BASE_URL') || getKey('LLM_QWEN_BASE_URL') || 'https://dashscope.aliyuncs.com';
    },
    get qwenApiKey() {
      return platformManaged() ? activePlatformSessionToken() : getKey('LLM_QWEN_API_KEY');
    },
    get qwenModel() { return getKey('QWEN_ASR_MODEL') || 'qwen-audio-3.0-asr-flash'; },
    get language() { return getKey('TRANSCRIPTION_LANGUAGE') || 'zh'; },
    get diarization() { return getKey('TRANSCRIPTION_DIARIZATION') !== '0'; },
  };
}
