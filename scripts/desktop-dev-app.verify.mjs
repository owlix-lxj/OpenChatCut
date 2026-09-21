import assert from 'node:assert/strict';
import { join } from 'node:path';
import { devAppBundleIdentifier, devAppPaths } from './desktop-dev-app.mjs';

const PROFILE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
assert.equal(
  devAppBundleIdentifier(PROFILE_ID),
  'dev.openchatcut.app.dev.pdddddddddddd4ddd8ddddddddddddddd',
);
assert.throws(() => devAppBundleIdentifier('../escape'), /Invalid OPENCHATCUT_DEV_PROFILE_ID/);

const paths = devAppPaths({
  repoRoot: '/tmp/openchatcut-checkout',
  profileRoot: '/tmp/openchatcut-profile',
  profileId: PROFILE_ID,
});
assert.equal(paths.appPath, '/tmp/openchatcut-profile/AI-cut Dev.app');
assert.equal(paths.entryPath, '/tmp/openchatcut-checkout/desktop-dist/main.mjs');
assert.equal(
  paths.executablePath,
  join('/tmp/openchatcut-profile', 'AI-cut Dev.app', 'Contents', 'MacOS', 'Electron'),
);
assert.equal(paths.bundleIdentifier, devAppBundleIdentifier(PROFILE_ID));
