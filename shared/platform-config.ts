/**
 * Deployment policy for hosted/platform installations.
 *
 * Provider credentials stay in the server environment. This module only carries
 * the non-secret allow-list and presentation defaults shared by the browser and
 * the server.
 */
export const PLATFORM_MODE_ENV = 'OPENCHATCUT_PLATFORM_MODE';

export const PLATFORM_LLM_PROVIDERS = ['openai', 'deepseek'] as const;
export type PlatformLlmProvider = (typeof PLATFORM_LLM_PROVIDERS)[number];

export const PLATFORM_IMAGE_VENDOR = 'gpt-image-2' as const;
// Hosted deployments keep voice credentials server-side, but support the same
// cloud Qwen-Audio route as the local settings surface.
export const PLATFORM_VOICE_PROVIDERS = ['doubao', 'minimax', 'qwen'] as const;
export const PLATFORM_DEFAULT_VOICE_VENDOR = 'doubao' as const;
export const PLATFORM_VIDEO_VENDOR = 'seedance2' as const;

export const PLATFORM_DEFAULT_ROUTES = {
  image: PLATFORM_IMAGE_VENDOR,
  voice: PLATFORM_DEFAULT_VOICE_VENDOR,
  video: PLATFORM_VIDEO_VENDOR,
} as const;

export const PLATFORM_DEFAULT_LLM_CONFIG = {
  openai: {
    label: 'OpenAI · 喵喵 API',
    baseUrl: 'https://miaoapi.xyz/v1',
    model: 'gpt-5.6-terra',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
} as const satisfies Record<PlatformLlmProvider, {
  readonly label: string;
  readonly baseUrl: string;
  readonly model: string;
}>;

export function isPlatformManagedValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'platform', 'managed'].includes(value.trim().toLowerCase());
}

export function isPlatformLlmProvider(value: unknown): value is PlatformLlmProvider {
  return (PLATFORM_LLM_PROVIDERS as readonly string[]).includes(value as string);
}
