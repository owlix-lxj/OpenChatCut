import { startUiLocaleSync } from '../i18n/localeSync';
import { useCallback, useEffect, useState } from 'react';
import { applyLiveCaps, applyLiveKeyStatus, applyLiveModels } from '../agent/capabilities';
import { fetchCodexModels, fetchCodexStatus } from '../agent/codex/client';
import { fetchCopilotModels, fetchCopilotStatus } from '../agent/copilot/client';
import { applyAgentModelStatus, applyCodexAgentStatus, applyCopilotAgentStatus } from '../agent/model-selection';
import { loadAgentModelPref } from '../persist/sessionPrefs';
import type { ProjectDoc, TimelineState } from '../editor/types';
import {
  createProject,
  docFromTimeline,
  hasProjectHistory,
  listProjects,
} from '../persist/projectStore';
import type { ProjectMeta } from '../persist/projectStoreCoordinators';
import { kvRemoteMode } from '../persist/sharedKv';
import { projectStoreWriteCredential } from '../persist/projectStoreTransport';

export type AppRoute = { name: 'dashboard' } | { name: 'editor'; id: string };

interface LiveAgentStatus {
  readonly caps?: Record<string, boolean>;
  readonly keys?: Record<string, { readonly configured: boolean }>;
  readonly models?: Record<string, string>;
  readonly platformManaged?: boolean;
}

const emptyState = (): TimelineState => ({
  fps: 30,
  width: 1920,
  height: 1080,
  items: [],
  selectedId: null,
  trackOrder: ['track_v1'],
  tracks: { track_v1: { kind: 'video' } },
});

export const emptyProjectDoc = (): ProjectDoc => docFromTimeline(emptyState());
// Keep the sample timeline out of established users' startup bundle; it is needed only on first run.
const seedDoc = async (): Promise<ProjectDoc> => docFromTimeline((await import('../editor/initial')).INITIAL);

function parseHash(): AppRoute {
  const match = window.location.hash.match(/^#\/editor\/(.+)$/);
  return match ? { name: 'editor', id: match[1] } : { name: 'dashboard' };
}

export function navigateTo(hash: string): void {
  window.location.hash = hash;
}

async function syncCopilotBackend(
  isActive: () => boolean,
  savedModel?: string,
  savedReasoningEffort?: string,
): Promise<void> {
  try {
    const status = await fetchCopilotStatus();
    if (!isActive()) return;
    const models = status.installed && status.supported && status.authenticated
      ? await fetchCopilotModels().catch(() => null)
      : null;
    if (isActive()) applyCopilotAgentStatus(
      status, savedModel, savedReasoningEffort, models && !models.error ? models.models : [],
    );
  } catch {
    // An optional backend must not prevent configured API/Codex models from loading.
  }
}

export async function syncAgentBackends(isActive: () => boolean): Promise<void> {
  const keyResult = await fetch('/api/keys').then(async (response): Promise<LiveAgentStatus> => {
    if (!response.ok) throw new Error('Agent key status is unavailable.');
    return response.json() as Promise<LiveAgentStatus>;
  }).catch(() => null);
  if (!isActive()) return;
  let savedCodexModel: string | undefined;
  let savedCodexReasoningEffort: string | undefined;
  if (keyResult) {
    const { caps, keys, models, platformManaged } = keyResult;
    if (caps) applyLiveCaps(caps);
    if (keys) applyLiveKeyStatus(keys);
    if (models) {
      applyLiveModels(models);
      applyAgentModelStatus(keys ?? {}, models, platformManaged === true);
      savedCodexModel = models.CODEX_MODEL;
      savedCodexReasoningEffort = models.CODEX_REASONING_EFFORT;
      if (platformManaged !== true
        && (models.COPILOT_MODEL || loadAgentModelPref()?.startsWith('copilot:'))) {
        void syncCopilotBackend(isActive, models.COPILOT_MODEL, models.COPILOT_REASONING_EFFORT);
      }
    } else if (platformManaged === true) {
      applyAgentModelStatus(keys ?? {}, {}, true);
    }
    startUiLocaleSync(models?.UI_LOCALE);
    if (platformManaged === true) return;
  }
  const codexStatus = await fetchCodexStatus().catch(() => null);
  if (!codexStatus || !isActive()) return;
  const modelResult = codexStatus.installed && codexStatus.account?.type !== 'apiKey'
    ? await fetchCodexModels().catch(() => null)
    : null;
  if (!isActive()) return;
  applyCodexAgentStatus(
    codexStatus,
    savedCodexModel,
    savedCodexReasoningEffort,
    modelResult && !modelResult.error ? modelResult.models : [],
  );
}

export function useAppRoute(): AppRoute {
  const [route, setRoute] = useState<AppRoute>(parseHash());
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

export function useAgentBackendSync(): void {
  useEffect(() => {
    let alive = true;
    void syncAgentBackends(() => alive);
    return () => { alive = false; };
  }, []);
}

export interface ProjectStartupSource {
  list(): Promise<ProjectMeta[]>;
  hasHistory(): Promise<boolean>;
  canSeedDemo(): boolean;
  createDemo(): Promise<ProjectMeta>;
}

const projectStartupSource: ProjectStartupSource = {
  list: listProjects,
  hasHistory: hasProjectHistory,
  canSeedDemo: () => kvRemoteMode() === 'local' || projectStoreWriteCredential(),
  createDemo: async () => createProject('示例工程', await seedDoc()),
};

export async function loadInitialProjects(
  source: ProjectStartupSource = projectStartupSource,
): Promise<ProjectMeta[]> {
  const list = await source.list();
  if (list.length > 0 || await source.hasHistory()) return list;
  if (!source.canSeedDemo()) return [];
  return [await source.createDemo()];
}

export function useProjects(): {
  projects: ProjectMeta[] | null;
  refresh: () => Promise<void>;
} {
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null);
  const refresh = useCallback(async () => { setProjects(await listProjects()); }, []);
  useEffect(() => {
    void loadInitialProjects().then(setProjects);
  }, []);
  return { projects, refresh };
}
