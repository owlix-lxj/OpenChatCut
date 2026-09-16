import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStandaloneServer } from './standalone.ts';

const fixture = await mkdtemp(join(tmpdir(), 'openchatcut-standalone-'));
const previousMode = process.env.OPENCHATCUT_PLATFORM_MODE;
try {
  await assert.rejects(
    startStandaloneServer({ distDir: join(fixture, 'missing'), port: 0 }),
    /build not found/,
  );

  await writeFile(join(fixture, 'index.html'), '<!doctype html><title>standalone fixture</title>');
  delete process.env.OPENCHATCUT_PLATFORM_MODE;
  const running = await startStandaloneServer({ distDir: fixture, host: '127.0.0.1', port: 0 });
  const address = running.server.address();
  assert(address && typeof address === 'object');
  assert.equal(running.port, address.port);
  const origin = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  assert.match(await (await fetch(`${origin}/projects/example`)).text(), /standalone fixture/);
  running.server.close();
  await once(running.server, 'close');
} finally {
  if (previousMode === undefined) delete process.env.OPENCHATCUT_PLATFORM_MODE;
  else process.env.OPENCHATCUT_PLATFORM_MODE = previousMode;
  await rm(fixture, { recursive: true, force: true });
}

console.log('standalone.verify: health check and SPA fallback OK');
