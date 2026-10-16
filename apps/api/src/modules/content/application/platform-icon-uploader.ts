// Admin upload of a platform mark replacement image (F1-06x; contract adminUploadPlatformIcon;
// 08 BR-TEXT-24 细则「上传与发布」; orchestrator rulings F1-06n 2, 3, 7, 12, 14). The controller
// runs platform's AdminOperationGuard for content.platform_icon first and only then hands over
// `read`, which consumes the multipart stream (platform readSingleUpload): nothing of the request
// body is read without the permission. appId and the uploader are the verified admin's.
//
// Steps: key (20001 [key]) → the file → content.platform_icon.max_bytes read from config_items
// on every upload (no cache; default 204800) → inspectPlatformIcon (rejection: 20001 [file] with
// data.reason) → the media URL (MEDIA_PUBLIC_BASE_URL absent: 50001) → the platform_icon_uploads
// row, committed on its own (expires_at = created_at + 24 h, both from the injected Clock) → only
// then MediaStore.put of the cleaned bytes under their digest. A failing put is 50001 and the
// upload_id is never returned; the row simply expires (uploads are SELECT / INSERT only). Nothing
// is saved as a version and no audit row is written (ruling 7).
//
// Pure module (no decorators, erasable syntax).
import type { Schema } from '@couli/contracts-ts';
import { mediaUrlOf, type Clock, type MediaStore } from '../../platform/index.ts';
import {
  inspectPlatformIcon,
  type PlatformIconRejectReason,
} from '../domain/platform-icon/index.ts';
import { isPlatformIconKey, PlatformIconFieldsError } from './platform-icon-reader.ts';
import type { PlatformIconActor } from './platform-icon-writer.ts';

type Key = Schema<'PlatformIconKey'>;
type Upload = Schema<'AdminPlatformIconUpload'>;

export const PLATFORM_ICON_MAX_BYTES_KEY = 'content.platform_icon.max_bytes';
/** BR-TEXT-24 细则「上传与发布」: default limit when the app has no config_items row. */
export const PLATFORM_ICON_MAX_BYTES_DEFAULT = 204_800;
/** How long an upload can be saved as a version (ruling 2). */
export const PLATFORM_ICON_UPLOAD_TTL_MS = 86_400_000;
/** SVG conversion budget (contract: longer than 2 seconds → icon_svg_unconvertible). */
export const PLATFORM_ICON_CONVERSION_MS = 2_000;

/** One platform_icon_uploads row as inserted. */
export interface PlatformIconUploadRow {
  readonly id: string;
  readonly appId: string;
  readonly key: Key;
  readonly sha256: string;
  readonly format: 'svg' | 'png';
  readonly bytes: number;
  readonly sanitized: boolean;
  readonly createdByAdminId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface PlatformIconUploadStore {
  /** The config_items value of (appId, key) read from the table; undefined when absent. */
  configValue(appId: string, key: string): Promise<unknown>;
  /** INSERT in its own committed statement (autocommit), visible to every connection after. */
  insertUpload(row: PlatformIconUploadRow): Promise<void>;
}

/** 20001 with data.fields=[file] and the admin-only data.reason. */
export class PlatformIconUploadRejectedError extends Error {
  readonly reason: PlatformIconRejectReason;

  constructor(reason: PlatformIconRejectReason) {
    super(`platform icon upload: ${reason}`);
    this.name = 'PlatformIconUploadRejectedError';
    this.reason = reason;
  }
}

export interface PlatformIconUploaderOptions {
  readonly store: PlatformIconUploadStore;
  readonly media: MediaStore;
  readonly clock: Clock;
  readonly mediaPublicBaseUrl: string | undefined;
  readonly newId: () => string;
  /** Monotonic milliseconds for the conversion budget (not business time). */
  readonly monotonicMs: () => number;
}

/** `instant` plus `ms` as a new Date (the Clock's instant is never modified). */
function later(instant: Date, ms: number): Date {
  const result = structuredClone(instant);
  result.setTime(instant.getTime() + ms);
  return result;
}

/** A configured limit must be a non-negative safe integer; a malformed row fails closed (50001). */
export function maxBytesOf(value: unknown): number {
  if (value === undefined) return PLATFORM_ICON_MAX_BYTES_DEFAULT;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error(`content: ${PLATFORM_ICON_MAX_BYTES_KEY} is not a non-negative integer`);
}

export class PlatformIconUploader {
  readonly #options: PlatformIconUploaderOptions;

  constructor(options: PlatformIconUploaderOptions) {
    this.#options = options;
  }

  /** adminUploadPlatformIcon: `read` returns the one uploaded file (called after the guard). */
  async upload(
    actor: PlatformIconActor,
    rawKey: string,
    read: () => Promise<{ readonly bytes: Uint8Array }>,
  ): Promise<Upload> {
    if (!isPlatformIconKey(rawKey)) throw new PlatformIconFieldsError(['key']);
    const key = rawKey;
    const { store, media, clock, mediaPublicBaseUrl, newId, monotonicMs } = this.#options;
    const file = await read();
    const maxBytes = maxBytesOf(await store.configValue(actor.appId, PLATFORM_ICON_MAX_BYTES_KEY));
    const started = monotonicMs();
    const result = inspectPlatformIcon(file.bytes, {
      maxBytes,
      deadline: { remainingMs: () => PLATFORM_ICON_CONVERSION_MS - (monotonicMs() - started) },
    });
    if (!result.ok) throw new PlatformIconUploadRejectedError(result.reason);
    // Media unconfigured (staging / prod without MEDIA_PUBLIC_BASE_URL): 50001 before any row.
    const url = mediaUrlOf(mediaPublicBaseUrl, result.sha256, result.format);
    const createdAt = clock.now();
    const row: PlatformIconUploadRow = {
      id: newId(),
      appId: actor.appId,
      key,
      sha256: result.sha256,
      format: result.format,
      bytes: result.bytes.byteLength,
      sanitized: result.sanitized,
      createdByAdminId: actor.adminId,
      createdAt,
      expiresAt: later(createdAt, PLATFORM_ICON_UPLOAD_TTL_MS),
    };
    // The row is committed before the put: a put that fails leaves an unused row that expires,
    // never a stored file whose upload the database does not know.
    await store.insertUpload(row);
    await media.put({
      sha256: result.sha256,
      bytes: result.bytes,
      contentType: result.format === 'svg' ? 'image/svg+xml' : 'image/png',
    });
    return {
      upload_id: row.id,
      url,
      sha256: row.sha256,
      format: row.format,
      bytes: row.bytes,
      sanitized: row.sanitized,
      expires_at: row.expiresAt.toISOString(),
    };
  }
}
