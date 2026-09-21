import { spawnSync } from 'node:child_process';
import process from 'node:process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const env = {
  ...process.env,
  // A Windows release is the hosted product build. Developers can explicitly
  // opt out with OPENCHATCUT_PLATFORM_MODE=local for a private local build.
  OPENCHATCUT_PLATFORM_MODE: process.env.OPENCHATCUT_PLATFORM_MODE || 'platform',
  OPENCHATCUT_PLATFORM_API_BASE_URL: process.env.OPENCHATCUT_PLATFORM_API_BASE_URL || 'https://api.daost.cn/api',
  CC_EB_TARGET: 'win32-x64',
};

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

run(npm, ['run', 'build']);
run(npm, ['run', 'desktop:build:main']);
run(npm, ['run', 'desktop:build:geo-extension']);
run(npm, ['run', 'desktop:prebundle']);
run(npm, ['exec', 'tsx', 'desktop/prepare-target.mts', 'win32-x64']);
run(process.execPath, [
  'node_modules/electron-builder/cli.js',
  '--config', 'config/electron-builder.config.mjs',
  '--win', 'nsis', '--x64', '--publish', 'never',
]);
