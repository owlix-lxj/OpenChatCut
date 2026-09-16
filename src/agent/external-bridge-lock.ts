const LOCK_PREFIX = 'openchatcut-external-bridge:';

/**
 * Only one tab may expose a project's browser bridge at a time. Without this
 * lock, two editor tabs repeatedly replace each other's server capability and
 * turn every long poll into a 409/re-register loop.
 */
export async function withExternalBridgeLock(
  projectId: string,
  signal: AbortSignal,
  task: () => Promise<void>,
): Promise<void> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) {
    await task();
    return;
  }
  await locks.request(
    `${LOCK_PREFIX}${projectId}`,
    { mode: 'exclusive', signal },
    async () => {
      signal.throwIfAborted();
      await task();
    },
  );
}
