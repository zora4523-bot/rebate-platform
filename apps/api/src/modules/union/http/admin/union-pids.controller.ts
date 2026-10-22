import type { Schema } from '@couli/contracts-ts';
import type { CheckedRequest } from '../../../platform/index.ts';

export interface AdminPidRequest extends CheckedRequest {
  readonly id: string;
  readonly ip?: string;
}

/** Multipart is decoded by the HTTP adapter; the screenshot is never a public URL. */
export interface AdminPidActivation {
  readonly expected_row_version: number;
  readonly hjy_ignore_confirmed_at: string;
  readonly hjy_ignore_evidence: {
    readonly bytes: Buffer;
    readonly contentType: string;
    readonly filename: string;
  };
  readonly reason?: string;
}

export class AdminUnionPidsController {
  list(request: AdminPidRequest): Promise<Schema<'AdminUnionPidListResponse'>> {
    void request;
    throw new Error('NotImplemented: adminListUnionPids');
  }

  create(
    request: AdminPidRequest,
    body: Schema<'AdminUnionPidCreateRequest'>,
  ): Promise<Schema<'AdminUnionPidResponse'>> {
    void request;
    void body;
    throw new Error('NotImplemented: adminCreateUnionPid');
  }

  update(
    request: AdminPidRequest,
    pidId: string,
    body: Schema<'AdminUnionPidUpdateRequest'>,
  ): Promise<Schema<'AdminUnionPidResponse'>> {
    void request;
    void pidId;
    void body;
    throw new Error('NotImplemented: adminUpdateUnionPid');
  }

  activate(
    request: AdminPidRequest,
    pidId: string,
    body: AdminPidActivation,
  ): Promise<Schema<'AdminUnionPidResponse'>> {
    void request;
    void pidId;
    void body;
    throw new Error('NotImplemented: adminActivateUnionPid');
  }

  retire(
    request: AdminPidRequest,
    pidId: string,
    body: Schema<'AdminUnionPidRetireRequest'>,
  ): Promise<Schema<'AdminUnionPidResponse'>> {
    void request;
    void pidId;
    void body;
    throw new Error('NotImplemented: adminRetireUnionPid');
  }
}
