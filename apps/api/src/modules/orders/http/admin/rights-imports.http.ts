// B1-09g: the handlers of POST / GET /admin/v1/rights-imports and GET
// /admin/v1/rights-imports/{import_id} (contract adminCreateRightsImport / adminListRightsImports /
// adminGetRightsImport). Not mounted (J-1 / J-22): no Nest decorator here and no route on any entry;
// B1-09n wraps this in the admin controller. The admin request check has verified the admin token
// before these run.
//
// create: the operation guard checks the account and permission point order.claim (no step-up tier)
// first; only inside its callback is the multipart body read (so a refused account never consumes
// it), under this route's own part counts (kind, platform, time_basis, from, to, union_account_id
// and one file; the admin entry's default is one file and no field) passed through the plugin's
// public per-request option `request.parts({ limits })` (F1-09t: no private plugin symbol;
// fileSize stays the global bodyLimit). A body above the route's bodyLimit (Content-Length up
// front, or the bytes counted while streaming) is HTTP 413 / 20001 [body]; a body that is not
// multipart, or malformed, is 400 / 20001. kind=channel then goes through
// the guard a second time with permission point risk.blocklist (totp tier: a valid totp
// X-Step-Up-Token, once for the whole file, BR-ATTR-26 细则「渠道单导入」) before anything is
// stored; rights and punish need neither. The use case (application/rights-imports.ts) answers the
// rest; 20001 is HTTP 400 with data.fields. Success: HTTP 200 { code 0, data { import_id, status
// queued } }.
// list / detail: read-only guard on order.claim (no step-up); the app is the actor's.
import type { Schema } from '@couli/contracts-ts';
import type { AdminOperationGuard, SingleUploadRequest } from '../../../platform/index.ts';
import type { RightsImportDeps, RightsImportPageQuery } from '../../application/rights-imports.ts';

/** The admin entry's Fastify request (multipart methods installed on the admin entry). */
export interface RightsImportRequest extends SingleUploadRequest {
  readonly ip?: string;
  /** The plugin's public reader with per-request busboy counts. */
  parts(options?: { readonly limits?: object }): ReturnType<SingleUploadRequest['parts']>;
}

/** Any admin request: its id is the trace id. */
export interface RightsImportReadRequest {
  readonly id: string;
  readonly ip?: string;
}

export interface AdminRightsImportsDeps {
  readonly guard: Pick<AdminOperationGuard, 'run'>;
  readonly imports: RightsImportDeps;
}

export class AdminRightsImportsHttp {
  constructor(deps: AdminRightsImportsDeps) {
    void deps;
    throw new Error('NotImplemented: AdminRightsImportsHttp');
  }

  create(request: RightsImportRequest): Promise<Schema<'AdminRightsImportCreateResponse'>> {
    void request;
    throw new Error('NotImplemented: AdminRightsImportsHttp.create');
  }

  list(
    request: RightsImportReadRequest,
    query: RightsImportPageQuery,
  ): Promise<Schema<'AdminRightsImportPageResponse'>> {
    void request;
    void query;
    throw new Error('NotImplemented: AdminRightsImportsHttp.list');
  }

  detail(
    request: RightsImportReadRequest,
    importId: string,
  ): Promise<Schema<'AdminRightsImportDetailResponse'>> {
    void request;
    void importId;
    throw new Error('NotImplemented: AdminRightsImportsHttp.detail');
  }
}
