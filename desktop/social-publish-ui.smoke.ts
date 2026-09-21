/** Isolated renderer fixture: no real accounts, IPC, files or external uploads. */
import assert from 'node:assert/strict';
import { app, BrowserWindow, session } from 'electron';
import { build } from 'esbuild';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function run() {
const profile = await mkdtemp(join(tmpdir(), 'aicut-publish-ui-'));
app.setPath('userData', profile);
await app.whenReady();
const watchdog = setTimeout(() => { console.error('UI fixture timed out'); app.exit(1); }, 20_000);
let win: BrowserWindow | undefined;
try {
  const bundle = await build({ bundle: true, write: false, format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' },
    plugins: [{ name: 'synthetic-history', setup(b) {
      b.onResolve({ filter: /exportHistoryStore$/ }, () => ({ path: 'history', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export async function listExportHistory(){return []}' }));
    } }],
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import { createRoot } from 'react-dom/client';
      import { SocialPublishPanel } from './src/export/SocialPublishPanel';
      window.openChatCutDesktop = { socialPublish: {
        snapshot: async () => ({ accounts: [{platform:'douyin',state:'available',username:'测试账号'}], jobs:[],
          bridge: {ready:true,videoPlatforms:['douyin'],detail:'GEO should never be shown'} }),
        chooseFile: async () => ({id:'synthetic',name:'fixture.mp4',size:1024}),
        prepare: () => new Promise((resolve,reject) => { window.finishOpening = fail => fail ? reject(new Error('测试：打开平台失败')) : resolve(); }),
      }};
      createRoot(document.getElementById('root')).render(<SocialPublishPanel projectName="隔离界面测试" />);
    ` },
  });
  const css = await readFile(resolve('src/export/socialPublish.css'), 'utf8');
  const isolated = session.fromPartition('publish-ui-fixture');
  isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, callback) => callback({ cancel: true }));
  win = new BrowserWindow({ show: false, width: 1000, height: 850, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8">
    <style>:root{--cc-panel:#191919;--cc-panel-alt:#222;--cc-bg:#111;--cc-text:#eee;--cc-text-dim:#aaa;--cc-border:#444;--cc-accent:#d87532}body{background:#111;color:#eee;font-family:system-ui}main{width:700px;margin:auto}${css}</style>
    <div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`));
  const evaluate = <T>(expression: string): Promise<T> => win!.webContents.executeJavaScript(expression);
  async function until(expression: string) {
    const deadline = Date.now() + 5000;
    while (!await evaluate<boolean>(expression)) {
      if (Date.now() > deadline) throw new Error(`UI fixture timeout: ${expression}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  await until(`!!document.querySelector('.cc-publish-account input:not(:disabled)')`);
  assert.equal(await evaluate(`document.body.innerText.includes('GEO') || document.body.innerText.includes('草稿任务')`), false);
  await evaluate(`document.querySelector('.cc-publish-file button').click()`);
  await until(`document.body.innerText.includes('fixture.mp4') && !document.querySelector('.cc-publish-account input').disabled`);
  await evaluate(`document.querySelector('.cc-publish-account input').click()`);
  await until(`!document.querySelector('.cc-publish-submit button').disabled`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.cc-publish-submit')).justifyContent`), 'center');
  for (const failure of [false, true]) {
    await evaluate(`document.querySelector('.cc-publish-submit button').click()`);
    await until(`!!document.querySelector('dialog:modal')`);
    assert.equal(await evaluate(`document.querySelector('dialog').parentElement === document.body`), true, 'loader must be outside scrolling export panel');
    assert.equal(await evaluate(`document.querySelector('dialog').dispatchEvent(new Event('cancel',{cancelable:true}))`), false, 'Escape must not dismiss a still-pending operation');
    await evaluate(`window.finishOpening(${failure})`);
    await until(`!document.querySelector('dialog') && !document.querySelector('.cc-publish-submit button').disabled`);
    if (failure) assert.match(await evaluate<string>(`document.querySelector('[role=alert]').textContent`), /打开平台失败/);
  }
  console.log('Isolated Electron UI: centered CTA, no GEO/history, global modal, blocked cancel, success/failure dismissal passed; no real upload');
  app.exit(0);
} catch (error) {
  console.error(error);
  app.exit(1);
} finally { clearTimeout(watchdog); if (win && !win.isDestroyed()) win.destroy(); }
}
void run().catch(error => { console.error(error); app.exit(1); });
