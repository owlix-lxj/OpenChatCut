import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isLoopbackAddress } from '../loopback-address.ts';

export const INTERNAL_LLM_AUTH_HEADER = 'x-openchatcut-internal-llm';

// Process-local and intentionally never persisted. It authenticates only the
// server-side Agent's loopback hop into this process's /llm proxy.
const token = randomBytes(32).toString('base64url');

export function internalLlmAuthHeaders(): Record<string, string> {
  return { [INTERNAL_LLM_AUTH_HEADER]: token };
}

export function internalLlmRequestAuthorized(req: IncomingMessage): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  const presented = req.headers[INTERNAL_LLM_AUTH_HEADER];
  if (typeof presented !== 'string') return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}
