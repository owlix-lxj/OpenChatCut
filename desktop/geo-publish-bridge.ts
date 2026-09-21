import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

// GEO's Wechatsync wire protocol: { id, method, token, params } -> { id, result, error }.
// This local transport deliberately omits GEO's unauthenticated HTTP /request endpoint.
const METHODS = new Set([
  'checkAuth', 'listPlatforms', 'aicut.capabilities', 'aicut.ping', 'aicut.openAccount',
  'aicut.prepareVideo', 'aicut.videoStatus', 'aicut.reviewVideo', 'aicut.saveDraft', 'aicut.cancelVideo',
]);
type Pending = {
  socket: WebSocket;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export interface GeoBridgeOptions {
  token: string;
  port?: number;
  extensionId?: string;
  requestTimeoutMs?: number;
  internal?: boolean;
}
export class GeoPublishBridge {
  private server: Server;
  private wss: WebSocketServer;
  private socket: WebSocket | undefined;
  private pending = new Map<string, Pending>();
  private options: GeoBridgeOptions;
  private port: number | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private alive = false;
  private started = false;
  private closed = false;

  static createToken(): string { return randomBytes(32).toString('hex'); }

  constructor(options: GeoBridgeOptions) {
    if (!/^[a-f0-9]{64}$/.test(options.token)) throw new Error('无效的桥接配对凭据');
    if (options.extensionId && !/^[a-p]{32}$/.test(options.extensionId)) throw new Error('无效的浏览器扩展 ID');
    this.options = options;
    this.server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
    this.server.on('upgrade', (req, socket, head) => {
      const reject = () => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); };
      try {
        if (this.closed || !this.port || req.headers.host !== `127.0.0.1:${this.port}`) return reject();
        const origin = req.headers.origin ?? '';
        if (options.internal ? origin !== 'aicut-internal://geo' : !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return reject();
        if (options.extensionId && origin !== `chrome-extension://${options.extensionId}`) return reject();
        const url = new URL(req.url ?? '', `http://127.0.0.1:${this.port}`);
        const token = url.searchParams.get('token') ?? '';
        if (url.pathname !== '/aicut' || url.searchParams.size !== 1 || token.length !== options.token.length
          || !timingSafeEqual(Buffer.from(token), Buffer.from(options.token))) return reject();
        // A second browser/profile must not silently take over active jobs.
        if (this.socket && this.socket.readyState !== WebSocket.CLOSED) return reject();
        this.wss.handleUpgrade(req, socket, head, ws => this.connected(ws));
      } catch { reject(); }
    });
  }

  async start(): Promise<void> {
    if (this.closed || this.started) throw new Error('桥接服务已启动或已关闭');
    this.started = true;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { this.server.off('listening', onListening); reject(error); };
      const onListening = () => { this.server.off('error', onError); resolve(); };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.options.port ?? 9537, '127.0.0.1');
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('桥接监听失败');
    this.port = address.port;
    this.heartbeat = setInterval(() => {
      if (!this.socket) return;
      if (!this.alive) { this.socket.terminate(); return; }
      this.alive = false;
      this.socket.ping();
      // Chrome 116+ needs application messages inside its 30s service-worker activity window.
      // https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets
      void this.request('aicut.ping', {}, 10_000).catch(() => undefined);
    }, 20_000);
    this.heartbeat.unref();
  }

  // Only expose this via an explicit user pairing action, never logs or polling snapshots.
  pairingUrl(): string {
    if (!this.port || this.closed) throw new Error('桥接服务尚未启动');
    return `ws://127.0.0.1:${this.port}/aicut?token=${this.options.token}`;
  }
  isConnected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }

  private connected(socket: WebSocket) {
    this.socket = socket;
    this.alive = true;
    socket.on('pong', () => { if (this.socket === socket) this.alive = true; });
    socket.on('error', () => { socket.terminate(); });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined;
      for (const [id, request] of this.pending) {
        if (request.socket !== socket) continue;
        clearTimeout(request.timer);
        this.pending.delete(id);
        request.reject(new Error('浏览器桥接已断开；操作不会自动重试，请先核对平台结果'));
      }
    });
    socket.on('message', (raw, binary) => {
      if (binary || this.socket !== socket) return;
      let response: { id?: unknown; result?: unknown; error?: unknown };
      try { response = JSON.parse(raw.toString()); } catch { return; }
      if (!response || typeof response.id !== 'string') return;
      const request = this.pending.get(response.id);
      if (!request || request.socket !== socket) return;
      this.pending.delete(response.id);
      clearTimeout(request.timer);
      if (response.error != null) {
        // Never forward arbitrary upstream error objects, cookie data, or pairing credentials.
        request.reject(new Error('浏览器插件未能完成此操作，请检查平台状态或插件版本'));
      } else request.resolve(response.result);
    });
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = this.options.requestTimeoutMs ?? 30_000): Promise<T> {
    if (!METHODS.has(method)) return Promise.reject(new Error('不支持的桥接操作'));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60_000) return Promise.reject(new Error('无效的桥接超时'));
    const socket = this.socket;
    if (this.closed || !socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('浏览器插件尚未连接，请先完成配对'));
    if (this.pending.size >= 32) return Promise.reject(new Error('桥接操作过多，请稍后再试'));
    const id = randomUUID();
    let body: string;
    try { body = JSON.stringify({ id, method, token: this.options.token, params }); }
    catch { return Promise.reject(new Error('无效的桥接参数')); }
    if (Buffer.byteLength(body) > 256 * 1024) return Promise.reject(new Error('桥接请求过大'));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('浏览器桥接操作超时；不会自动重试，请先核对平台结果'));
      }, timeoutMs);
      this.pending.set(id, { socket, resolve: value => resolve(value as T), reject, timer });
      socket.send(body, error => {
        if (!error || !this.pending.delete(id)) return;
        clearTimeout(timer);
        reject(new Error('浏览器桥接发送失败；请先核对平台结果'));
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('本机桥接服务已停止'));
    }
    this.pending.clear();
    for (const socket of this.wss.clients) socket.terminate();
    await new Promise<void>(resolve => this.wss.close(() => resolve()));
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
