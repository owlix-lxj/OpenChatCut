import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loadPublishCreator } from './social-publish-navigation.ts';

// All synthetic events. No browser, credentials or external requests.
const creator = 'https://creator.douyin.com/creator-micro/content/upload';
const login = 'https://creator.douyin.com/login.html';
const abort = () => Object.assign(new Error(`ERR_ABORTED (-3) loading '${login}'`), { code: 'ERR_ABORTED', errno: -3 });
class FakeWindow extends EventEmitter {
  destroyed = false;
  url = '';
  loading = true;
  stopped = false;
  load = () => Promise.resolve();
  webContents = Object.assign(new EventEmitter(), {
    getURL: () => this.url,
    isLoadingMainFrame: () => this.loading,
    stop: () => { this.stopped = true; this.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', this.url, true); },
  });
  isDestroyed() { return this.destroyed; }
  loadURL(url: string) { assert.equal(url, creator); return this.load(); }
  finish(url = login) { this.url = url; this.loading = false; this.webContents.emit('did-finish-load'); }
  close() { this.destroyed = true; this.emit('closed'); }
  cleaned() { assert.equal(this.eventNames().length, 0); assert.equal(this.webContents.eventNames().length, 0); }
}

const normal = new FakeWindow();
normal.load = async () => { normal.finish(creator); };
await loadPublishCreator('douyin', normal); normal.cleaned();

const slowResources = new FakeWindow();
slowResources.load = () => new Promise(() => undefined);
const usableDocument = loadPublishCreator('douyin', slowResources, 15);
slowResources.url = creator;
slowResources.webContents.emit('dom-ready');
await usableDocument;
await new Promise(resolve => setTimeout(resolve, 25));
assert.equal(slowResources.stopped, false, 'initial timeout must not stop a DOM-ready upload document');
slowResources.cleaned();

const untrustedDocument = new FakeWindow();
untrustedDocument.load = () => new Promise(() => undefined);
const untrustedDom = assert.rejects(loadPublishCreator('douyin', untrustedDocument), /未授权/);
untrustedDocument.url = 'https://example.test/';
untrustedDocument.webContents.emit('dom-ready');
await untrustedDom; untrustedDocument.cleaned();

const redirected = new FakeWindow();
redirected.load = () => Promise.reject(abort());
let done = false;
const redirectedResult = loadPublishCreator('douyin', redirected).then(() => { done = true; });
await Promise.resolve(); await Promise.resolve();
assert.equal(done, false, 'abort is not success');
redirected.url = login;
redirected.webContents.emit('did-finish-load');
await Promise.resolve();
assert.equal(done, false, 'still-loading main frame is not success');
redirected.finish();
await redirectedResult; redirected.cleaned();

const lateAbort = new FakeWindow();
lateAbort.load = async () => { lateAbort.finish(); throw abort(); };
await loadPublishCreator('douyin', lateAbort); lateAbort.cleaned();

const stalled = new FakeWindow();
stalled.load = () => Promise.reject(abort());
await assert.rejects(loadPublishCreator('douyin', stalled, 15), /登录跳转未完成/);
assert.equal(stalled.stopped, true); stalled.cleaned();

const timedOut = new FakeWindow();
timedOut.load = () => new Promise(() => undefined);
await assert.rejects(loadPublishCreator('douyin', timedOut, 15), /加载超时/); timedOut.cleaned();

const closed = new FakeWindow();
closed.load = () => new Promise(() => undefined);
const closing = assert.rejects(loadPublishCreator('douyin', closed), /窗口已关闭/);
closed.close(); await closing; closed.cleaned();
await assert.rejects(loadPublishCreator('douyin', closed), /窗口已关闭/);

const network = new FakeWindow();
network.load = async () => { throw Object.assign(new Error('ERR_INTERNET_DISCONNECTED'), { errno: -106 }); };
await assert.rejects(loadPublishCreator('douyin', network), /无法加载平台页面/); network.cleaned();

const failedMain = new FakeWindow();
failedMain.load = () => new Promise(() => undefined);
const failing = assert.rejects(loadPublishCreator('douyin', failedMain), /-105/);
failedMain.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', login, true);
await failing; failedMain.cleaned();

const childFailure = new FakeWindow();
childFailure.load = () => new Promise(() => undefined);
const childResult = loadPublishCreator('douyin', childFailure);
childFailure.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://example.test', false);
childFailure.finish(); await childResult; childFailure.cleaned();

const untrusted = new FakeWindow();
untrusted.load = () => new Promise(() => undefined);
const blocked = assert.rejects(loadPublishCreator('douyin', untrusted), /未授权/);
untrusted.finish('https://example.test/login.html'); await blocked; untrusted.cleaned();

const crashed = new FakeWindow();
crashed.load = () => new Promise(() => undefined);
const crash = assert.rejects(loadPublishCreator('douyin', crashed), /进程已退出/);
crashed.webContents.emit('render-process-gone'); await crash; crashed.cleaned();
console.log('publish navigation: redirect/late abort, load failure, timeout, close, crash, subframe and origin checks passed');
