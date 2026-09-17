// Sidecar manifests that map an upload `name` (our uuid.ext, referenced by the client as
// /media/uploads/<name>) to an object in the tenant's OSS material library. In platform mode
// the media bytes live only in OSS — never on local disk — so reads, posters, filmstrips and
// probes resolve the name to its OSS source URL and stream from there.
//
// Manifests are scope-aware by construction: callers pass the scoped uploadDir(), so a manifest
// lands under the same tenant/user scope directory the media read path already resolves within.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const REFERENCE_VERSION = 1;
const MAX_MANIFEST_BYTES = 8 * 1024;
export const OSS_REFERENCE_DIRECTORY = '.oss-references';

export interface OssReferenceRecord {
  readonly version: 1;
  readonly sourceUrl: string;
  readonly objectKey: string;
  readonly bytes: number;
  readonly contentType: string;
  readonly contentHash?: string;
  readonly createdAt: string;
}

export function ossReferenceManifestPath(directory: string, name: string): string {
  return join(directory, OSS_REFERENCE_DIRECTORY, `${name}.json`);
}

function isHttpsUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

export function readOssReference(directory: string, name: string): OssReferenceRecord | null {
  try {
    const manifest = ossReferenceManifestPath(directory, name);
    const info = statSync(manifest);
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) return null;
    const value = JSON.parse(readFileSync(manifest, 'utf8')) as Partial<OssReferenceRecord>;
    if (value.version !== REFERENCE_VERSION || !isHttpsUrl(value.sourceUrl)
      || typeof value.objectKey !== 'string' || !value.objectKey) return null;
    return {
      version: REFERENCE_VERSION,
      sourceUrl: value.sourceUrl,
      objectKey: value.objectKey,
      bytes: typeof value.bytes === 'number' && value.bytes >= 0 ? value.bytes : 0,
      contentType: typeof value.contentType === 'string' ? value.contentType : 'application/octet-stream',
      ...(typeof value.contentHash === 'string' && value.contentHash ? { contentHash: value.contentHash } : {}),
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    };
  } catch {
    return null;
  }
}

export function resolveOssReference(directory: string, name: string): OssReferenceRecord | null {
  return readOssReference(directory, name);
}

export function hasOssReference(directory: string, name: string): boolean {
  return existsSync(ossReferenceManifestPath(directory, name));
}

export async function registerOssReference(
  directory: string,
  name: string,
  record: Omit<OssReferenceRecord, 'version' | 'createdAt'>,
): Promise<void> {
  if (!isHttpsUrl(record.sourceUrl) || !record.objectKey) throw new Error('OSS reference requires a source URL and object key');
  const references = join(directory, OSS_REFERENCE_DIRECTORY);
  const manifest = ossReferenceManifestPath(directory, name);
  const temporary = join(references, `.${name}.${randomUUID()}.tmp`);
  const full: OssReferenceRecord = {
    version: REFERENCE_VERSION,
    sourceUrl: record.sourceUrl,
    objectKey: record.objectKey,
    bytes: record.bytes,
    contentType: record.contentType,
    ...(record.contentHash ? { contentHash: record.contentHash } : {}),
    createdAt: new Date().toISOString(),
  };
  await mkdir(references, { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(full)}\n`, { mode: 0o600 });
  try {
    await rename(temporary, manifest);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function deleteOssReference(directory: string, name: string): Promise<boolean> {
  try {
    await unlink(ossReferenceManifestPath(directory, name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export interface ListedOssReference {
  readonly name: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

export async function listOssReferences(directory: string): Promise<ListedOssReference[]> {
  const references = join(directory, OSS_REFERENCE_DIRECTORY);
  const entries = await readdir(references).catch(() => [] as string[]);
  const listed: ListedOssReference[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const name = entry.slice(0, -'.json'.length);
    const record = readOssReference(directory, name);
    if (!record) continue;
    const manifestInfo = await stat(ossReferenceManifestPath(directory, name)).catch(() => null);
    listed.push({ name, bytes: record.bytes, mtimeMs: manifestInfo?.mtimeMs ?? 0 });
  }
  return listed;
}
