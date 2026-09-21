import type { CodexAgentModel, CodexAgentStatus } from '../../shared/codex-agent';
import type { CopilotAgentModel, CopilotAgentStatus } from '../../shared/copilot-agent';
import { loadAgentModelPref, saveAgentModelPref } from '../persist/sessionPrefs';
import {
  LLM_PROVIDER_PRESETS,
  defaultModelForProvider,
  isLocalLlmProvider,
  llmProviderConfigNames,
  normalizeLlmProvider,
  type LlmProvider,
  type OpenAiApiMode,
} from '../../shared/llm-providers';
import {
  MODEL_CAPABILITY_OVERRIDES_KEY,
  copilotProviderForModel,
  parseModelCapabilityOverrides,
  resolveCopilotModelCapabilities,
  resolveModelCapabilities,
  type ModelCapabilities,
  type ModelCapabilityOverride,
  type ModelIdentity,
} from '../../shared/model-capabilities';
import { isPlatformLlmProvider, PLATFORM_DEFAULT_LLM_CONFIG } from '../../shared/platform-config';
import { setLlmConfig } from './providerConfig';

interface KeyStateLike {
  readonly configured: boolean;
}

export interface AgentModelChoice {
  readonly id: string;
  readonly backend: 'api' | 'codex' | 'copilot';
  readonly provider: LlmProvider;
  readonly providerLabel: string;
  readonly model: string;
  readonly requestModel?: string;
  readonly openAiApiMode?: OpenAiApiMode;
  readonly reasoningEffort?: string;
  readonly capabilities: ModelCapabilities;
}

export interface AgentModelSnapshot {
  readonly choices: readonly AgentModelChoice[];
  readonly activeId: string;
  readonly loaded: boolean;
}

let snapshot: AgentModelSnapshot = { choices: [], activeId: '', loaded: false };
let apiModelChoices: readonly AgentModelChoice[] = [];
let codexModelChoices: readonly AgentModelChoice[] = [];
let platformManagedMode = false;
let lastApiProvider: LlmProvider | '' = '';
let capabilityOverrides: readonly ModelCapabilityOverride[] = [];
let codexStatus: CodexAgentStatus | null = null;
let codexSavedModel = '';
let codexSavedReasoningEffort = '';
let codexDiscoveredModels: readonly CodexAgentModel[] = [];
let copilotModelChoices: readonly AgentModelChoice[] = [];
let copilotStatus: CopilotAgentStatus | null = null;
let copilotSavedModel = '';
let copilotSavedReasoningEffort = '';
let copilotDiscoveredModels: readonly CopilotAgentModel[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function commit(choices: readonly AgentModelChoice[], activeId: string, loaded = snapshot.loaded): void {
  snapshot = { choices, activeId, loaded };
  emit();
}

function commitChoices(
  choices: readonly AgentModelChoice[],
  activeId: string,
  loaded = snapshot.loaded,
  fallbackApi?: AgentModelChoice,
): void {
  const active = choices.find((choice) => choice.id === activeId);
  const runtimeApi = active?.backend === 'api' ? active : fallbackApi;
  if (runtimeApi) {
    setLlmConfig(runtimeApi.provider, runtimeApi.model, runtimeApi.openAiApiMode);
  }
  commit(choices, activeId, loaded);
}

function safeOverrides(raw: unknown): readonly ModelCapabilityOverride[] {
  try { return parseModelCapabilityOverrides(raw); } catch { return []; }
}

function modelCapabilities(identity: ModelIdentity): ModelCapabilities {
  return resolveModelCapabilities(identity, capabilityOverrides);
}

function apiChoices(
  keys: Record<string, KeyStateLike>,
  models: Record<string, string>,
  platformManaged = false,
): readonly AgentModelChoice[] {
  return LLM_PROVIDER_PRESETS.flatMap((preset): AgentModelChoice[] => {
    if (platformManaged && !isPlatformLlmProvider(preset.id)) return [];
    const names = llmProviderConfigNames(preset.id);
    const savedModel = models[names.model]?.trim() ?? '';
    if (!platformManaged
      && (isLocalLlmProvider(preset.id) ? !savedModel : !keys[names.apiKey]?.configured)) return [];
    const model = platformManaged && isPlatformLlmProvider(preset.id)
      ? PLATFORM_DEFAULT_LLM_CONFIG[preset.id].model
      : savedModel || defaultModelForProvider(preset.id);
    const identity: ModelIdentity = { backend: 'api', provider: preset.id, modelId: model };
    return [{
      id: `${preset.id}:${model}`,
      backend: 'api',
      provider: preset.id,
      providerLabel: preset.label,
      model,
      ...(preset.id === 'openai'
        ? { openAiApiMode: models.LLM_OPENAI_API_MODE === 'chat' ? 'chat' : 'responses' }
        : preset.id === 'xai-oauth'
          ? { openAiApiMode: 'responses' as const }
          : {}),
      capabilities: modelCapabilities(identity),
    }];
  });
}

function chooseInitialApiId(
  choices: readonly AgentModelChoice[],
  models: Record<string, string>,
): string {
  const preferred = normalizeLlmProvider(models.LLM_PROVIDER);
  return choices.find((choice) => choice.provider === preferred)?.id ?? choices[0]?.id ?? '';
}

/**
 * A provider change in .env/settings is authoritative for the initial API
 * choice. Keep an explicitly selected non-API backend (Codex/Copilot), but do
 * not resurrect a stale API choice from the previous provider.
 */
function matchesInitialApiChoice(
  choice: AgentModelChoice | undefined,
  initialApiId: string,
): boolean {
  if (!choice) return false;
  return !initialApiId || choice.backend !== 'api' || choice.id === initialApiId;
}

function allChoices(): readonly AgentModelChoice[] {
  return platformManagedMode
    ? apiModelChoices
    : [...apiModelChoices, ...codexModelChoices, ...copilotModelChoices];
}
function rebuildCodexChoices(): void {
  if (platformManagedMode || !codexStatus?.installed || codexStatus.account?.type === 'apiKey') {
    codexModelChoices = [];
    return;
  }
  const entries = codexDiscoveredModels.length > 0
    ? codexDiscoveredModels
    : (codexSavedModel.trim() ? [{ id: codexSavedModel.trim() }] : []);
  codexModelChoices = entries.map((entry) => {
    const requested = entry.id === codexSavedModel;
    const identity: ModelIdentity = { backend: 'codex', provider: 'openai', modelId: entry.id };
    const capabilities = modelCapabilities(identity);
    return {
      id: `codex:${entry.id}`,
      backend: 'codex',
      provider: 'openai',
      providerLabel: 'OpenAI Codex',
      model: entry.id,
      ...(requested ? { requestModel: entry.id } : {}),
      reasoningEffort: selectedReasoningEffort(codexSavedReasoningEffort, capabilities),
      capabilities,
    };
  });
}

/**
 * Copilot serves models from several vendors behind one subscription, and the
 * runtime reports exact limits per model, so capabilities come from those facts
 * rather than the bundled catalog. Models without tool support are dropped:
 * every OpenChatCut editing flow needs tool calls.
 */
function rebuildCopilotChoices(): void {
  if (platformManagedMode
    || !copilotStatus?.installed
    || !copilotStatus.supported
    || !copilotStatus.authenticated) {
    copilotModelChoices = [];
    return;
  }
  const entries = copilotDiscoveredModels.length > 0
    ? copilotDiscoveredModels
    : (copilotSavedModel.trim()
      ? [{
          id: copilotSavedModel.trim(),
          label: copilotSavedModel.trim(),
          isDefault: false,
          supportsTools: true,
          supportsVision: false,
          contextWindowTokens: null,
          maxInputTokens: null,
          maxOutputTokens: null,
          supportedReasoningEfforts: [],
        } satisfies CopilotAgentModel]
      : []);
  copilotModelChoices = entries
    .filter((entry) => entry.supportsTools)
    .map((entry) => {
      const provider = copilotProviderForModel(entry.id);
      const identity: ModelIdentity = { backend: 'copilot', provider, modelId: entry.id };
      const capabilities = resolveCopilotModelCapabilities(identity, {
        contextWindowTokens: entry.contextWindowTokens,
        maxInputTokens: entry.maxInputTokens,
        maxOutputTokens: entry.maxOutputTokens,
        supportsTools: entry.supportsTools,
        supportsVision: entry.supportsVision,
        reasoningEfforts: entry.supportedReasoningEfforts,
      }, capabilityOverrides);
      return {
        id: `copilot:${entry.id}`,
        backend: 'copilot' as const,
        provider,
        providerLabel: 'GitHub Copilot',
        model: entry.id,
        ...(entry.id === copilotSavedModel ? { requestModel: entry.id } : {}),
        reasoningEffort: selectedReasoningEffort(copilotSavedReasoningEffort, capabilities),
        capabilities,
      };
    });
}

export function applyAgentModelStatus(
  keys: Record<string, KeyStateLike>,
  models: Record<string, string>,
  platformManaged = false,
): void {
  platformManagedMode = platformManaged;
  capabilityOverrides = safeOverrides(models[MODEL_CAPABILITY_OVERRIDES_KEY]);
  apiModelChoices = apiChoices(keys, models, platformManaged);
  codexSavedModel = models.CODEX_MODEL?.trim() ?? codexSavedModel;
  codexSavedReasoningEffort = models.CODEX_REASONING_EFFORT?.trim() ?? codexSavedReasoningEffort;
  copilotSavedModel = models.COPILOT_MODEL?.trim() ?? copilotSavedModel;
  copilotSavedReasoningEffort = models.COPILOT_REASONING_EFFORT?.trim() ?? copilotSavedReasoningEffort;
  rebuildCodexChoices();
  rebuildCopilotChoices();
  const choices = allChoices();
  const initialApiId = chooseInitialApiId(apiModelChoices, models);
  const preferred = loadAgentModelPref();
  const preferredChoice = choices.find((choice) => choice.id === preferred);
  const activeChoice = choices.find((choice) => choice.id === snapshot.activeId);
  const initialProvider = apiModelChoices.find((choice) => choice.id === initialApiId)?.provider ?? '';
  const preserved = platformManagedMode
    ? (matchesInitialApiChoice(preferredChoice, initialApiId) ? preferred
      : matchesInitialApiChoice(activeChoice, initialApiId) ? snapshot.activeId : '')
    : preferredChoice && (!snapshot.activeId || preferred === snapshot.activeId) ? preferred
      : activeChoice && (activeChoice.backend !== 'api' || initialProvider === lastApiProvider)
        ? snapshot.activeId : '';
  // Respect the configured API provider as the first-run fallback. Codex is an
  // independent backend and should remain available as a choice, but it must
  // not displace an explicitly configured LLM merely because its status loaded
  // first or because Codex happens to be installed.
  commitChoices(choices, preserved || initialApiId || codexModelChoices[0]?.id || choices[0]?.id || '', true,
    apiModelChoices.find((choice) => choice.id === initialApiId));
  lastApiProvider = initialProvider;
}

function selectedReasoningEffort(requested: string | undefined, capabilities: ModelCapabilities): string {
  const effort = requested?.trim() ?? '';
  if (!effort) return '';
  if (!capabilities.supportsReasoning.estimated && !capabilities.supportsReasoning.value) return '';
  const supported = capabilities.reasoningEfforts.value;
  return supported.length === 0 || supported.includes(effort)
    ? effort
    : capabilities.defaultReasoningEffort?.value ?? '';
}


export function applyCodexAgentStatus(
  status: CodexAgentStatus,
  savedModel?: string,
  savedReasoningEffort?: string,
  discoveredModels?: readonly CodexAgentModel[],
): void {
  codexStatus = status;
  codexSavedModel = savedModel?.trim() ?? codexSavedModel;
  codexSavedReasoningEffort = savedReasoningEffort?.trim() ?? codexSavedReasoningEffort;
  if (discoveredModels) codexDiscoveredModels = discoveredModels;
  rebuildCodexChoices();
  const choices = allChoices();
  const preffered = loadAgentModelPref();
  // The API sync has already applied the configured provider. Preserve the
  // current active choice first so a stale API preference cannot displace it
  // when Codex status arrives asynchronously.
  const preserved = choices.some((choice) => choice.id === snapshot.activeId) ? snapshot.activeId
    : choices.some((choice) => choice.id === preffered) ? preffered : '';
  commitChoices(choices, preserved || codexModelChoices[0]?.id || choices[0]?.id || '', true);
}

export function applyCopilotAgentStatus(
  status: CopilotAgentStatus,
  savedModel?: string,
  savedReasoningEffort?: string,
  discoveredModels?: readonly CopilotAgentModel[],
): void {
  copilotStatus = status;
  copilotSavedModel = savedModel?.trim() ?? copilotSavedModel;
  copilotSavedReasoningEffort = savedReasoningEffort?.trim() ?? copilotSavedReasoningEffort;
  if (discoveredModels) copilotDiscoveredModels = discoveredModels;
  rebuildCopilotChoices();
  const choices = allChoices();
  const preferred = loadAgentModelPref();
  const preserved = choices.some((choice) => choice.id === snapshot.activeId) ? snapshot.activeId
    : choices.some((choice) => choice.id === preferred) ? preferred : '';
  commitChoices(choices, preserved || choices[0]?.id || '', true);
}

export function getAgentModelSnapshot(): AgentModelSnapshot {
  return snapshot;
}

export function subscribeAgentModels(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isAgentModelReady(state: AgentModelSnapshot = snapshot): boolean {
  return state.loaded
    && Boolean(state.activeId)
    && state.choices.some((choice) => choice.id === state.activeId);
}

export function getActiveAgentModelChoice(): AgentModelChoice | undefined {
  return snapshot.choices.find((choice) => choice.id === snapshot.activeId);
}

export function selectAgentModel(id: string): void {
  const choice = snapshot.choices.find((candidate) => candidate.id === id);
  if (!choice) return;
  commitChoices(snapshot.choices, choice.id);
  saveAgentModelPref(id);
}
