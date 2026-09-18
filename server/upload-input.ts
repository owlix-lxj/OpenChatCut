// Resolve an upload `name` to an ffmpeg/ffprobe input: a local file when one exists, otherwise
// the tenant OSS object's public URL (ffmpeg reads http(s) inputs directly, so no local copy is
// made). Endpoints that used to call resolveUploadFile(name) + existsSync should use this so they
// work for OSS-backed media too.
import { existsSync } from 'node:fs';
import { resolveUploadFile, uploadDir } from './media-dir.ts';
import { resolveOssReference } from './oss-references.ts';

export interface ResolvedUploadInput {
  /** A local filesystem path, or an https OSS URL. Either is valid as an ffmpeg `-i` argument. */
  readonly input: string;
  /** True when `input` is a remote OSS URL rather than a local file. */
  readonly remote: boolean;
  /** Known byte size (from the OSS reference) when remote; undefined for local. */
  readonly bytes?: number;
  /** Content type from the OSS reference when remote. */
  readonly contentType?: string;
}

export function resolveUploadInput(name: string): ResolvedUploadInput | null {
  const local = resolveUploadFile(name);
  if (local && existsSync(local)) return { input: local, remote: false };
  const ref = resolveOssReference(uploadDir(), name);
  if (ref) return { input: ref.sourceUrl, remote: true, bytes: ref.bytes, contentType: ref.contentType };
  return null;
}
