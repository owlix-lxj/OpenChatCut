// Verify the editor-ownership takeover discriminator that breaks the two-tab
// livelock: when a second window/tab registers for a project it takes over, and
// the first window's poll must be reported as a TAKEOVER (so its client yields
// and goes read-only) rather than a transient mismatch (which would re-register
// and ping-pong ownership forever — the 405/deadlock users hit).
import assert from 'node:assert/strict';
import { EditorConnectionRegistry } from './broker-registry.ts';

const registry = new EditorConnectionRegistry({
  bindingReplaced: () => {},
  revisionChanged: () => {},
  editorRemoved: () => {},
  wakeProject: () => {},
  hasInFlightCall: () => false,
});

const PROJECT = 'proj-1';
const REV = 'v1';

// Tab A registers first and owns the project.
const capA = registry.register(PROJECT, 'editor-A', REV, [], undefined, null);
assert.equal(registry.registrationMatches(PROJECT, 'editor-A', capA), true, 'A owns after registering');
assert.equal(registry.registrationTakenOverBy(PROJECT, 'editor-A'), false,
  'A is the sole owner — not taken over');

// Tab B registers for the SAME project → it takes over (newest wins).
const capB = registry.register(PROJECT, 'editor-B', REV, [], undefined, null);
assert.equal(registry.registrationMatches(PROJECT, 'editor-B', capB), true, 'B owns after takeover');

// The crux: A's subsequent poll no longer matches AND is a genuine takeover by a
// different editor instance — so A yields (read-only) instead of re-registering.
assert.equal(registry.registrationMatches(PROJECT, 'editor-A', capA), false,
  'A no longer matches after B took over');
assert.equal(registry.registrationTakenOverBy(PROJECT, 'editor-A'), true,
  'A was taken over by a different editor → client must yield, not re-register');

// B, the current owner, is NOT taken over.
assert.equal(registry.registrationTakenOverBy(PROJECT, 'editor-B'), false,
  'the current owner is not taken over');

// A no-registration project is not a takeover (nothing to yield to).
assert.equal(registry.registrationTakenOverBy('proj-none', 'editor-X'), false,
  'no registration → not a takeover');

console.log('broker-registry-takeover.verify: OK (newest wins; loser reported as takeover → yields, no livelock)');
