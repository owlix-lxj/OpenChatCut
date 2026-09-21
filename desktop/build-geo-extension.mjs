import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, cp, realpath } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, '../desktop-dist/geo-publish-extension');
const bundled = resolve(here, 'geo-publish-extension');
const bundledRuntime = resolve(here, 'geo-embedded-runtime.js');
const requestedSource = process.env.GEO_EXTENSION_SOURCE?.trim();
const defaultSource = '/Users/lxj/GEO-local/GEO/apps/wechatsync-extension-dist';
let source = null;
try {
  source = await realpath(requestedSource || defaultSource);
} catch {
  // Public checkouts do not contain the private GEO workspace. A pinned,
  // reviewed export is kept in this repository so release builds remain
  // reproducible without that machine-local path.
}
if (!source) {
  if (!existsSync(bundled) || !existsSync(bundledRuntime)) {
    throw new Error('GEO runtime missing. Set GEO_EXTENSION_SOURCE to wechatsync-extension-dist or restore desktop/geo-publish-extension and desktop/geo-embedded-runtime.js.');
  }
  await mkdir(output, { recursive: true });
  await cp(bundled, output, { recursive: true });
  await cp(bundledRuntime, resolve(here, '../desktop-dist/geo-embedded-runtime.js'));
  console.log(`GEO pinned runtime: ${output}`);
  process.exit(0);
}
const coreName = 'assets/index.ts-Bw-475TG.js';
const expected = 'c1b0bcd91b72305d173bb6fa526d93002d01ab7bf011fbeb7bb6ad60b8b433ce';
const core = await readFile(join(source, coreName), 'utf8');
if (createHash('sha256').update(core).digest('hex') !== expected) throw new Error('GEO 插件版本已改变；请审查接口后更新固定版本，禁止猜测压缩变量');
const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
if (manifest.version !== '2.0.9' || manifest.background?.service_worker !== 'service-worker-loader.js') throw new Error('GEO 插件清单不匹配');
if (source === output || source.startsWith(`${output}/`) || output.startsWith(`${source}/`)) throw new Error('不得覆盖原 GEO 插件');
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
// A pinned, reproducible export boundary into the actual GEO runtime. Original source is untouched.
const oldListener = 'chrome.runtime.onMessage.addListener((c,o,e)=>(Ya(c,o).then(e).catch(t=>e({error:t.message})),!0));';
if (core.split(oldListener).length !== 2) throw new Error('GEO 消息入口不匹配');
// Avoid two listeners racing to answer the new pairing messages.
let adaptedCore = core.replace(oldListener, 'chrome.runtime.onMessage.addListener((c,o,e)=>{if(c?.type?.startsWith("AICUT_"))return false;Ya(c,o).then(e).catch(t=>e({error:t.message}));return true;});');
// The enhanced copy must not phone home, pre-check every browser account, or open marketing tabs.
// These boundaries are covered by the pinned input digest; keep the underlying adapters unchanged.
const installStart = adaptedCore.indexOf('chrome.runtime.onInstalled.addListener');
const installEnd = adaptedCore.indexOf('async function Qa()', installStart);
const backgroundStart = adaptedCore.indexOf('chrome.runtime.onStartup.addListener');
const backgroundEnd = adaptedCore.indexOf('async function Za()', backgroundStart);
if (installStart < 0 || installEnd < installStart || backgroundStart < installEnd || backgroundEnd < backgroundStart) throw new Error('GEO 初始化边界已改变');
adaptedCore = adaptedCore.slice(0, backgroundStart) + adaptedCore.slice(backgroundEnd);
adaptedCore = adaptedCore.slice(0, installStart) + adaptedCore.slice(installEnd);
adaptedCore = adaptedCore.replace('H.debug(`Server URL set to ${this.serverUrl}`)', 'H.debug("Server URL configured")')
  .replace('H.debug(`Connecting to ${this.serverUrl} (attempt ${this.reconnectAttempts+1})`)', 'H.debug("Connecting to configured bridge")');
await writeFile(join(output, coreName), `${adaptedCore}\nexport { G as geoMcpClient };\n`);
await cp(join(here, 'geo-extension'), output, { recursive: true });
await build({ entryPoints: [join(here, 'geo-video-adapter.ts')], bundle: true, format: 'esm', platform: 'browser', outfile: join(output, 'video-adapter.mjs') });
await writeFile(join(output, 'service-worker-loader.js'), `import { geoMcpClient } from './${coreName}';\nimport { installAiCutBridge } from './runtime.mjs';\ninstallAiCutBridge(geoMcpClient, chrome);\n`);
manifest.name = 'AI-cut · GEO 发布桥接（开发版）';
manifest.minimum_chrome_version = '116';
manifest.permissions = [...new Set([...manifest.permissions, 'debugger'])];
// Publishing is background-only. Do not inject GEO's article UI/API into every website.
delete manifest.content_scripts;
delete manifest.web_accessible_resources;
manifest.host_permissions = ['https://*.douyin.com/*', 'https://*.xiaohongshu.com/*', 'http://127.0.0.1/*'];
manifest.description = '基于 GEO 文章同步助手的本机发布桥接；账号保留在浏览器中。';
manifest.action = { ...manifest.action, default_popup: 'aicut-options.html' };
manifest.options_ui = { page: 'aicut-options.html', open_in_tab: true };
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
// Built-in host uses the same GEO client and adapter code, with Electron-backed Chrome API compatibility.
await build({ stdin: { contents: `export { geoMcpClient } from './assets/index.ts-Bw-475TG.js'; import './service-worker-loader.js';`, resolveDir: output },
  bundle: true, format: 'iife', platform: 'browser', globalName: 'aicutGeoEmbedded',
  define: { 'import.meta': '{}' }, outfile: resolve(here, '../desktop-dist/geo-embedded-runtime.js') });
await writeFile(join(output, 'AICUT-NOTICE.txt'), `Development integration of the local GEO Wechatsync 2.0.9 extension.\nOriginal source: ${source}\nCore SHA-256: ${expected}\nUpstream: https://github.com/wechatsync/Wechatsync (GPL-3.0)\nAI-cut adds a pinned export/message boundary, removes automatic telemetry/update/auth scans and marketing tabs, and redacts connection URLs from logging.\nAI-cut additions: runtime.mjs and aicut-options.*. Original GEO files are not modified.\nNot a release distribution. Retain upstream licenses and corresponding source before distributing.\n`);
console.log(`GEO enhanced development extension: ${output}`);
