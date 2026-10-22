// Admin upload of a home popup asset (F1-09r; contract adminUploadPopupAsset; 08 BR-TEXT-26 细则
// 「素材与校验」; 04 §6.6 pages「弹窗素材上传」; 编排裁定 9.2 2–4). The controller runs platform's
// AdminOperationGuard for content.page first and only then hands over `read`, which consumes the
// multipart stream: nothing of the request body is read without the permission.
//
// Steps: read the parts → kind (missing or not lottie / image: 20001 [kind]) → the file (missing:
// 20001 [file]) → inspectPopupAsset (rejection: 20001 [file] with data.reason) → the media URL
// (MEDIA_PUBLIC_BASE_URL absent: 50001) → MediaStore.put under the content digest (idempotent: the
// same content answers the same url; a failing put is 50001) → one audit row
// page_popup_asset_upload with kind, sha256 and bytes only. No page or page version is touched:
// the console writes url / sha256 into the popup props when it saves a draft. Logs carry the
// digest, never the content or the client's filename.
//
// Pure module (no decorators, erasable syntax).
import type { Schema } from '@couli/contracts-ts';
import type { Logger } from 'pino';
import {
  mediaUrlOf,
  type AuditPort,
  type MediaContentType,
  type MediaStore,
} from '../../platform/index.ts';
import {
  inspectPopupAsset,
  type PopupAssetKind,
  type PopupAssetRejectReason,
} from '../domain/popup-asset.ts';

type Asset = Schema<'AdminPopupAssetLottie'> | Schema<'AdminPopupAssetImage'>;

export const POPUP_ASSET_AUDIT_ACTION = 'page_popup_asset_upload';

/** The parts of one upload request: `kind`'s value (undefined when absent) and the file. */
export interface PopupAssetParts {
  readonly kind: unknown;
  readonly file: Uint8Array | undefined;
}

export interface PopupAssetActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

/** 20001 with data.fields only ([kind] or [file]). */
export class PopupAssetFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`popup asset upload: invalid ${fields.join(', ')}`);
    this.name = 'PopupAssetFieldsError';
    this.fields = fields;
  }
}

/** 20001 with data.fields=[file] and the admin-only data.reason. */
export class PopupAssetRejectedError extends Error {
  readonly reason: PopupAssetRejectReason;

  constructor(reason: PopupAssetRejectReason) {
    super(`popup asset upload: ${reason}`);
    this.name = 'PopupAssetRejectedError';
    this.reason = reason;
  }
}

export interface PopupAssetUploaderOptions {
  readonly media: MediaStore;
  /** Append-only audit port (admin's writer on the primary handle). */
  readonly audit: AuditPort;
  readonly mediaPublicBaseUrl: string | undefined;
  readonly logger: Logger;
}

const CONTENT_TYPE: Readonly<Record<'json' | 'png' | 'jpg', MediaContentType>> = Object.freeze({
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
});

function kindOf(value: unknown): PopupAssetKind | undefined {
  return value === 'lottie' || value === 'image' ? value : undefined;
}

export class PopupAssetUploader {
  readonly #options: PopupAssetUploaderOptions;

  constructor(options: PopupAssetUploaderOptions) {
    this.#options = options;
  }

  /** adminUploadPopupAsset: `read` returns the request's parts (called after the guard). */
  async upload(actor: PopupAssetActor, read: () => Promise<PopupAssetParts>): Promise<Asset> {
    const { media, audit, mediaPublicBaseUrl, logger } = this.#options;
    const parts = await read();
    const kind = kindOf(parts.kind);
    if (kind === undefined) throw new PopupAssetFieldsError(['kind']);
    if (parts.file === undefined) throw new PopupAssetFieldsError(['file']);
    const result = inspectPopupAsset(kind, parts.file);
    if (!result.ok) throw new PopupAssetRejectedError(result.reason);
    // Media unconfigured (staging / prod without MEDIA_PUBLIC_BASE_URL): 50001 before any write.
    const url = mediaUrlOf(mediaPublicBaseUrl, result.sha256, result.format);
    await media.put({
      sha256: result.sha256,
      bytes: result.bytes,
      contentType: CONTENT_TYPE[result.format],
    });
    const bytes = result.bytes.byteLength;
    await audit.append({
      appId: actor.appId,
      actor: actor.adminId,
      action: POPUP_ASSET_AUDIT_ACTION,
      target: result.sha256,
      before: null,
      after: { kind, sha256: result.sha256, bytes },
      ip: actor.ip,
    });
    logger.info(
      { event: 'popup_asset_uploaded', kind, sha256: result.sha256, bytes },
      'popup asset stored',
    );
    if (kind === 'image') return { url, sha256: result.sha256, bytes };
    if (
      result.width === undefined ||
      result.height === undefined ||
      result.durationMs === undefined
    ) {
      throw new Error('content: an accepted Lottie lacks its size or duration');
    }
    return {
      url,
      sha256: result.sha256,
      bytes,
      width: result.width,
      height: result.height,
      duration_ms: result.durationMs,
    };
  }
}
