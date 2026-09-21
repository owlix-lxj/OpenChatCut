export function recoverableDouyinNavigationError(error: unknown): boolean {
  const candidate = error as { code?: unknown; errno?: unknown; message?: unknown } | null;
  return candidate?.code === 'ERR_ABORTED'
    || candidate?.errno === -3
    || (typeof candidate?.message === 'string' && /ERR_ABORTED\s*\(-3\)/.test(candidate.message));
}
