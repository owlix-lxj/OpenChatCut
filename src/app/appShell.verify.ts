import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadInitialProjects, syncAgentBackends, type ProjectStartupSource } from './appShell';
import { getActiveAgentModelChoice, getAgentModelSnapshot } from '../agent/model-selection';
import type { ProjectMeta } from '../persist/projectStoreCoordinators';
import { syncDesktopNativeInferenceEnabled } from '../transcript/desktop-inference-preference';

const demo = { id: 'demo', name: '示例工程', updatedAt: 1 };

function source(options: {
  projects?: ProjectMeta[];
  hasHistory?: boolean;
  canSeedDemo: boolean;
  onCreate?: () => void;
}): ProjectStartupSource {
  return {
    list: async () => options.projects ?? [],
    hasHistory: async () => options.hasHistory ?? false,
    canSeedDemo: () => options.canSeedDemo,
    createDemo: async () => {
      options.onCreate?.();
      return demo;
    },
  };
}

let readOnlyCreates = 0;
const readOnlyProjects = await loadInitialProjects(source({
  canSeedDemo: false,
  onCreate: () => { readOnlyCreates += 1; },
}));
assert.deepEqual(readOnlyProjects, [], 'sessionless empty remote listing resolves to an empty terminal state');
assert.equal(readOnlyCreates, 0, 'read-only startup never attempts the rejected demo write');

for (const mode of ['authorized remote', 'local/offline']) {
  let creates = 0;
  const projects = await loadInitialProjects(source({
    canSeedDemo: true,
    onCreate: () => { creates += 1; },
  }));
  assert.deepEqual(projects, [demo], `${mode} first-run still seeds the demo`);
  assert.equal(creates, 1, `${mode} first-run creates exactly one demo`);
}

let historyCreates = 0;
assert.deepEqual(
  await loadInitialProjects(source({
    hasHistory: true,
    canSeedDemo: true,
    onCreate: () => { historyCreates += 1; },
  })),
  [],
  'an intentionally emptied project history stays empty',
);
assert.equal(historyCreates, 0, 'project history still suppresses demo recreation');

const existing = [{ id: 'existing', name: 'Existing', updatedAt: 2 }];
assert.deepEqual(
  await loadInitialProjects(source({ projects: existing, canSeedDemo: false })),
  existing,
  'existing projects remain readable without write authority',
);

const appSource = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
assert.match(appSource, /useInferenceWarmup\(route\.name === 'editor'\)/, 'App wires unified inference warmup only while editing');
assert.doesNotMatch(appSource, /useLocalAsrWarmup/, 'App no longer wires the ASR-only warmup path');

const descriptors = {
  window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
};
const applied: boolean[] = [];
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: () => '1', setItem: () => undefined },
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { openChatCutDesktop: { inference: { setEnabled: async (enabled: boolean) => { applied.push(enabled); } } } },
});
try {
  assert.equal(await syncDesktopNativeInferenceEnabled(), true, 'restart reads the persisted native inference preference');
  assert.deepEqual(applied, [true], 'restart sync applies the preference to the desktop bridge');
} finally {
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
}

const originalFetch = globalThis.fetch;
const pendingCopilot = Promise.withResolvers<Response>();
const requestedPaths: string[] = [];
let copilotSaved = '';
let startupTimeout: ReturnType<typeof setTimeout> | undefined;
try {
  globalThis.fetch = async (input) => {
    const path = String(input);
    requestedPaths.push(path);
    if (path === '/api/copilot/status') return pendingCopilot.promise;
    return Response.json(path === '/api/codex/status' ? { installed: false } : {
      keys: { LLM_OPENAI_API_KEY: { configured: true } },
      models: { LLM_PROVIDER: 'openai', LLM_OPENAI_MODEL: 'gpt-5.5', COPILOT_MODEL: copilotSaved },
    });
  };
  await syncAgentBackends(() => true);
  assert.equal(requestedPaths.includes('/api/copilot/status'), false,
    'an unconfigured optional backend must not start on app launch');
  copilotSaved = 'auto';
  await Promise.race([
    syncAgentBackends(() => true),
    new Promise<never>((_, reject) => {
      startupTimeout = setTimeout(() => reject(new Error('API startup waited for Copilot')), 500);
    }),
  ]);
  assert.equal(requestedPaths.includes('/api/copilot/status'), true);
  assert.equal(getActiveAgentModelChoice()?.backend, 'api',
    'configured API models are usable while a Copilot status request remains unresolved');
} finally {
  clearTimeout(startupTimeout);
  pendingCopilot.resolve(Response.json({ installed: false }));
  globalThis.fetch = originalFetch;
}

// A configured API provider must remain the first-run default even when the
// optional Codex backend is installed and reports its own model catalogue.
const localStorageAfterStartup = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const fetchAfterStartup = globalThis.fetch;
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: () => 'openai:gpt-legacy', setItem: () => undefined },
});
try {
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === '/api/codex/status') {
      return Response.json({
        installed: true,
        version: 'test',
        account: { type: 'chatgpt', email: null, planType: null },
        loginPending: false,
      });
    }
    if (path === '/api/codex/models') {
      return Response.json({ models: [{
        id: 'gpt-codex-test',
        label: 'Codex test',
        isDefault: true,
        defaultReasoningEffort: null,
        supportedReasoningEfforts: [],
      }] });
    }
    return Response.json({
      keys: {
        LLM_OPENAI_API_KEY: { configured: true },
        LLM_DEEPSEEK_API_KEY: { configured: true },
      },
      models: {
        LLM_PROVIDER: 'deepseek',
        LLM_OPENAI_MODEL: 'gpt-legacy',
        LLM_DEEPSEEK_MODEL: 'deepseek-chat',
      },
    });
  };
  await syncAgentBackends(() => true);
  assert.equal(getActiveAgentModelChoice()?.backend, 'api',
    'configured DeepSeek remains active when Codex is available');
  assert.equal(getActiveAgentModelChoice()?.provider, 'deepseek',
    'configured provider wins over Codex first-run fallback');
} finally {
  globalThis.fetch = fetchAfterStartup;
  if (localStorageAfterStartup) Object.defineProperty(globalThis, 'localStorage', localStorageAfterStartup);
  else Reflect.deleteProperty(globalThis, 'localStorage');
}

const platformRequests: string[] = [];
const fetchAfterPlatform = globalThis.fetch;
const localStorageAfterPlatform = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: () => 'copilot:gpt-stale', setItem: () => undefined },
});
try {
  globalThis.fetch = async (input) => {
    const path = String(input);
    platformRequests.push(path);
    if (path !== '/api/keys') throw new Error(`Unexpected platform startup request: ${path}`);
    return Response.json({
      platformManaged: true,
      keys: {
        LLM_OPENAI_API_KEY: { configured: true },
        LLM_DEEPSEEK_API_KEY: { configured: true },
        LLM_QWEN_API_KEY: { configured: true },
      },
      models: {
        LLM_PROVIDER: 'qwen',
        LLM_OPENAI_MODEL: 'gpt-stale',
        LLM_DEEPSEEK_MODEL: 'deepseek-stale',
        LLM_QWEN_MODEL: 'qwen-plus',
        COPILOT_MODEL: 'gpt-stale',
      },
    });
  };
  await syncAgentBackends(() => true);
  assert.deepEqual(platformRequests, ['/api/keys'],
    'platform startup does not inspect local Codex or Copilot installations');
  assert.deepEqual(
    getAgentModelSnapshot().choices.map((choice) => choice.id),
    ['openai:gpt-5.6-terra', 'deepseek:deepseek-chat'],
    'platform startup exposes only the two hosted model choices',
  );
} finally {
  globalThis.fetch = fetchAfterPlatform;
  if (localStorageAfterPlatform) Object.defineProperty(globalThis, 'localStorage', localStorageAfterPlatform);
  else Reflect.deleteProperty(globalThis, 'localStorage');
}

console.log('appShell.verify: project startup and optional-backend isolation passed');
