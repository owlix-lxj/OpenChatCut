// shared/social-publish.ts
var SOCIAL_PLATFORMS = [
  { id: "douyin", name: "\u6296\u97F3", url: "https://creator.douyin.com/creator-micro/content/upload", host: "creator.douyin.com", titleLimit: 30 },
  { id: "xiaohongshu", name: "\u5C0F\u7EA2\u4E66", url: "https://creator.xiaohongshu.com/publish/publish?from=homepage&target=video", host: "creator.xiaohongshu.com", titleLimit: 20 }
];
function socialPlatform(value) {
  const result = SOCIAL_PLATFORMS.find((p) => p.id === value);
  if (!result) throw new Error("\u4E0D\u652F\u6301\u7684\u89C6\u9891\u53D1\u5E03\u5E73\u53F0");
  return result;
}
function validatePublishDraft(value) {
  if (!value || typeof value !== "object") throw new Error("\u65E0\u6548\u7684\u53D1\u5E03\u5185\u5BB9");
  const d = value;
  if (typeof d.fileId !== "string" || !d.fileId || !Array.isArray(d.platforms) || d.platforms.length < 1 || d.platforms.length > SOCIAL_PLATFORMS.length || new Set(d.platforms).size !== d.platforms.length)
    throw new Error("\u8BF7\u9009\u62E9\u89C6\u9891\u548C\u53D1\u5E03\u5E73\u53F0");
  if (typeof d.title !== "string" || !d.title.trim() || typeof d.description !== "string" || d.description.length > 1e3)
    throw new Error("\u8BF7\u586B\u5199\u6807\u9898\uFF0C\u6B63\u6587\u4E0D\u5F97\u8D85\u8FC7 1000 \u5B57");
  const title = d.title.trim();
  for (const id of d.platforms) {
    const p = socialPlatform(id);
    if (Array.from(title).length > p.titleLimit) throw new Error(`${p.name}\u6807\u9898\u6700\u591A ${p.titleLimit} \u5B57`);
  }
  return { fileId: d.fileId, platforms: [...d.platforms], title, description: d.description.trim() };
}
function activePublishPhase(phase) {
  return ["preparing", "uploading", "review", "saving_draft", "submitting"].includes(phase);
}
function allowedPublishNavigation(platform, value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && u.hostname === socialPlatform(platform).host;
  } catch {
    return false;
  }
}

// desktop/social-publish-page.ts
var SELECTORS = {
  douyin: { title: 'input[placeholder*="\u586B\u5199\u4F5C\u54C1\u6807\u9898"]', body: 'div.zone-container[contenteditable="true"]', button: "\u53D1\u5E03" },
  xiaohongshu: { title: 'input[placeholder*="\u586B\u5199\u6807\u9898"]', body: '.tiptap[contenteditable="true"], .ProseMirror[contenteditable="true"], #post-textarea', button: "\u53D1\u5E03" }
};
function publishPageScript(platform, action, draft) {
  if (action === "submit") throw new Error("\u81EA\u52A8\u53D1\u5E03\u5DF2\u7981\u7528\uFF0C\u4EC5\u652F\u6301\u4FDD\u5B58\u8349\u7A3F");
  const config = { ...SELECTORS[platform], host: socialPlatform(platform).host, platform, action, draft };
  return `(() => {
    const c = ${JSON.stringify(config)};
    if (location.protocol !== 'https:' || location.hostname !== c.host) throw new Error('\u5E73\u53F0\u9875\u9762\u4E0D\u5339\u914D');
    const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    // Ignore user-entered captions/titles and hidden templates when reading platform status.
    // A caption saying "\u53D1\u5E03\u6210\u529F" must never be mistaken for a successful submission.
    const parts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (visible(parent) && !parent.closest('input, textarea, select, [contenteditable], script, style, noscript')) parts.push(node.textContent);
    }
    const text = parts.join('').replace(/\\s+/g, '');
    const login = /\u626B\u7801\u767B\u5F55|\u624B\u673A\u53F7\u767B\u5F55|\u8BF7\u5148\u767B\u5F55|\u5FAE\u4FE1\u626B\u7801\u767B\u5F55|\u521B\u4F5C\u8005\u767B\u5F55/.test(text) || /\\/login(?:[./?]|$)/.test(location.pathname);
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(el => visible(el) && /^(\u4FDD\u5B58\u8349\u7A3F|\u5B58\u8349\u7A3F|\u4FDD\u5B58\u5230\u8349\u7A3F|\u4FDD\u5B58\u81F3\u8349\u7A3F)$/.test(el.textContent.trim()) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    const titles = [...document.querySelectorAll(c.title)].filter(visible);
    const bodies = [...document.querySelectorAll(c.body)].filter(visible);
    const videoInputs = [...document.querySelectorAll('input[type="file"]')].filter(el => {
      const accept = el.getAttribute('accept') || '';
      return /video|\\.mp4|\\.mov/i.test(accept) && !/image/i.test(accept);
    });
    const uploadSelector = videoInputs.length === 1 ? 'input[type="file"][data-aicut-video-upload="selected"]' : null;
    document.querySelectorAll('[data-aicut-video-upload]').forEach(el => el.removeAttribute('data-aicut-video-upload'));
    if (uploadSelector) videoInputs[0].setAttribute('data-aicut-video-upload', 'selected');
    const uploaded = /\u91CD\u65B0\u4E0A\u4F20|\u4E0A\u4F20\u6210\u529F|\u7F16\u8F91\u5C01\u9762|\u66F4\u6362\u89C6\u9891/.test(text);
    const busy = /\u4E0A\u4F20\u4E2D|\u6B63\u5728\u4E0A\u4F20|\u8F6C\u7801\u4E2D|\u5904\u7406\u4E2D|\u6B63\u5728\u5904\u7406/.test(text);
    const failed = /\u4E0A\u4F20\u5931\u8D25|\u53D1\u5E03\u5931\u8D25|\u53D1\u8868\u5931\u8D25|\u8F6C\u7801\u5931\u8D25|\u8349\u7A3F\u4FDD\u5B58\u5931\u8D25|\u4FDD\u5B58\u8349\u7A3F\u5931\u8D25/.test(text);
    const ready = !login && !busy && !failed && uploaded;
    const success = !login && /\u53D1\u5E03\u6210\u529F|\u53D1\u8868\u6210\u529F/.test(text);
    const draftSaved = !login && !failed && /\u8349\u7A3F\u4FDD\u5B58\u6210\u529F|\u4FDD\u5B58\u8349\u7A3F\u6210\u529F|\u5DF2\u4FDD\u5B58\u81F3\u8349\u7A3F|\u5DF2\u4FDD\u5B58\u5230\u8349\u7A3F|\u5DF2\u5B58\u5165\u8349\u7A3F/.test(text);
    if (c.action === 'fill') {
      if (!ready || titles.length !== 1 || bodies.length !== 1) return false;
      const title = titles[0];
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(title, c.draft.title);
      title.dispatchEvent(new Event('input', {bubbles: true}));
      title.dispatchEvent(new Event('change', {bubbles: true}));
      const body = bodies[0];
      body.focus();
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, c.draft.description);
      body.dispatchEvent(new Event('input', {bubbles: true}));
      body.blur();
      return title.value === c.draft.title && body.innerText.trim() === c.draft.description.trim();
    }
    if (c.action === 'save-draft') {
      if (!ready || draftSaved || success || buttons.length !== 1) throw new Error('\u65E0\u6CD5\u786E\u8BA4\u552F\u4E00\u7684\u4FDD\u5B58\u8349\u7A3F\u6309\u94AE\uFF0C\u8BF7\u5728\u5E73\u53F0\u624B\u52A8\u6838\u5BF9\uFF1B\u4E0D\u4F1A\u70B9\u51FB\u53D1\u5E03');
      buttons[0].click();
      return true;
    }
    return {login, uploadSelector, ready, success, draftSaved, failed};
  })()`;
}

// desktop/geo-video-adapter.ts
var STORE = "aicutVideoJobs";
function videoFailureDetail(error) {
  const message = error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "\u672A\u8FD4\u56DE\u5177\u4F53\u9519\u8BEF";
  return message.replace(/\b(?:https?|wss?|file):\/\/[^\s"'<>]+/gi, "[\u5730\u5740\u5DF2\u9690\u85CF]").replace(/(?:\/(?:Users|home|private|var)\/|[A-Za-z]:\\)[^\n"'<>]+/g, "[\u672C\u673A\u8DEF\u5F84\u5DF2\u9690\u85CF]").replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[\u6807\u8BC6\u5DF2\u9690\u85CF]").replace(/[\r\n\t]/g, " ").slice(0, 400);
}
var GeoVideoAdapter = class {
  chrome;
  jobs = /* @__PURE__ */ new Map();
  retiredJobs = [];
  attached = /* @__PURE__ */ new Set();
  loaded;
  writes = Promise.resolve();
  pollMs;
  timeoutMs;
  workers = /* @__PURE__ */ new Set();
  constructor(chrome, options = {}) {
    this.chrome = chrome;
    this.pollMs = options.pollMs ?? 1500;
    this.timeoutMs = options.timeoutMs ?? 10 * 6e4;
    this.loaded = this.restore();
    void this.loaded.catch(() => void 0);
    chrome.debugger.onDetach.addListener(({ tabId }) => {
      if (tabId == null || !this.attached.delete(tabId)) return;
      for (const job of this.jobs.values()) if (job.tabId === tabId && activePublishPhase(job.phase)) {
        void this.update(job, "unknown", "\u6D4F\u89C8\u5668\u8C03\u8BD5\u8FDE\u63A5\u5DF2\u5173\u95ED\uFF0C\u8BF7\u5230\u5E73\u53F0\u6838\u5BF9\uFF1B\u4E0D\u4F1A\u81EA\u52A8\u91CD\u65B0\u63D0\u4EA4\u3002").catch(() => void 0);
      }
    });
  }
  async restore() {
    const saved = (await this.chrome.storage.local.get(STORE))[STORE];
    if (saved !== void 0 && !Array.isArray(saved)) throw new Error("\u5E73\u53F0\u4E0A\u4F20\u8BB0\u5F55\u635F\u574F\uFF0C\u8BF7\u4FDD\u7559\u8BB0\u5F55\u5E76\u91CD\u542F\u5E94\u7528\u68C0\u67E5");
    this.retiredJobs = (saved ?? []).filter((row) => row && row.platform === "channels").map(({ tabId: _tabId, ...row }) => row);
    for (const row of saved ?? []) {
      if (!row || typeof row.id !== "string" || !SOCIAL_PLATFORMS.some((p) => p.id === row.platform) || !["preparing", "uploading", "review", "saving_draft", "drafted", "submitting", "published", "failed", "cancelled", "unknown"].includes(row.phase)) continue;
      this.jobs.set(row.id, {
        id: row.id,
        platform: row.platform,
        phase: row.phase,
        detail: typeof row.detail === "string" ? row.detail.slice(0, 2e3) : "\u8BF7\u5230\u5E73\u53F0\u6838\u5BF9\u4EFB\u52A1\u8BB0\u5F55",
        revision: (Number.isSafeInteger(row.revision) ? row.revision : 0) + 1,
        ...activePublishPhase(row.phase) ? { phase: "unknown", detail: "\u5E94\u7528\u5185\u53D1\u5E03\u670D\u52A1\u5DF2\u91CD\u542F\uFF0C\u8BF7\u6838\u5BF9\u539F\u5E73\u53F0\u8349\u7A3F\u6216\u63D0\u4EA4\u7ED3\u679C\uFF1B\u4E0D\u4F1A\u81EA\u52A8\u91CD\u53D1\u3002" } : {}
      });
    }
    await this.persist();
  }
  persist() {
    const rows = [...[...this.jobs.values()].map(({ tabId: _tabId, windowOpened: _windowOpened, ...record }) => record), ...this.retiredJobs];
    const write = this.writes.then(() => this.chrome.storage.local.set({ [STORE]: rows }));
    this.writes = write.catch(() => void 0);
    return write;
  }
  async update(job, phase, detail) {
    if ((job.phase === "cancelled" || job.phase === "unknown") && phase !== job.phase) return;
    Object.assign(job, { phase, detail, revision: job.revision + 1 });
    await this.persist();
  }
  async tab(job) {
    if (job.tabId == null) throw new Error("\u539F\u5E73\u53F0\u9875\u9762\u4E0D\u5B58\u5728\uFF0C\u8BF7\u5148\u6838\u5BF9\u5E73\u53F0\u8349\u7A3F");
    const tab = await this.chrome.tabs.get(job.tabId);
    if (tab.status === "loading" && (!tab.url || tab.url === "about:blank")) return tab;
    if (!allowedPublishNavigation(job.platform, tab.url ?? "")) throw new Error("\u5E73\u53F0\u9875\u9762\u5DF2\u79BB\u5F00\u53D7\u4FE1\u521B\u4F5C\u8005\u57DF\u540D\uFF0C\u5DF2\u505C\u6B62\u81EA\u52A8\u64CD\u4F5C");
    return tab;
  }
  async command(job, method, params) {
    const tab = await this.tab(job);
    if (tab.status === "loading") throw new Error("\u5E73\u53F0\u9875\u9762\u6B63\u5728\u52A0\u8F7D\uFF0C\u8BF7\u7A0D\u540E\u6838\u5BF9");
    return await this.chrome.debugger.sendCommand({ tabId: job.tabId }, method, params);
  }
  async evaluate(job, action, draft) {
    const result = await this.command(job, "Runtime.evaluate", {
      expression: publishPageScript(job.platform, action, draft),
      returnByValue: true,
      awaitPromise: true,
      userGesture: action === "save-draft"
    });
    if (result.exceptionDetails || result.result?.value === void 0) throw new Error("\u5E73\u53F0\u9875\u9762\u672A\u5C31\u7EEA\u6216\u7ED3\u6784\u5DF2\u53D8\u5316\uFF0C\u8BF7\u6253\u5F00\u5E73\u53F0\u6838\u5BF9");
    return result.result.value;
  }
  async detach(job) {
    if (job.tabId == null || !this.attached.delete(job.tabId)) return;
    await this.chrome.debugger.detach({ tabId: job.tabId }).catch(() => void 0);
  }
  async attach(job) {
    await this.tab(job);
    if (this.attached.has(job.tabId)) return;
    await this.chrome.debugger.attach({ tabId: job.tabId }, "1.3");
    this.attached.add(job.tabId);
  }
  pause() {
    return new Promise((resolve) => setTimeout(resolve, this.pollMs));
  }
  async prepare(job, input) {
    this.workers.add(job.id);
    let stage = "\u6253\u5F00\u5E73\u53F0\u9875\u9762";
    try {
      const tab = await this.chrome.tabs.create({ url: socialPlatform(job.platform).url, active: false });
      if (tab.id == null) throw new Error("\u65E0\u6CD5\u6253\u5F00\u5E73\u53F0\u9875\u9762");
      job.tabId = tab.id;
      if (!activePublishPhase(job.phase)) return;
      await this.persist();
      const deadline = Date.now() + this.timeoutMs;
      let uploaded = false;
      while (Date.now() < deadline && ["preparing", "uploading"].includes(job.phase)) {
        stage = "\u7B49\u5F85\u5E73\u53F0\u9875\u9762";
        const tab2 = await this.tab(job);
        if (tab2.status === "loading") {
          await this.pause();
          continue;
        }
        if (!activePublishPhase(job.phase)) return;
        if (!job.windowOpened) {
          await this.chrome.tabs.update(job.tabId, { active: true });
          job.windowOpened = true;
          await this.update(job, job.phase, "\u5E73\u53F0\u9875\u9762\u5DF2\u6253\u5F00\uFF0C\u6B63\u5728\u51C6\u5907\u4E0A\u4F20\u3002");
        }
        stage = "\u8FDE\u63A5\u5E73\u53F0\u9875\u9762";
        await this.attach(job);
        stage = "\u8BC6\u522B\u4E0A\u4F20\u8868\u5355";
        const page = await this.evaluate(job, "inspect");
        if (!["preparing", "uploading"].includes(job.phase)) return;
        if (page.login) {
          if (job.detail !== "\u8BF7\u6253\u5F00\u5E73\u53F0\u9875\u9762\u5B8C\u6210\u767B\u5F55\uFF0C\u5B8C\u6210\u540E\u4F1A\u7EE7\u7EED\u4E0A\u4F20\u3002") {
            await this.update(job, "preparing", "\u8BF7\u6253\u5F00\u5E73\u53F0\u9875\u9762\u5B8C\u6210\u767B\u5F55\uFF0C\u5B8C\u6210\u540E\u4F1A\u7EE7\u7EED\u4E0A\u4F20\u3002");
            await this.chrome.tabs.update(job.tabId, { active: true });
          }
        } else if (!uploaded && page.uploadSelector) {
          stage = "\u5B9A\u4F4D\u89C6\u9891\u4E0A\u4F20\u63A7\u4EF6";
          const { root } = await this.command(job, "DOM.getDocument");
          const { nodeId } = await this.command(job, "DOM.querySelector", { nodeId: root.nodeId, selector: page.uploadSelector });
          if (!nodeId) throw new Error("\u672A\u627E\u5230\u89C6\u9891\u4E0A\u4F20\u63A7\u4EF6");
          await this.update(job, "uploading", "\u6B63\u5728\u901A\u8FC7\u6D4F\u89C8\u5668\u4E0A\u4F20\u89C6\u9891\uFF1B\u8BF7\u4FDD\u6301\u5E94\u7528\u4E0E\u6D4F\u89C8\u5668\u5F00\u542F\uFF0C\u65AD\u8FDE\u540E\u5148\u6838\u5BF9\u5E73\u53F0\u8349\u7A3F\u3002");
          if (job.phase !== "uploading") return;
          await this.chrome.tabs.update(job.tabId, { active: true });
          stage = "\u6307\u5B9A\u89C6\u9891\u6587\u4EF6";
          await this.command(job, "DOM.setFileInputFiles", { nodeId, files: [input.path] });
          uploaded = true;
        } else if (uploaded && page.failed) {
          throw new Error("\u5E73\u53F0\u63D0\u793A\u4E0A\u4F20\u6216\u8F6C\u7801\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u89C6\u9891\u4E0E\u7F51\u7EDC");
        } else if (uploaded && page.ready) {
          stage = "\u586B\u5199\u89C6\u9891\u6587\u6848";
          const filled = await this.evaluate(job, "fill", input);
          await this.update(job, "review", filled ? "\u89C6\u9891\u5DF2\u4E0A\u4F20\u5E76\u586B\u5199\u6587\u6848\uFF0C\u8BF7\u6838\u5BF9\u540E\u4FDD\u5B58\u5230\u5E73\u53F0\u8349\u7A3F\uFF1B\u4E0D\u4F1A\u81EA\u52A8\u53D1\u5E03\u3002" : "\u89C6\u9891\u5DF2\u4E0A\u4F20\uFF1B\u8BF7\u5728\u5E73\u53F0\u9875\u8865\u5168\u6587\u6848\u540E\u4FDD\u5B58\u8349\u7A3F\uFF1B\u4E0D\u4F1A\u81EA\u52A8\u53D1\u5E03\u3002");
          await this.chrome.tabs.update(job.tabId, { active: true });
          return;
        }
        await this.pause();
      }
      if (["preparing", "uploading"].includes(job.phase)) throw new Error("\u7B49\u5F85\u4E0A\u4F20\u8D85\u65F6\uFF0C\u8BF7\u6838\u5BF9\u5E73\u53F0\u8349\u7A3F\uFF1B\u4E0D\u4F1A\u81EA\u52A8\u91CD\u4F20");
    } catch (error) {
      await this.update(job, "failed", `\u89C6\u9891\u4E0A\u4F20\u5931\u8D25\uFF08${stage}\uFF09\uFF1A${videoFailureDetail(error)}`).catch(() => void 0);
    } finally {
      this.workers.delete(job.id);
      if (job.phase !== "review") await this.detach(job);
    }
  }
  async observeDraft(job) {
    this.workers.add(job.id);
    try {
      const deadline = Date.now() + Math.min(this.timeoutMs, 9e4);
      while (Date.now() < deadline && job.phase === "saving_draft") {
        const page = await this.evaluate(job, "inspect");
        if (page.draftSaved) {
          await this.update(job, "drafted", "\u5E73\u53F0\u5DF2\u786E\u8BA4\u4FDD\u5B58\u8349\u7A3F\uFF0C\u672A\u6267\u884C\u53D1\u5E03\u3002");
          return;
        }
        if (page.failed) break;
        await this.pause();
      }
      await this.update(job, "unknown", "\u672A\u786E\u8BA4\u8349\u7A3F\u4FDD\u5B58\u7ED3\u679C\uFF0C\u8BF7\u5230\u5E73\u53F0\u8349\u7A3F\u7BB1\u6838\u5BF9\uFF1B\u4E0D\u4F1A\u81EA\u52A8\u91CD\u8BD5\u3002");
    } catch {
      await this.update(job, "unknown", "\u5E73\u53F0\u9875\u9762\u4E2D\u65AD\uFF0C\u8349\u7A3F\u4FDD\u5B58\u7ED3\u679C\u5F85\u6838\u5BF9\uFF1B\u4E0D\u4F1A\u81EA\u52A8\u91CD\u8BD5\u3002").catch(() => void 0);
    } finally {
      this.workers.delete(job.id);
      await this.detach(job);
    }
  }
  async handle(method, value) {
    if (method === "aicut.submitVideo") throw new Error("\u81EA\u52A8\u53D1\u5E03\u5DF2\u7981\u7528\uFF0C\u4EC5\u652F\u6301\u4FDD\u5B58\u8349\u7A3F");
    await this.loaded;
    if (!value || typeof value !== "object") throw new Error("\u65E0\u6548\u7684\u89C6\u9891\u8BF7\u6C42");
    const input = value;
    if (typeof input.jobId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(input.jobId)) throw new Error("\u65E0\u6548\u4EFB\u52A1\u7F16\u53F7");
    if (method === "aicut.prepareVideo") {
      const previous = this.jobs.get(input.jobId);
      if (previous) return { ...previous };
      const { platforms } = validatePublishDraft({ fileId: input.jobId, platforms: [input.platform], title: input.title, description: input.description });
      if (typeof input.path !== "string" || !/^(\/|[A-Za-z]:[\\/])/.test(input.path) || /[\x00\r\n]/.test(input.path) || !/\.(mp4|mov|webm)$/i.test(input.path)) throw new Error("\u65E0\u6548\u7684\u672C\u673A\u89C6\u9891\u6388\u6743\u8DEF\u5F84");
      if ([...this.jobs.values()].some((job3) => job3.platform === input.platform && (activePublishPhase(job3.phase) || this.workers.has(job3.id)))) throw new Error("\u6B64\u5E73\u53F0\u8FD8\u6709\u672A\u7ED3\u675F\u7684\u4EFB\u52A1");
      if (this.jobs.size >= 1e3) throw new Error("\u53D1\u5E03\u8BB0\u5F55\u5DF2\u6EE1\uFF0C\u8BF7\u5148\u5F52\u6863\u8BB0\u5F55");
      const job2 = { id: input.jobId, platform: platforms[0], phase: "preparing", detail: "\u6B63\u5728\u6253\u5F00\u5E73\u53F0\u89C6\u9891\u4E0A\u4F20\u9875", revision: 0 };
      this.jobs.set(job2.id, job2);
      await this.persist();
      void this.prepare(job2, input);
      return { ...job2 };
    }
    const job = this.jobs.get(input.jobId);
    if (!job) throw new Error("\u672A\u627E\u5230\u6B64\u4E0A\u4F20\u4EFB\u52A1\uFF0C\u8BF7\u5230\u5E73\u53F0\u6838\u5BF9\u539F\u8349\u7A3F");
    if (method === "aicut.videoStatus") return { ...job };
    if (method === "aicut.reviewVideo") {
      await this.tab(job);
      await this.chrome.tabs.update(job.tabId, { active: true });
      return { ...job };
    }
    if (method === "aicut.cancelVideo") {
      if (job.phase === "submitting" || job.phase === "saving_draft") throw new Error("\u4FDD\u5B58\u4E2D\u7684\u4EFB\u52A1\u4E0D\u53EF\u53D6\u6D88\uFF0C\u8BF7\u5230\u5E73\u53F0\u6838\u5BF9");
      if (activePublishPhase(job.phase)) await this.update(job, "cancelled", "\u5DF2\u505C\u6B62\u4EFB\u52A1\uFF1B\u5E73\u53F0\u5DF2\u4E0A\u4F20\u8349\u7A3F\u672A\u5220\u9664\u3002");
      await this.detach(job);
      return { ...job };
    }
    if (method === "aicut.saveDraft") {
      if (job.phase !== "review") throw new Error("\u6B64\u4EFB\u52A1\u5F53\u524D\u4E0D\u80FD\u4FDD\u5B58\u8349\u7A3F");
      await this.update(job, "saving_draft", "\u6B63\u5728\u4FDD\u5B58\u5230\u5E73\u53F0\u8349\u7A3F\uFF0C\u8BF7\u52FF\u91CD\u590D\u64CD\u4F5C\u3002");
      try {
        await this.attach(job);
        const page = await this.evaluate(job, "inspect");
        if (!page.ready || page.success || page.draftSaved) throw new Error("\u5E73\u53F0\u672A\u5C31\u7EEA\u6216\u5DF2\u6709\u6210\u529F\u63D0\u793A\uFF0C\u8BF7\u5148\u6838\u5BF9\u7ED3\u679C");
        await this.evaluate(job, "save-draft");
        void this.observeDraft(job);
      } catch {
        await this.update(job, "unknown", "\u65E0\u6CD5\u786E\u8BA4\u8349\u7A3F\u5DF2\u4FDD\u5B58\uFF0C\u8BF7\u6253\u5F00\u5E73\u53F0\u8349\u7A3F\u7BB1\u6838\u5BF9\uFF1B\u4E0D\u4F1A\u70B9\u51FB\u53D1\u5E03\u6216\u81EA\u52A8\u91CD\u8BD5\u3002");
        await this.detach(job);
      }
      return { ...job };
    }
    throw new Error("\u672A\u77E5\u7684\u89C6\u9891\u64CD\u4F5C");
  }
};
export {
  GeoVideoAdapter,
  videoFailureDetail
};
