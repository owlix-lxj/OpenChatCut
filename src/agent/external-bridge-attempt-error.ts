import { EditorBridgeRequestError } from './external-bridge-registration';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Shown when another window/tab has taken over this project's editor bridge. */
export const BRIDGE_TAKEN_OVER_MESSAGE =
  '此工程已在另一个标签页或窗口中打开，本页的 AI 助手已暂停以避免互相抢占。关闭其它页面后刷新本页即可继续。';

/**
 * Handle an error from one bridge attempt. Returns `true` when the retry loop
 * should STOP (this window has yielded ownership); `false` to retry.
 *
 * Reports bridge conflicts without navigating away from the editor — a reload
 * can trip the beforeunload guard while autosave is pending, and reloading
 * cannot clear a persisted registration conflict.
 */
export function handleExternalBridgeAttemptError(
  error: unknown,
  signal: AbortSignal,
  onError: (message: string | null) => void,
): boolean {
  if (error instanceof EditorBridgeRequestError && error.status === 409) {
    // Another window/tab took over (different editor instance). Yield: surface a
    // read-only notice and STOP retrying. Re-registering here is what makes two
    // tabs ping-pong ownership into a livelock — so the loser stands down and one
    // owner remains.
    if (error.takenOver) {
      if (!signal.aborted) onError(BRIDGE_TAKEN_OVER_MESSAGE);
      return true;
    }
    // Transient same-window registration mismatch: retry silently (~1s), no flash.
    return false;
  }
  if (!signal.aborted) onError(errorMessage(error));
  return false;
}

