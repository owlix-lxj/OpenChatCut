import assert from 'node:assert/strict';
import {
  assertTranscriptionProviderConfigured,
  transcribeCloudAudio,
} from './transcription-providers.ts';
import type { TranscriptionOptions } from './transcription-types.ts';

const options: TranscriptionOptions = {
  openaiBaseUrl: 'https://api.openai.test',
  openaiApiKey: 'openai-test-key',
  openaiModel: 'gpt-4o-mini-transcribe',
  mistralBaseUrl: 'https://api.mistral.test/v1',
  mistralApiKey: 'mistral-test-key',
  mistralModel: 'voxtral-mini-latest',
  deepgramApiKey: 'deepgram-test-key',
  deepgramModel: 'nova-3',
  groqBaseUrl: 'https://api.groq.test/openai/v1',
  groqApiKey: 'groq-test-key',
  groqModel: 'whisper-large-v3-turbo',
  elevenApiKey: 'elevenlabs-test-key',
  elevenModel: 'scribe_v2',
  cartesiaApiKey: 'cartesia-test-key',
  cartesiaModel: 'ink-whisper',
  qwenBaseUrl: 'https://dashscope.test',
  qwenApiKey: 'qwen-test-key',
  qwenModel: 'qwen-audio-3.0-asr-flash',
  language: 'zh',
  diarization: true,
};

const originalFetch = globalThis.fetch;
try {
  let requestSeen = false;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    assert.equal(url, 'https://api.mistral.test/v1/audio/transcriptions');
    const body = init?.body;
    assert.ok(body instanceof FormData, 'Mistral transcription must use multipart audio upload');
    assert.equal(body.get('model'), 'voxtral-mini-latest');
    assert.equal(body.get('language'), 'en');
    requestSeen = true;
    return Response.json({
      text: 'hello world',
      language: 'en',
      duration: 0.5,
      words: [
        { word: 'hello', start: 0, end: 0.24 },
        { word: 'world', start: 0.25, end: 0.5 },
      ],
    });
  };

  const result = await transcribeCloudAudio(options, {
    provider: 'mistral',
    audio: new TextEncoder().encode('audio-bytes'),
    language: 'en',
    diarize: false,
  });
  assert.equal(requestSeen, true);
  assert.deepEqual(result.words, [
    { text: 'hello', start: 0, end: 240, speaker: null },
    { text: 'world', start: 250, end: 500, speaker: null },
  ]);
  assert.deepEqual(result.utterances, []);

  assert.throws(
    () => assertTranscriptionProviderConfigured({ ...options, mistralApiKey: '' }, 'mistral'),
    /Mistral API key is not configured/,
  );

  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    assert.equal(url, 'https://dashscope.test/api/v1/services/aigc/multimodal-generation/generation');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(init?.body as string) as Record<string, any>;
    assert.equal(body.model, 'qwen-audio-3.0-asr-flash');
    assert.equal(body.parameters.format, 'wav');
    assert.deepEqual(body.parameters.language_hints, ['zh']);
    assert.match(body.input.messages[0].content[0].input_audio.data, /^data:audio\/wav;base64,/);
    return Response.json({ output: {
      text: '你好世界。',
      sentence: {
        begin_time: 100, end_time: 900, text: '你好世界。',
        words: [
          { text: '你好', begin_time: 100, end_time: 450, punctuation: '' },
          { text: '世界', begin_time: 500, end_time: 900, punctuation: '。'},
        ],
      },
    } });
  };
  const qwen = await transcribeCloudAudio(options, {
    provider: 'qwen', audio: new TextEncoder().encode('RIFF-audio'), language: 'zh', diarize: true,
  });
  assert.equal(qwen.text, '你好世界。');
  assert.deepEqual(qwen.words, [
    { text: '你好', start: 100, end: 450, speaker: null },
    { text: '世界。', start: 500, end: 900, speaker: null },
  ]);
  assert.equal(qwen.utterances[0]?.speaker, 'A');
  assert.throws(
    () => assertTranscriptionProviderConfigured({ ...options, cartesiaModel: 'ink-2' }, 'cartesia'),
    /streaming-only/,
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log('transcription.verify: ok (Mistral AI SDK compatibility route + provider guards)');
