import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBundledBrowser } from './packaged-runtime.ts';

const TIMEOUT_MS = 75_000;

interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

interface PageSnapshot {
  readonly title?: string;
  readonly sources?: readonly string[];
  readonly resources?: readonly string[];
}

function browserExecutable(): string {
  if (process.env.CC_BROWSER_EXECUTABLE) return process.env.CC_BROWSER_EXECUTABLE;
  const roots = [
    join(process.cwd(), 'desktop-dist', 'chrome-headless-shell'),
    join(process.cwd(), 'node_modules', '.remotion', 'chrome-headless-shell'),
    join(process.resourcesPath ?? '', 'chrome-headless-shell'),
  ];
  for (const root of roots) {
    const found = findBundledBrowser(root);
    if (found) return found;
  }
  throw new Error('bundled Chrome resolver is unavailable');
}

function videoCandidate(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:'
      && !host.endsWith('douyinstatic.com')
      && (host.endsWith('douyinvod.com') || /\/video\/tos\//i.test(url.pathname));
  } catch {
    return false;
  }
}

function targetCandidate(value: string, videoId: string): boolean {
  try {
    const url = new URL(value);
    return url.searchParams.get('__vid') === videoId || url.searchParams.get('video_id') === videoId;
  } catch {
    return false;
  }
}

async function pageWebSocket(browserWs: string): Promise<string> {
  const endpoint = new URL(browserWs);
  const listUrl = `http://${endpoint.hostname}:${endpoint.port}/json/list`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const targets = await fetch(listUrl).then((response) => response.json()).catch(() => []) as Array<{
      type?: string; webSocketDebuggerUrl?: string;
    }>;
    const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('bundled Chrome did not expose a page target');
}

async function connectCdp(url: string): Promise<{
  evaluate: () => Promise<PageSnapshot>;
  reload: () => Promise<void>;
  candidates: () => readonly string[];
  close: () => void;
}> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome debugger connection timed out')), 5_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome debugger connection failed')); }, { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const networkCandidates: string[] = [];
  socket.addEventListener('message', (event) => {
    try {
      const raw = typeof event.data === 'string'
        ? event.data
        : Buffer.from(event.data as ArrayBuffer).toString('utf8');
      const message = JSON.parse(raw) as CdpMessage;
      if (!message.id) {
        if (message.method === 'Network.requestWillBeSent') {
          const request = message.params?.request as { url?: unknown } | undefined;
          if (typeof request?.url === 'string' && videoCandidate(request.url)
            && !networkCandidates.includes(request.url)) networkCandidates.push(request.url);
        } else if (message.method === 'Network.responseReceived') {
          const response = message.params?.response as { url?: unknown } | undefined;
          if (typeof response?.url === 'string' && videoCandidate(response.url)
            && !networkCandidates.includes(response.url)) networkCandidates.push(response.url);
        }
        return;
      }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? 'Chrome debugger command failed'));
      else waiter.resolve(message.result);
    } catch { /* ignore unrelated debugger events */ }
  });
  const command = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    const id = nextId++;
    const result = Promise.withResolvers<unknown>();
    pending.set(id, result);
    socket.send(JSON.stringify({ id, method, params }));
    return result.promise;
  };
  await command('Runtime.enable');
  await command('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
  await command('Page.enable');
  return {
    evaluate: async () => {
      const response = await command('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => {
          const videos = Array.from(document.querySelectorAll('video'));
          for (const video of videos) {
            video.muted = true;
            video.playsInline = true;
            if (video.paused) void video.play().catch(() => {});
          }
          return {
            title: document.title || document.querySelector('meta[name="description"]')?.content || '',
            sources: videos.map((video) => video.currentSrc || video.src || video.querySelector('source')?.src || ''),
            resources: performance.getEntriesByType('resource').map((entry) => entry.name),
          };
        })()`,
      }) as { result?: { value?: PageSnapshot } };
      return response.result?.value ?? {};
    },
    reload: async () => { await command('Page.reload', { ignoreCache: true }); },
    candidates: () => networkCandidates,
    close: () => socket.close(),
  };
}

/** Resolve a current Douyin post with the Chrome already bundled for local rendering. */
export async function resolveWithBundledChrome(canonicalUrl: string, videoId = ''): Promise<{
  url: string;
  title: string;
}> {
  const profile = await mkdtemp(join(tmpdir(), 'aicut-chrome-resolver-'));
  const child = spawn(browserExecutable(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
    '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, canonicalUrl,
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  const browserWs = Promise.withResolvers<string>();
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8_000);
    const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
    if (match?.[1]) browserWs.resolve(match[1]);
  });
  child.once('error', browserWs.reject);
  const timeout = setTimeout(() => child.kill(), TIMEOUT_MS + 10_000);
  let cdp: Awaited<ReturnType<typeof connectCdp>> | undefined;
  try {
    const ws = await Promise.race([
      browserWs.promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('bundled Chrome failed to start')), 10_000)),
    ]);
    cdp = await connectCdp(await pageWebSocket(ws));
    const startedAt = Date.now();
    let reloaded = false;
    for (;;) {
      const page: PageSnapshot = await cdp.evaluate().catch(() => ({}));
      const candidates = [
        ...cdp.candidates(),
        ...(page.sources ?? []),
        ...(page.resources ?? []),
      ].filter(videoCandidate);
      const source = videoId
        ? candidates.findLast((candidate) => targetCandidate(candidate, videoId))
        : candidates.at(-1);
      if (source) return { url: source, title: page.title ?? '' };
      if (!reloaded && Date.now() - startedAt >= 20_000) {
        reloaded = true;
        await cdp.reload().catch(() => undefined);
      }
      if (Date.now() - startedAt >= TIMEOUT_MS) {
        throw new Error(`bundled Chrome captured no target stream: ${stderr.slice(-500)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    clearTimeout(timeout);
    cdp?.close();
    child.kill();
    await rm(profile, { recursive: true, force: true });
  }
}
