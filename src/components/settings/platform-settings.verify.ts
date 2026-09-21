import assert from 'node:assert/strict';

import { assertPlatformManagedSettingsPatch } from '../../../server/plugins/settings.ts';
import {
  SETTINGS_CATEGORIES,
  isPlatformManagedPage,
  platformizeSettingsCategories,
  platformizeSettingsGroup,
} from './settingsSchema.ts';

const platformCategories = platformizeSettingsCategories();
const platformGroupKeys = platformCategories.flatMap((category) => category.groups.map((group) => group.key));
assert.ok(!platformGroupKeys.includes('llm'), 'platform settings hide the Agent brain menu');
assert.ok(!platformGroupKeys.includes('image'), 'platform settings hide the image-generation menu');
assert.ok(!platformCategories.some((category) => category.key === 'agent'),
  'empty Agent category is removed with its only menu');

const group = (key: string) => {
  const found = SETTINGS_CATEGORIES.flatMap((category) => category.groups)
    .find((candidate) => candidate.key === key);
  assert.ok(found, `missing settings group: ${key}`);
  return platformizeSettingsGroup(found);
};

const vendorKeys = (key: string) => group(key).vendors.map((vendor) => vendor.key);
const routeValues = (key: string) => group(key).route?.options?.map((option) => option.value) ?? [];

assert.deepEqual(vendorKeys('llm'), ['llm/openai', 'llm/deepseek']);
assert.deepEqual(vendorKeys('image'), ['image/openai']);
assert.ok(!vendorKeys('image').some((key) => key.includes('qwen')));

assert.deepEqual(vendorKeys('voice'), ['voice/doubao', 'voice/minimax']);
assert.deepEqual(routeValues('voice'), ['', 'doubao', 'minimax']);
assert.equal(isPlatformManagedPage('voice/doubao'), false);
assert.equal(isPlatformManagedPage('voice/minimax'), false);

assert.deepEqual(vendorKeys('transcription'), [
  'transcription/assemblyai',
  'transcription/local',
  'transcription/openai',
  'transcription/mistral',
  'transcription/deepgram',
  'transcription/groq',
  'transcription/elevenlabs',
  'transcription/cartesia',
]);
assert.ok(!routeValues('transcription').includes('qwen'));
assert.ok(group('transcription').vendors.every((vendor) => !isPlatformManagedPage(vendor.key)));
assert.ok(group('transcription').vendors.every((vendor) =>
  vendor.fields.some((field) => field.name === 'TRANSCRIPTION_LANGUAGE')
  && vendor.fields.some((field) => field.name === 'AUTO_TRANSCRIBE_INGEST')));

assert.deepEqual(vendorKeys('video'), [
  'video/seedance',
  'video/kling',
  'video/hailuo',
  'video/byteplus',
  'video/xai',
  'video/ofox',
  'video/jimeng-avatar',
]);
assert.deepEqual(routeValues('video'), [
  '',
  'seedance2',
  'kling',
  'hailuo',
  'byteplus',
  'grok-imagine-video',
  'ofox',
  'jimeng-avatar',
]);
assert.ok(group('video').vendors.every((vendor) => !isPlatformManagedPage(vendor.key)));

assert.doesNotThrow(() => assertPlatformManagedSettingsPatch({
  DOUBAO_TTS_APP_ID: 'app',
  DOUBAO_TTS_ACCESS_KEY: 'key',
  MINIMAX_API_KEY: 'key',
  PREFERRED_VOICE_VENDOR: 'doubao',
  ASSEMBLYAI_API_KEY: 'key',
  TRANSCRIPTION_LANGUAGE: 'zh',
  PREFERRED_TRANSCRIPTION_PROVIDER: 'assemblyai',
  SEEDANCE_API_KEY: 'key',
  SEEDANCE_VIDEO_MODEL: 'model',
  KLING_API_KEY: 'key',
  PREFERRED_VIDEO_VENDOR: 'kling',
}, true));
assert.throws(
  () => assertPlatformManagedSettingsPatch({ LLM_OPENAI_API_KEY: 'not-allowed' }, true),
  /由平台统一配置/,
);
assert.throws(
  () => assertPlatformManagedSettingsPatch({ PREFERRED_IMAGE_VENDOR: 'other' }, true),
  /由平台统一配置/,
);

console.log('platform settings verification passed');
