import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViteDevServer } from 'vite';
import { createMiniConnect } from '../desktop/mini-connect.ts';
import { mountAssemblyAiProxy } from '../desktop/embedded-server.ts';
import { distStaticMiddleware, uploadsMiddleware } from '../desktop/static-files.ts';
import { seedKeystore } from './keystore.ts';
import { registerProductAssetRoot } from './product-assets.ts';
import { serverPlugins } from './plugins/index.ts';
import { isPlatformManagedValue, PLATFORM_MODE_ENV } from '../shared/platform-config.ts';

export interface StandaloneServer {
  server: Server;
  host: string;
  port: number;
}

function configuredPort(value: string | undefined): number {
  const port = Number(value || '5199');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('OPENCHATCUT_PORT must be an integer between 1 and 65535');
  }
  return port;
}

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function logger() {
  return {
    info: (message: string) => console.log(message),
    warn: (message: string) => console.warn(message),
    error: (message: string) => console.error(message),
  };
}

function requireHttpUrl(name: string, value: string | undefined, requireHttps: boolean): void {
  try {
    const parsed = new URL(value ?? '');
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.host || parsed.username || parsed.password) throw new Error();
    if (requireHttps && parsed.protocol !== 'https:') throw new Error();
  } catch {
    throw new Error(`${name} must be an absolute ${requireHttps ? 'https' : 'http(s)'} URL`);
  }
}

function validatePlatformConfiguration(): void {
  if (!isPlatformManagedValue(process.env[PLATFORM_MODE_ENV])) return;
  if ((process.env.OPENCHATCUT_PLATFORM_SESSION_SECRET?.trim().length ?? 0) < 32) {
    throw new Error('OPENCHATCUT_PLATFORM_SESSION_SECRET must contain at least 32 characters');
  }
  const production = process.env.NODE_ENV === 'production';
  requireHttpUrl('OPENCHATCUT_PLATFORM_API_BASE_URL', process.env.OPENCHATCUT_PLATFORM_API_BASE_URL, production);
  requireHttpUrl('OPENCHATCUT_EDITOR_URL', process.env.OPENCHATCUT_EDITOR_URL, production);
}

export async function startStandaloneServer(options: {
  distDir?: string;
  host?: string;
  port?: number;
} = {}): Promise<StandaloneServer> {
  const apiOnly = /^(1|true|yes)$/i.test(process.env.OPENCHATCUT_API_ONLY?.trim() ?? '');
  const distDir = resolve(options.distDir ?? process.env.OPENCHATCUT_DIST_DIR ?? 'dist');
  if (!apiOnly && !existsSync(resolve(distDir, 'index.html'))) {
    throw new Error(`OpenChatCut build not found at ${distDir}; run npm run build first`);
  }

  const host = (options.host ?? process.env.OPENCHATCUT_HOST?.trim()) || '127.0.0.1';
  const port = options.port ?? configuredPort(process.env.OPENCHATCUT_PORT);
  validatePlatformConfiguration();
  if (!apiOnly) registerProductAssetRoot(distDir);
  seedKeystore(processEnvironment());

  const app = createMiniConnect((error) => {
    console.error('[standalone-server]', error instanceof Error ? error.stack ?? error.message : error);
  });
  const server = createServer((req, res) => app.handle(req, res));

  app.use('/healthz', (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true }));
  });
  mountAssemblyAiProxy(app);

  const fake = {
    middlewares: { use: app.use.bind(app) },
    httpServer: server,
    config: { logger: logger() },
    ssrLoadModule: async (specifier: string) => {
      if (specifier !== '/src/plugins/resourcePreview.ts') throw new Error(`unsupported production SSR module: ${specifier}`);
      return import(new URL('./resourcePreview.mjs', import.meta.url).href);
    },
  } as unknown as ViteDevServer;
  for (const plugin of serverPlugins({ projectStoreHttp: true })) {
    const hook = plugin.configureServer;
    const configure = typeof hook === 'function' ? hook : hook?.handler;
    await configure?.call(plugin as never, fake);
  }

  app.use('/media/uploads', uploadsMiddleware());
  if (!apiOnly) app.use(distStaticMiddleware(distDir, process.env.OPENCHATCUT_BASE));

  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolveListen();
    });
  });
  const address = server.address();
  return { server, host, port: address && typeof address === 'object' ? address.port : port };
}

async function main(): Promise<void> {
  const running = await startStandaloneServer();
  console.log(`[OpenChatCut] production server listening on http://${running.host}:${running.port}`);
  const close = (signal: NodeJS.Signals) => {
    console.log(`[OpenChatCut] received ${signal}; shutting down`);
    running.server.close((error) => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  void main().catch((error: unknown) => {
    console.error('[OpenChatCut] startup failed:', error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
