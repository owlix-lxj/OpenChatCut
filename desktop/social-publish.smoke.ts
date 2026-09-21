// Run with Electron after bundling. Uses intercepted in-memory pages only: no account or network.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, session } from 'electron';
import { SOCIAL_PLATFORMS } from '../shared/social-publish.ts';
import { publishPageScript, type PublishPageState } from './social-publish-page.ts';

async function run() {
app.setPath('userData', await mkdtemp(join(tmpdir(), 'aicut-publish-smoke-')));
await app.whenReady();
const watchdog = setTimeout(() => app.exit(1), 35_000);
try {
  const isolated = session.fromPartition('aicut-publish-fixture');
  let markup = '';
  isolated.protocol.handle('https', () => new Response(markup, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  const win = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  for (const p of SOCIAL_PLATFORMS) {
    const placeholder = p.id === 'douyin' ? '填写作品标题' : '填写标题';
    const caption = '发布';
    const bodyClass = p.id === 'douyin' ? 'zone-container' : p.id === 'xiaohongshu' ? 'tiptap' : 'description';
    markup = `<input type="file" accept="video/mp4"><input placeholder="${placeholder}"><div class="${bodyClass}" contenteditable="true">old</div><span id="state">上传成功</span><button onclick="window.clicks=(window.clicks||0)+1;document.getElementById('state').textContent='发布成功'">${caption}</button>`;
    await win.loadURL(p.url);
    const inspect = () => win.webContents.executeJavaScript(publishPageScript(p.id, 'inspect')) as Promise<PublishPageState>;
    assert.equal((await inspect()).ready, true);
    assert.ok((await inspect()).uploadSelector);
    assert.equal((await inspect()).success, false);
    assert.equal(await win.webContents.executeJavaScript(publishPageScript(p.id, 'fill', { title: '草稿测试标题', description: '本地测试，无网络请求。' })), true);
    assert.equal(await win.webContents.executeJavaScript('window.clicks || 0'), 0);
    assert.throws(() => publishPageScript(p.id, 'submit'), /自动发布已禁用/);
    await assert.rejects(() => win.webContents.executeJavaScript(publishPageScript(p.id, 'save-draft')));
    assert.equal(await win.webContents.executeJavaScript('window.clicks || 0'), 0, 'missing draft button must never fall back to publish');
    await win.webContents.executeJavaScript(`const draftButton=document.createElement('button');draftButton.id='draft';draftButton.textContent='保存草稿';draftButton.onclick=()=>{window.drafts=(window.drafts||0)+1;document.getElementById('state').textContent='草稿保存成功'};document.body.append(draftButton)`);
    await win.webContents.executeJavaScript(publishPageScript(p.id, 'fill', { title: '发布成功', description: '扫码登录，正在上传，发布成功，草稿保存成功' }));
    assert.equal((await inspect()).login, false);
    assert.equal((await inspect()).ready, true);
    assert.equal((await inspect()).success, false);
    assert.equal((await inspect()).draftSaved, false, 'caption is not a draft-save receipt');
    await win.webContents.executeJavaScript(`document.getElementById('state').textContent='正在上传'`);
    assert.equal((await inspect()).ready, false);
    await assert.rejects(() => win.webContents.executeJavaScript(publishPageScript(p.id, 'save-draft')));
    await win.webContents.executeJavaScript(`document.getElementById('state').textContent='扫码登录'`);
    assert.equal((await inspect()).login, true);
    assert.equal((await inspect()).ready, false);
    await win.webContents.executeJavaScript(`document.getElementById('state').textContent='上传成功';document.body.append(document.getElementById('draft').cloneNode(true))`);
    await assert.rejects(() => win.webContents.executeJavaScript(publishPageScript(p.id, 'save-draft')));
    await win.webContents.executeJavaScript('document.querySelectorAll("button")[2].remove()');
    await win.webContents.executeJavaScript(publishPageScript(p.id, 'save-draft'));
    assert.equal(await win.webContents.executeJavaScript('window.drafts'), 1);
    assert.equal(await win.webContents.executeJavaScript('window.clicks || 0'), 0);
    assert.equal((await inspect()).draftSaved, true);
    assert.equal((await inspect()).success, false);
    await assert.rejects(() => win.webContents.executeJavaScript(publishPageScript(p.id, 'save-draft')));
    console.log(`${p.name}: draft save, missing/ambiguous draft controls, caption guard, public publish blocked passed`);
  }
  win.destroy();
  clearTimeout(watchdog);
  app.exit(0);
} catch (error) { console.error(error); clearTimeout(watchdog); app.exit(1); }
}
void run().catch(error => { console.error(error); app.exit(1); });
