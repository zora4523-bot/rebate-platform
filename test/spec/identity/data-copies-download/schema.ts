// B1-27i · contract of the three download operations of CT-24q: adminDownloadUserDataExport
// (POST /admin/v1/users/{user_id}/data-exports/{export_id}/download), listMyDataCopies
// (GET /v1/me/data-copies) and getMyDataCopyDownload (GET /v1/me/data-copies/{id}/download);
// contracts/openapi.yaml is the only source.
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { apiRequire, type Response } from '../../admin/auth/kit.ts';

export const ADMIN_DOWNLOAD = '/admin/v1/users/{user_id}/data-exports/{export_id}/download';
export const MY_COPIES = '/v1/me/data-copies';
export const MY_DOWNLOAD = '/v1/me/data-copies/{id}/download';

export type OperationKey = 'admin' | 'list' | 'mine';
export type Method = 'post' | 'get';

export interface OperationSpec {
  readonly path: string;
  readonly method: Method;
  readonly verb: 'POST' | 'GET';
  readonly operationId: string;
  /** Fastify's route template of the path. */
  readonly route: string;
  /** The x-error-codes of CT-24q; this task does not change them. */
  readonly errorCodes: readonly number[];
}

export const OPERATIONS: Readonly<Record<OperationKey, OperationSpec>> = {
  admin: {
    path: ADMIN_DOWNLOAD,
    method: 'post',
    verb: 'POST',
    operationId: 'adminDownloadUserDataExport',
    route: '/admin/v1/users/:user_id/data-exports/:export_id/download',
    errorCodes: [10001, 10003, 10403, 20001, 30417],
  },
  list: {
    path: MY_COPIES,
    method: 'get',
    verb: 'GET',
    operationId: 'listMyDataCopies',
    route: '/v1/me/data-copies',
    errorCodes: [],
  },
  mine: {
    path: MY_DOWNLOAD,
    method: 'get',
    verb: 'GET',
    operationId: 'getMyDataCopyDownload',
    route: '/v1/me/data-copies/:id/download',
    errorCodes: [30701],
  },
};

export interface Operation {
  operationId: string;
  'x-implementation'?: string;
  'x-error-codes'?: number[];
  parameters?: unknown[];
  responses: Record<string, { content?: Record<string, { schema: JsonSchema }> }>;
}
interface Document {
  paths: Record<string, Partial<Record<Method, Operation>>>;
}

let document: Promise<Document> | undefined;
export function contract(): Promise<Document> {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<Document>;
  };
  document ??= parser.dereference(
    fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  return document;
}

export async function operation(key: OperationKey): Promise<Operation> {
  const spec = OPERATIONS[key];
  const op = (await contract()).paths[spec.path]?.[spec.method];
  expect(op, `${spec.path} ${spec.verb} must exist in the contract`).toBeDefined();
  expect(op!.operationId).toBe(spec.operationId);
  return op!;
}

/** The response against the contract response of its status class. */
export async function validate(response: Response, key: OperationKey) {
  const op = await operation(key);
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const schema = op.responses[status]?.content?.['application/json']?.schema;
  expect(schema, `response ${status} must be in the contract`).toBeDefined();
  const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}

/** The body without its trace_id (refusals that must not tell cases apart). */
export function withoutTrace(response: Response): Record<string, unknown> {
  const body = { ...response.json<Record<string, unknown>>() };
  delete body['trace_id'];
  return body;
}
