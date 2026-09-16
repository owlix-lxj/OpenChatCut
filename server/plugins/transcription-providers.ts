import { transcribe, type TranscriptionResult } from 'ai';
import { createCartesia } from '@ai-sdk/cartesia';
import { createDeepgram } from '@ai-sdk/deepgram';
import { createElevenLabs } from '@ai-sdk/elevenlabs';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { proxyDispatcher } from '../outbound-proxy.ts';

import { dashScopeServiceUrl, versionedApiBaseUrl } from './media-provider-config.ts';

import type {
  CloudTranscriptionProvider,
  CloudTranscriptionRequest,
  NormalizedTranscriptResult,
  NormalizedTranscriptUtterance,
  NormalizedTranscriptWord,
  TranscriptionOptions,
} from './transcription-types.ts';

export class TranscriptionConfigurationError extends Error {}

type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: unknown };
const fetchWithProxy = (url: RequestInfo | URL, init?: FetchInit): Promise<Response> =>
  fetch(url, { ...init, dispatcher: proxyDispatcher() } as RequestInit);

function requireProviderKey(options: TranscriptionOptions, provider: CloudTranscriptionProvider): string {
  if (provider === 'cartesia' && /^ink-2(?:-|$)/i.test(options.cartesiaModel)) {
    throw new TranscriptionConfigurationError(
      'Cartesia ink-2 is streaming-only; use ink-whisper for batch transcription',
    );
  }
  const key = provider === 'openai' ? options.openaiApiKey
    : provider === 'mistral' ? options.mistralApiKey
      : provider === 'deepgram' ? options.deepgramApiKey
        : provider === 'groq' ? options.groqApiKey
            : provider === 'elevenlabs' ? options.elevenApiKey
            : provider === 'cartesia' ? options.cartesiaApiKey
              : options.qwenApiKey;
  if (key) return key;
  const label = provider === 'elevenlabs' ? 'ElevenLabs'
    : provider === 'qwen' ? 'Alibaba Cloud Qwen'
      : provider[0]!.toUpperCase() + provider.slice(1);
  throw new TranscriptionConfigurationError(`${label} API key is not configured`);
}

export function assertTranscriptionProviderConfigured(
  options: TranscriptionOptions,
  provider: CloudTranscriptionProvider,
): void {
  requireProviderKey(options, provider);
}

async function runProvider(options: TranscriptionOptions, request: CloudTranscriptionRequest) {
  const key = requireProviderKey(options, request.provider);
  const common = { audio: request.audio, maxRetries: 1 } as const;
  if (request.provider === 'openai') return transcribe({ ...common,
    model: createOpenAI({ apiKey: key, baseURL: versionedApiBaseUrl(options.openaiBaseUrl, 'v1') }).transcription(options.openaiModel),
    providerOptions: { openai: { ...(request.language === 'auto' ? {} : { language: request.language }),
      timestampGranularities: ['word', 'segment'] } },
  });
  if (request.provider === 'mistral') return transcribe({ ...common,
    model: createOpenAI({ apiKey: key, baseURL: versionedApiBaseUrl(options.mistralBaseUrl, 'v1') })
      .transcription(options.mistralModel),
    providerOptions: { openai: { ...(request.language === 'auto' ? {} : { language: request.language }),
      timestampGranularities: ['word', 'segment'] } },
  });
  if (request.provider === 'deepgram') return transcribe({ ...common,
    model: createDeepgram({ apiKey: key }).transcription(options.deepgramModel),
    providerOptions: { deepgram: { ...(request.language === 'auto' ? { detectLanguage: true } : { language: request.language }),
      smartFormat: true, punctuate: true, diarize: request.diarize, utterances: true } },
  });
  if (request.provider === 'groq') return transcribe({ ...common,
    model: createGroq({ apiKey: key, baseURL: options.groqBaseUrl }).transcription(options.groqModel),
    providerOptions: { groq: { ...(request.language === 'auto' ? {} : { language: request.language }),
      responseFormat: 'verbose_json', timestampGranularities: ['word'] } },
  });
  if (request.provider === 'elevenlabs') return transcribe({ ...common,
    model: createElevenLabs({ apiKey: key }).transcription(options.elevenModel),
    providerOptions: { elevenlabs: { ...(request.language === 'auto' ? {} : { languageCode: request.language }),
      diarize: request.diarize, timestampsGranularity: 'word' } },
  });
  return transcribe({ ...common,
    model: createCartesia({ apiKey: key }).transcription(options.cartesiaModel),
    providerOptions: { cartesia: { ...(request.language === 'auto' ? {} : { language: request.language }),
      timestampGranularities: ['word'] } },
  });
}

function qwenAudioFormat(audio: Uint8Array): { format: 'wav' | 'mp3' | 'opus'; mime: string } {
  const bytes = Buffer.from(audio);
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'RIFF') {
    return { format: 'wav', mime: 'audio/wav' };
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'OggS') {
    return { format: 'opus', mime: 'audio/ogg' };
  }
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString('ascii') === 'ID3') {
    return { format: 'mp3', mime: 'audio/mpeg' };
  }
  // MPEG audio commonly starts with a sync word rather than an ID3 tag.
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    return { format: 'mp3', mime: 'audio/mpeg' };
  }
  return { format: 'wav', mime: 'audio/wav' };
}

export function qwenAudioTranscriptionBody(
  audio: Uint8Array,
  model: string,
  language: string,
): Record<string, unknown> {
  const detected = qwenAudioFormat(audio);
  const data = `data:${detected.mime};base64,${Buffer.from(audio).toString('base64')}`;
  return {
    model,
    input: {
      messages: [{
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data } }],
      }],
    },
    parameters: {
      format: detected.format,
      ...(language !== 'auto' ? { language_hints: [language] } : {}),
    },
  };
}

function qwenResponseError(bodyText: string, status: number): string {
  try {
    const body = JSON.parse(bodyText) as { code?: string | number; message?: string; error?: { message?: string } };
    return body.message ?? body.error?.message ?? `Alibaba Cloud Qwen request failed (${status})`;
  } catch {
    return bodyText.slice(0, 300) || `Alibaba Cloud Qwen request failed (${status})`;
  }
}

export function parseQwenAudioTranscription(value: unknown): NormalizedTranscriptResult {
  const output = record(at(value, 'output'));
  const sentence = record(output?.sentence);
  const textValue = output?.text ?? sentence?.text;
  const text = typeof textValue === 'string' ? textValue.trim() : '';
  const words: NormalizedTranscriptWord[] = [];
  for (const raw of array(sentence?.words)) {
    const item = record(raw);
    const wordText = typeof item?.text === 'string' ? item.text.trim() : '';
    const punctuation = typeof item?.punctuation === 'string' ? item.punctuation : '';
    const start = item && typeof item.begin_time === 'number' && Number.isFinite(item.begin_time)
      ? Math.max(0, Math.round(item.begin_time)) : null;
    const end = item && typeof item.end_time === 'number' && Number.isFinite(item.end_time)
      ? Math.max(0, Math.round(item.end_time)) : null;
    if (!wordText || start == null || end == null) continue;
    words.push({ text: `${wordText}${punctuation}`, start, end: Math.max(start, end), speaker: null });
  }
  if (!text && !words.length) throw new Error('Alibaba Cloud Qwen returned no transcription text');
  const resolvedText = text || joinedText(words);
  const startValue = sentence && typeof sentence.begin_time === 'number' ? Math.max(0, Math.round(sentence.begin_time)) : words[0]?.start;
  const endValue = sentence && typeof sentence.end_time === 'number' ? Math.max(0, Math.round(sentence.end_time)) : words.at(-1)?.end;
  const utterances = words.length
    ? [{ speaker: 'A', text: resolvedText, start: startValue ?? words[0]!.start, end: endValue ?? words.at(-1)!.end, words }]
    : [];
  return { text: resolvedText, words, utterances };
}

async function qwenAudioTranscribe(
  options: TranscriptionOptions,
  request: CloudTranscriptionRequest,
): Promise<NormalizedTranscriptResult> {
  const response = await fetchWithProxy(
    dashScopeServiceUrl(options.qwenBaseUrl, '/services/aigc/multimodal-generation/generation'),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.qwenApiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-SSE': 'disable',
      },
      body: JSON.stringify(qwenAudioTranscriptionBody(request.audio, options.qwenModel, request.language)),
    },
  );
  const bodyText = await response.text();
  if (!response.ok) throw new Error(qwenResponseError(bodyText, response.status));
  let body: unknown;
  try { body = JSON.parse(bodyText); } catch { throw new Error('Alibaba Cloud Qwen returned invalid JSON'); }
  return parseQwenAudioTranscription(body);
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function at(value: unknown, ...path: Array<string | number>): unknown {
  let current = value;
  for (const part of path) {
    if (typeof part === 'number') current = Array.isArray(current) ? current[part] : undefined;
    else current = record(current)?.[part];
  }
  return current;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function rawWordList(provider: CloudTranscriptionProvider, raw: unknown): unknown[] {
  if (provider === 'deepgram') return array(at(raw, 'results', 'channels', 0, 'alternatives', 0, 'words'));
  if (provider === 'elevenlabs' || provider === 'cartesia') return array(at(raw, 'words'));
  const words = array(at(raw, 'words'));
  return words.length ? words : array(at(raw, 'segments'));
}

function milliseconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value * 1000)) : null;
}

function normalizedRawWords(provider: CloudTranscriptionProvider, raw: unknown): NormalizedTranscriptWord[] {
  const words: NormalizedTranscriptWord[] = [];
  for (const value of rawWordList(provider, raw)) {
    const item = record(value);
    if (!item || (provider === 'elevenlabs' && item.type !== 'word')) continue;
    const textValue = item.punctuated_word ?? item.text ?? item.word;
    const start = milliseconds(item.start);
    const end = milliseconds(item.end);
    if (typeof textValue !== 'string' || !textValue.trim() || start == null || end == null) continue;
    const speakerValue = item.speaker_id ?? item.speaker;
    words.push({ text: textValue.trim(), start, end: Math.max(start, end),
      speaker: typeof speakerValue === 'string' || typeof speakerValue === 'number' ? String(speakerValue) : null });
  }
  return words;
}

function standardWords(result: TranscriptionResult): NormalizedTranscriptWord[] {
  return result.segments.flatMap((segment) => {
    const start = milliseconds(segment.startSecond);
    const end = milliseconds(segment.endSecond);
    return start == null || end == null || !segment.text.trim() ? [] : [{
      text: segment.text.trim(), start, end: Math.max(start, end), speaker: null,
    }];
  });
}

function joinedText(words: NormalizedTranscriptWord[]): string {
  return words.map((word) => word.text).join(' ')
    .replace(/\s+([,.;:!?，。；：！？])/gu, '$1')
    .replace(/([（(])\s+/gu, '$1');
}

function groupUtterances(words: NormalizedTranscriptWord[]): NormalizedTranscriptUtterance[] {
  const utterances: NormalizedTranscriptUtterance[] = [];
  let current: NormalizedTranscriptWord[] = [];
  const flush = () => {
    if (!current.length || current[0]!.speaker == null) return;
    utterances.push({ speaker: current[0]!.speaker!, text: joinedText(current), start: current[0]!.start,
      end: current[current.length - 1]!.end, words: current });
    current = [];
  };
  for (const word of words) {
    if (word.speaker == null) { flush(); continue; }
    if (current.length && current[0]!.speaker !== word.speaker) flush();
    current.push(word);
  }
  flush();
  return utterances;
}

export async function transcribeCloudAudio(
  options: TranscriptionOptions,
  request: CloudTranscriptionRequest,
): Promise<NormalizedTranscriptResult> {
  requireProviderKey(options, request.provider);
  if (request.provider === 'qwen') return qwenAudioTranscribe(options, request);
  const result = await runProvider(options, request);
  const raw = (result.responses[0] as unknown as { body?: unknown } | undefined)?.body;
  const providerWords = normalizedRawWords(request.provider, raw);
  const words = providerWords.length ? providerWords : standardWords(result);
  return { text: result.text, words, utterances: groupUtterances(words) };
}
