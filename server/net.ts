// System proxy support for all server-side fetch traffic.
// Node's fetch (undici) ignores HTTP_PROXY/HTTPS_PROXY by default, so on
// machines that reach external APIs through a local proxy (Clash, etc.) every
// direct call fails with a network error. Installing a global EnvHttpProxyAgent
// makes external calls honor the proxy env vars while keeping localhost calls
// on the local socket. The Agent server calls its own /llm proxy through fetch;
// sending that loopback request through Clash causes the proxy to close the
// connection with "other side closed" before the LLM request is reached.
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

let installed = false;

export function installSystemProxy(): void {
  if (installed) return;
  installed = true;
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  if (!proxy) return;
  try {
    // Keep the loopback bypass explicit instead of inheriting a broad or
    // missing NO_PROXY from the host shell. External provider requests still
    // use the configured proxy, while /llm and other local Vite routes stay
    // local and cannot be sent through that proxy by accident.
    setGlobalDispatcher(new EnvHttpProxyAgent({
      httpProxy: proxy,
      httpsProxy: proxy,
      noProxy: 'localhost,127.0.0.1,::1',
    }));
  } catch (error) {
    // A broken proxy must not take the server down; direct mode stays active.
    console.warn(`[net] proxy install skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}
