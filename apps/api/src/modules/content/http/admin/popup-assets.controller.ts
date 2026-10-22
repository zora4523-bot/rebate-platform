// POST /admin/v1/pages/popup-assets (F1-09r; contract adminUploadPopupAsset; 04 §6.6 pages
// 「弹窗素材上传」): permission point content.page, no step-up. The handler runs inside platform's
// AdminOperationGuard, and the multipart stream is read only inside the guard's business callback
// (readPopupAssetParts), so a refused permission never consumes the request body. The app and
// the uploader are the guard's actor, never request fields. Served by the admin entry only
// (content's ContentAdminModule).
//
// Nest's decorators are applied as plain calls below (not decorator syntax), as in
// platform-icons.controller.ts.
import { Controller, HttpCode, HttpException, Inject, Post, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type AdminActor,
  type CheckedRequest,
  type SingleUploadRequest,
} from '../../../platform/index.ts';
import {
  PopupAssetFieldsError,
  PopupAssetRejectedError,
  PopupAssetUploader,
  type PopupAssetActor,
} from '../../application/popup-asset-uploader.ts';
import { PopupAssetPartsRejection, readPopupAssetParts } from './popup-asset-parts.ts';

export interface PopupAssetsRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** Client address as resolved by platform's trusted-proxy setting (audit only). */
  readonly ip?: string;
}

const PERMISSION = 'content.page';

export class AdminPopupAssetsController {
  readonly #guard: AdminOperationGuard;
  readonly #uploader: PopupAssetUploader;

  constructor(guard: AdminOperationGuard, uploader: PopupAssetUploader) {
    this.#guard = guard;
    this.#uploader = uploader;
  }

  /** adminUploadPopupAsset: check one Lottie or picture and store it under its digest. */
  async upload(
    request: PopupAssetsRequest & SingleUploadRequest,
  ): Promise<Schema<'AdminPopupAssetUploadResponse'>> {
    let response: Schema<'AdminPopupAssetUploadResponse'> | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      try {
        const data = await this.#uploader.upload(uploaderOf(actor, request), () =>
          readPopupAssetParts(request),
        );
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error) {
        throw refusal(error, request.id);
      }
    });
    if (response === undefined) throw new Error('content: admin guard returned without the upload');
    return response;
  }
}

function uploaderOf(actor: AdminActor, request: PopupAssetsRequest): PopupAssetActor {
  return {
    appId: actor.appId,
    adminId: actor.adminId,
    ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
  };
}

/** 20001 ([kind] / [file], a rejected file also data.reason; 413 [body]); others rethrown. */
function refusal(error: unknown, traceId: string): unknown {
  if (error instanceof PopupAssetRejectedError) {
    const refused = fieldsErrorEnvelope(['file'], traceId);
    return new HttpException(
      { ...refused.body, data: { fields: ['file'], reason: error.reason } },
      refused.statusCode,
    );
  }
  if (error instanceof PopupAssetFieldsError) {
    const refused = fieldsErrorEnvelope(error.fields, traceId);
    return new HttpException(refused.body, refused.statusCode);
  }
  if (error instanceof PopupAssetPartsRejection) {
    const refused = fieldsErrorEnvelope([error.field], traceId);
    return new HttpException(refused.body, error.statusCode);
  }
  return error;
}

{
  const prototype = AdminPopupAssetsController.prototype;
  const upload = Object.getOwnPropertyDescriptor(prototype, 'upload')!;
  Inject(AdminOperationGuard)(AdminPopupAssetsController, undefined, 0);
  Inject(PopupAssetUploader)(AdminPopupAssetsController, undefined, 1);
  Req()(prototype, 'upload', 0);
  Post('popup-assets')(prototype, 'upload', upload);
  HttpCode(200)(prototype, 'upload', upload);
  RouteSchema(contractRouteSchema('adminUploadPopupAsset'))(prototype, 'upload', upload);
  Controller('admin/v1/pages')(AdminPopupAssetsController);
}
