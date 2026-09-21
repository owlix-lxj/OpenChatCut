import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkMediaDir,
  migrateDesktopScopedMedia,
  resolveUploadFile,
  syncLegacyUploads,
  uploadDir,
  uploadReadDirs,
} from './media-dir.ts';
import { resolveRuntimeProfile } from './runtime-profile.ts';
import { assertProfileSensitiveSettingsPatch } from './plugins/settings.ts';

const fixture = await mkdtemp(join(tmpdir(), 'openchatcut-media-profile-'));
try {
  const homeDir = join(fixture, 'home');
  const cwd = join(fixture, 'checkout');
  const defaultProfile = resolveRuntimeProfile({}, { homeDir, cwd });
  const customDir = join(fixture, 'custom-media');

  assert.equal(uploadDir(defaultProfile, ''), defaultProfile.mediaDir);
  assert.deepEqual(uploadReadDirs(defaultProfile, ''), [defaultProfile.mediaDir]);
  assert.equal(uploadDir(defaultProfile, customDir), customDir);
  assert.deepEqual(uploadReadDirs(defaultProfile, customDir), [customDir, defaultProfile.mediaDir]);

  const profileA = resolveRuntimeProfile({
    OPENCHATCUT_DEV_PROFILE_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }, { homeDir, cwd });
  const profileB = resolveRuntimeProfile({
    OPENCHATCUT_DEV_PROFILE_ID: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  }, { homeDir, cwd });
  const name = 'isolated-media.mp4';
  await mkdir(defaultProfile.mediaDir, { recursive: true });
  await mkdir(profileB.mediaDir, { recursive: true });
  await writeFile(join(defaultProfile.mediaDir, name), 'global');
  await writeFile(join(profileB.mediaDir, name), 'profile-b');

  assert.equal(uploadDir(profileA, customDir), profileA.mediaDir);
  assert.deepEqual(uploadReadDirs(profileA, customDir), [profileA.mediaDir]);
  assert.equal(resolveUploadFile(name, profileA, customDir), null);
  await mkdir(profileA.mediaDir, { recursive: true });
  await writeFile(join(profileA.mediaDir, name), 'profile-a');
  assert.equal(resolveUploadFile(name, profileA, customDir), join(profileA.mediaDir, name));

  const scopedRoot = join(profileA.mediaDir, 'platform-scopes', 'legacy-desktop-scope');
  await mkdir(join(scopedRoot, '.references'), { recursive: true });
  await writeFile(join(scopedRoot, 'legacy-video.mp4'), 'legacy-video');
  await writeFile(join(scopedRoot, '.references', 'legacy-ref.json'), '{"path":"/tmp/source"}');
  await writeFile(join(profileA.mediaDir, 'existing.mp4'), 'keep-existing');
  await writeFile(join(scopedRoot, 'existing.mp4'), 'do-not-overwrite');
  const migrated = await migrateDesktopScopedMedia(profileA.mediaDir);
  assert.equal(migrated.linked + migrated.copied, 2);
  assert.equal(migrated.skipped, 1);
  assert.equal(await readFile(join(profileA.mediaDir, 'legacy-video.mp4'), 'utf8'), 'legacy-video');
  assert.equal(await readFile(join(profileA.mediaDir, 'existing.mp4'), 'utf8'), 'keep-existing');

  const forbiddenProbe = join(fixture, 'must-not-be-created');
  assert.deepEqual(await checkMediaDir(forbiddenProbe, profileA), {
    ok: false,
    error: '隔离开发配置固定使用独立素材目录，不能修改 MEDIA_DIR',
  });
  await assert.rejects(access(forbiddenProbe));
  let legacyLogs = 0;
  await syncLegacyUploads(() => { legacyLogs += 1; }, profileA);
  assert.equal(legacyLogs, 0);

  assert.doesNotThrow(() => assertProfileSensitiveSettingsPatch({ MEDIA_DIR: customDir }, defaultProfile));
  assert.throws(
    () => assertProfileSensitiveSettingsPatch({ MEDIA_DIR: customDir }, profileA),
    /MEDIA_DIR cannot be changed/,
  );
  assert.throws(
    () => assertProfileSensitiveSettingsPatch({ R2_BUCKET: 'shared-bucket' }, profileA),
    /R2 settings cannot be changed/,
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}
