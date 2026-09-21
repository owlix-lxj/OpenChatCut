import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { GeoPublishBridge } from './geo-publish-bridge.ts';

const token = GeoPublishBridge.createToken();
const bridge = new GeoPublishBridge({ token, port: 0, requestTimeoutMs: 100 });
const extensionId = 'a'.repeat(32);
const origin = `chrome-extension://${extensionId}`;
const sockets: WebSocket[] = [];
function connect(url: string, from = origin) {
  const socket = new WebSocket(url, { origin: from });
  sockets.push(socket);
  return socket;
}
async function rejected(url: string, from = origin) {
  const socket = connect(url, from);
  await assert.rejects(once(socket, 'open'), /403/);
}
try {
  await bridge.start();
  const url = bridge.pairingUrl();
  const httpUrl = url.replace('ws:', 'http:');
  assert.equal((await fetch(httpUrl)).status, 404);
  assert.equal((await fetch(new URL('/request', httpUrl), { method: 'POST', body: '{}' })).status, 404);
  await rejected(url, 'https://evil.example');
  await rejected(url, 'chrome-extension://not-an-extension');
  await rejected(url.replace(token, '0'.repeat(64)));
  await rejected(url.replace('/aicut?', '/request?'));
  await rejected(url.replace('127.0.0.1', 'localhost'));
  await assert.rejects(bridge.request('checkAuth'), /尚未连接/);
  const socket = connect(url);
  await once(socket, 'open');
  assert.equal(bridge.isConnected(), true);
  await rejected(url); // no silent profile takeover
  await assert.rejects(bridge.request('syncArticle'), /不支持/);
  await assert.rejects(bridge.request('checkAuth', { data: 'a'.repeat(300_000) }), /过大/);

  const received = once(socket, 'message');
  const auth = bridge.request('checkAuth', { platform: 'douyin' });
  const [raw] = await received;
  const request = JSON.parse(String(raw));
  assert.equal(request.token, token);
  assert.equal(request.method, 'checkAuth');
  assert.deepEqual(request.params, { platform: 'douyin' });
  socket.send('not json');
  socket.send('null');
  socket.send(JSON.stringify({ id: 'unsolicited', result: { isAuthenticated: true } }));
  socket.send(JSON.stringify({ id: request.id, result: { isAuthenticated: true, username: 'fixture only' } }));
  assert.deepEqual(await auth, { isAuthenticated: true, username: 'fixture only' });

  const errorMessage = once(socket, 'message');
  const errorResult = bridge.request('checkAuth');
  const rejection = assert.rejects(errorResult, error => error instanceof Error && !error.message.includes(token));
  const [errorRaw] = await errorMessage;
  socket.send(JSON.stringify({ id: JSON.parse(String(errorRaw)).id, error: { message: token } }));
  await rejection;
  await assert.rejects(bridge.request('checkAuth'), /超时/);

  await assert.rejects(bridge.request('aicut.submitVideo', { jobId: 'fixture' }));
  const inFlight = bridge.request('aicut.saveDraft', { jobId: 'fixture' });
  const disconnected = assert.rejects(inFlight, /断开/);
  socket.close();
  await disconnected;
  assert.equal(bridge.isConnected(), false);
  const reconnected = connect(url);
  await once(reconnected, 'open');
  // Reconnection must not replay any operation (especially submit).
  let replayed = false;
  reconnected.on('message', () => { replayed = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(replayed, false);
  const stopped = assert.rejects(bridge.request('checkAuth'), /已停止/);
  await bridge.close();
  await stopped;
  assert.throws(() => bridge.pairingUrl(), /尚未启动/);
  console.log('geo-publish-bridge: loopback auth, exact GEO protocol, timeouts, disconnect and no-replay passed');
} finally {
  sockets.forEach(socket => socket.terminate());
  await bridge.close();
}

const internal = new GeoPublishBridge({ token, port: 0, internal: true });
try {
  await internal.start();
  await rejected(internal.pairingUrl(), origin);
  await rejected(internal.pairingUrl(), 'https://creator.douyin.com');
  const socket = connect(internal.pairingUrl(), 'aicut-internal://geo');
  await once(socket, 'open');
  assert.equal(internal.isConnected(), true);
  console.log('geo-publish-bridge: built-in origin accepted; external extension and web origins rejected');
} finally {
  sockets.forEach(socket => socket.terminate());
  await internal.close();
}
