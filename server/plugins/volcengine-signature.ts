import { createHash, createHmac } from 'node:crypto';

export interface VolcengineCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignedVolcengineRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params).sort().map((key) => `${encode(key)}=${encode(params[key]!)}`).join('&');
}

function iso8601(date: Date): string {
  return date.toISOString().replace(/[-:]|\.\d{3}/g, '');
}

/** Build the HMAC-SHA256 Signature V4 request used by Volcengine Visual CV APIs. */
export function signVolcengineRequest(input: {
  baseUrl: string;
  action: string;
  version?: string;
  body: Record<string, unknown>;
  credentials: VolcengineCredentials;
  date?: Date;
}): SignedVolcengineRequest {
  const endpoint = new URL(input.baseUrl);
  const path = endpoint.pathname || '/';
  const body = JSON.stringify(input.body);
  const contentType = 'application/json';
  const xDate = iso8601(input.date ?? new Date());
  const shortDate = xDate.slice(0, 8);
  const payloadHash = sha256(body);
  const host = endpoint.host;
  const query = canonicalQuery({ Action: input.action, Version: input.version ?? '2022-08-31' });
  const signedHeaders = ['content-type', 'host', 'x-content-sha256', 'x-date'];
  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${host}`,
    `x-content-sha256:${payloadHash}`,
    `x-date:${xDate}`,
  ].join('\n');
  // Volcengine's V4 canonical form has an empty line between canonical headers
  // and the signed-header list. This matches the official SDK signer.
  const canonicalRequest = [
    'POST', path, query, `${canonicalHeaders}\n`, signedHeaders.join(';'), payloadHash,
  ].join('\n');
  const credentialScope = `${shortDate}/cn-north-1/cv/request`;
  const stringToSign = [
    'HMAC-SHA256', xDate, credentialScope, sha256(canonicalRequest),
  ].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(input.credentials.secretAccessKey, shortDate), 'cn-north-1'), 'cv'), 'request');
  const signature = hmac(signingKey, stringToSign).toString('hex');
  const headers: Record<string, string> = {
    Host: host,
    'Content-Type': contentType,
    'X-Date': xDate,
    'X-Content-Sha256': payloadHash,
    Authorization: `HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
  };
  if (input.credentials.sessionToken) headers['X-Security-Token'] = input.credentials.sessionToken;
  return { url: `${endpoint.origin}${path}?${query}`, headers, body };
}
