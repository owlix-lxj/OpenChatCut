import { execFile, spawn } from 'node:child_process';
import {
  copyFile,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEV_APP_VERSION = 1;
const DEV_PROFILE_ID_ENV = 'OPENCHATCUT_DEV_PROFILE_ID';
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function devAppBundleIdentifier(profileId) {
  if (!PROFILE_ID.test(profileId)) throw new Error(`Invalid ${DEV_PROFILE_ID_ENV}`);
  return `dev.openchatcut.app.dev.p${profileId.replaceAll('-', '')}`;
}

export function devAppPaths(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? fileURLToPath(new URL('..', import.meta.url)));
  const profileId = options.profileId ?? process.env[DEV_PROFILE_ID_ENV];
  if (!profileId || !PROFILE_ID.test(profileId)) {
    throw new Error(`Run the desktop app through npm run desktop:dev so ${DEV_PROFILE_ID_ENV} is configured`);
  }
  const profileRoot = resolve(
    options.profileRoot ?? join(homedir(), '.openchatcut', 'dev-profiles', profileId),
  );
  const sourceApp = join(repoRoot, 'node_modules', 'electron', 'dist', 'Electron.app');
  const appPath = join(profileRoot, 'AI-cut Dev.app');
  return {
    appPath,
    bundleIdentifier: devAppBundleIdentifier(profileId),
    entryPath: join(repoRoot, 'desktop-dist', 'main.mjs'),
    executablePath: join(appPath, 'Contents', 'MacOS', 'Electron'),
    iconPath: join(repoRoot, 'assets', 'branding', 'openchatcut-icon.icns'),
    markerPath: join(appPath, 'Contents', 'Resources', 'ai-cut-dev.json'),
    profileId,
    repoRoot,
    sourceApp,
  };
}

async function command(commandPath, args) {
  await execFileAsync(commandPath, args, { maxBuffer: 1024 * 1024 });
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function electronVersion(repoRoot) {
  const packageJson = JSON.parse(await readFile(join(repoRoot, 'node_modules', 'electron', 'package.json'), 'utf8'));
  if (typeof packageJson.version !== 'string' || !packageJson.version) {
    throw new Error('Installed Electron package has no version');
  }
  return packageJson.version;
}

async function copyApp(source, destination) {
  try {
    await command('/bin/cp', ['-cR', source, destination]);
  } catch {
    await command('/usr/bin/ditto', [source, destination]);
  }
}

async function configureBundle(paths, marker) {
  const plist = join(paths.appPath, 'Contents', 'Info.plist');
  const replace = (key, type, value) => command('/usr/bin/plutil', [
    '-replace', key, `-${type}`, value, plist,
  ]);
  await replace('CFBundleIdentifier', 'string', paths.bundleIdentifier);
  await replace('CFBundleName', 'string', 'AI-cut Dev');
  await replace('CFBundleDisplayName', 'string', 'AI-cut Dev');
  await replace('CFBundleURLTypes', 'json', JSON.stringify([{
    CFBundleURLName: 'AI-cut Dev',
    CFBundleURLSchemes: ['openchatcut'],
  }]));
  await copyFile(paths.iconPath, join(paths.appPath, 'Contents', 'Resources', 'electron.icns'));
  await writeFile(paths.markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  await command('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', paths.appPath]);
}

export async function ensureMacDevApp(options = {}) {
  const paths = devAppPaths(options);
  const marker = {
    version: DEV_APP_VERSION,
    electronVersion: await electronVersion(paths.repoRoot),
    bundleIdentifier: paths.bundleIdentifier,
    repoRoot: paths.repoRoot,
  };
  const existing = await readJson(paths.markerPath);
  if (JSON.stringify(existing) !== JSON.stringify(marker)) {
    const temporaryRoot = await mkdtemp(join(dirname(paths.appPath), '.ai-cut-dev-'));
    const temporaryApp = join(temporaryRoot, basename(paths.appPath));
    try {
      await copyApp(paths.sourceApp, temporaryApp);
      await configureBundle({ ...paths, appPath: temporaryApp, markerPath: join(
        temporaryApp, 'Contents', 'Resources', 'ai-cut-dev.json',
      ) }, marker);
      await rm(paths.appPath, { recursive: true, force: true });
      await rename(temporaryApp, paths.appPath);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
  const launchServices = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  await command(launchServices, ['-f', paths.appPath]);
  return paths;
}

function waitForChild(executable, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { env: process.env, stdio: 'inherit' });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => resolveRun(code ?? (signal ? 1 : 0)));
  });
}

export async function runDesktopDev(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? fileURLToPath(new URL('..', import.meta.url)));
  if (process.platform !== 'darwin') {
    const electronCli = join(repoRoot, 'node_modules', 'electron', 'cli.js');
    return waitForChild(process.execPath, [electronCli, join(repoRoot, 'desktop-dist', 'main.mjs')]);
  }
  const paths = await ensureMacDevApp({ repoRoot });
  process.stdout.write(`[desktop] launching ${paths.appPath}\n`);
  return waitForChild(paths.executablePath, [paths.entryPath]);
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryUrl) {
  runDesktopDev().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
