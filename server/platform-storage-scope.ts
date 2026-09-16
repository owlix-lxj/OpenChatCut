import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';

const storageScope = new AsyncLocalStorage<string | undefined>();
const PREFIX = 'platform-scope:';

export function withPlatformStorageScope<T>(scope: string, task: () => T): T {
  return storageScope.run(scope, task);
}

export function withoutPlatformStorageScope<T>(task: () => T): T {
  return storageScope.run(undefined, task);
}

export function currentPlatformStorageScope(): string | undefined {
  return storageScope.getStore();
}

export function scopedPlatformDirectory(root: string): string {
  const scope = currentPlatformStorageScope();
  return scope ? join(root, 'platform-scopes', scope) : root;
}

export function physicalProjectStoreKey(key: string): string {
  const scope = storageScope.getStore();
  return scope ? `${PREFIX}${scope}:${key}` : key;
}

export function logicalProjectStoreKey(key: string): string | null {
  const scope = storageScope.getStore();
  if (!scope) return key.startsWith(PREFIX) ? null : key;
  const prefix = `${PREFIX}${scope}:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

export function platformStorageScoped(): boolean {
  return storageScope.getStore() !== undefined;
}
