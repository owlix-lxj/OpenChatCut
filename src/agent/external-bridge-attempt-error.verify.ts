// Verify: an editor-registration/poll HTTP 409 is a recoverable retry condition
// (runBridge re-registers within ~1s) and must not flash a blocking "close the
// other window" message, navigate away, or reload. Non-409 errors still surface.
import assert from 'node:assert/strict';

let reloadCalls = 0;
(globalThis as unknown as { window?: unknown }).window = {
  location: { reload: () => { reloadCalls += 1; } },
};

const { handleExternalBridgeAttemptError, BRIDGE_TAKEN_OVER_MESSAGE } =
  await import('./external-bridge-attempt-error.ts');
const { EditorBridgeRequestError } = await import('./external-bridge-registration.ts');

function bridgeError(operation: string, status: number, takenOver = false): unknown {
  return new EditorBridgeRequestError(operation, status, takenOver);
}

const noopSignal = { aborted: false } as unknown as AbortSignal;
const errors: string[] = [];
const onError = (message: string | null) => { if (message) errors.push(message); };

// A transient same-window 409 (takenOver=false): retry silently, no message, no stop.
reloadCalls = 0;
for (let i = 0; i < 100; i++) {
  const stopReg = handleExternalBridgeAttemptError(bridgeError('registration', 409), noopSignal, onError);
  const stopPoll = handleExternalBridgeAttemptError(bridgeError('poll', 409), noopSignal, onError);
  handleExternalBridgeAttemptError(bridgeError('cancellation', 409), noopSignal, onError);
  assert.equal(stopReg, false, 'transient 409 must NOT stop the retry loop');
  assert.equal(stopPoll, false, 'transient 409 must NOT stop the retry loop');
}
assert.equal(reloadCalls, 0, 'recoverable 409 must not navigate away from the editor');
assert.equal(errors.length, 0,
  'a transient 409 must not surface a blocking "close other window" message; runBridge retries it');

// A takeover 409 (another tab took over): STOP the loop and surface the read-only notice,
// so two tabs converge on one owner instead of ping-ponging (livelock).
const stopOnTakeover = handleExternalBridgeAttemptError(bridgeError('poll', 409, true), noopSignal, onError);
assert.equal(stopOnTakeover, true, 'a takeover 409 MUST stop the retry loop (yield, do not re-register)');
assert.equal(errors.at(-1), BRIDGE_TAKEN_OVER_MESSAGE, 'takeover surfaces the read-only notice');
assert.equal(reloadCalls, 0, 'takeover must not navigate away / reload');

const before = reloadCalls;
handleExternalBridgeAttemptError(new Error('boom'), noopSignal, onError);
assert.match(errors.at(-1) ?? '', /boom/, 'a genuine non-409 error still surfaces');
assert.equal(reloadCalls, before, 'generic error does not reload');

console.log('external-bridge-attempt-error.verify: OK (transient 409 retried; takeover 409 yields read-only; others surfaced)');
