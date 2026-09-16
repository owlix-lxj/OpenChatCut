import type { ProjectStoreMutationResponse, ProjectStoreRequest } from '../../shared/project-store-transport';

type AgentRuntimeWriteRequest = Extract<ProjectStoreRequest, { operation: 'agent-runtime-write' }>;
type AgentRunLeaseRequest = Extract<ProjectStoreRequest, { operation: 'agent-run-lease' }>;

export interface SharedKvBackend {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  writeAgentRuntime(input: AgentRuntimeWriteRequest): Promise<ProjectStoreMutationResponse>;
  updateAgentRunLease(input: AgentRunLeaseRequest): Promise<ProjectStoreMutationResponse>;
}

const DB_NAME = 'openchatcut';
const STORE = 'kv';
const memoryStore = new Map<string, unknown>();
let platformClientScope: string | undefined;

export function configurePlatformClientStorageScope(tenantId: string, userId: string): void {
  if (!tenantId || !userId) throw new Error('platform storage identity is required');
  platformClientScope = `platform-client:${encodeURIComponent(tenantId)}:${encodeURIComponent(userId)}:`;
  memoryStore.clear();
  freshCache.clear();
}

function physicalKey(key: string): string {
  if (typeof __PLATFORM_MANAGED__ !== 'undefined' && __PLATFORM_MANAGED__) {
    if (!platformClientScope) throw new Error('platform storage identity is not established');
    return `${platformClientScope}${key}`;
  }
  return key;
}

function logicalKeys(keys: string[]): string[] {
  if (typeof __PLATFORM_MANAGED__ !== 'undefined' && __PLATFORM_MANAGED__) {
    if (!platformClientScope) throw new Error('platform storage identity is not established');
    return keys.filter((key) => key.startsWith(platformClientScope!))
      .map((key) => key.slice(platformClientScope!.length));
  }
  return keys.filter((key) => !key.startsWith('platform-client:'));
}
export let injectedBackend: SharedKvBackend | undefined;
export const freshCache = new Map<string, { value: unknown; at: number }>();
export const hasIdb = (): boolean => typeof indexedDB !== 'undefined';

export function configureLocalKvBackend(backend: SharedKvBackend | undefined): void {
  injectedBackend = backend;
}

export function resetLocalKvMemory(): void {
  memoryStore.clear();
  freshCache.clear();
  injectedBackend = undefined;
}

// Reuse successful connections; a failed open must remain retryable.
let dbPromise: Promise<IDBDatabase> | undefined;
function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); dbPromise = undefined; };
      db.onclose = () => { dbPromise = undefined; };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    dbPromise = undefined;
    throw error;
  });
  return dbPromise;
}

export async function localGet<T>(key: string): Promise<T | undefined> {
  if (injectedBackend) return injectedBackend.get<T>(key);
  const storedKey = physicalKey(key);
  if (!hasIdb()) return memoryStore.get(storedKey) as T | undefined;
  const db = await openDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(storedKey);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function localSet(key: string, value: unknown): Promise<void> {
  freshCache.delete(key);
  if (injectedBackend) return injectedBackend.set(key, value);
  const storedKey = physicalKey(key);
  if (!hasIdb()) {
    memoryStore.set(storedKey, value);
    return;
  }
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(value, storedKey);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function localDel(key: string): Promise<void> {
  freshCache.delete(key);
  if (injectedBackend) return injectedBackend.delete(key);
  const storedKey = physicalKey(key);
  if (!hasIdb()) {
    memoryStore.delete(storedKey);
    return;
  }
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).delete(storedKey);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function localKeys(): Promise<string[]> {
  if (injectedBackend) return injectedBackend.keys();
  if (!hasIdb()) return logicalKeys([...memoryStore.keys()]);
  const db = await openDb();
  return new Promise<string[]>((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
    request.onsuccess = () => resolve(logicalKeys(request.result.filter((key): key is string => typeof key === 'string')));
    request.onerror = () => reject(request.error);
  });
}
