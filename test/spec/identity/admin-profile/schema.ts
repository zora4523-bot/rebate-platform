// B1-27b · contract of adminEditUserProfile (PATCH /admin/v1/users/{user_id}/profile) and of the
// detail read it answers with (adminGetUser); contracts/openapi.yaml is the only source.
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { apiRequire, type Response } from '../../admin/auth/kit.ts';

export const PROFILE = '/admin/v1/users/{user_id}/profile';
export const DETAIL = '/admin/v1/users/{user_id}';
export const OPERATION_ID = 'adminEditUserProfile';

export interface Operation {
  operationId: string;
  'x-implementation'?: string;
  'x-error-codes'?: number[];
  parameters?: unknown[];
  responses: Record<string, { content?: Record<string, { schema: JsonSchema }> }>;
}
interface Document {
  paths: Record<string, { get?: Operation; patch?: Operation }>;
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

export async function operation(): Promise<Operation> {
  const op = (await contract()).paths[PROFILE]?.patch;
  expect(op, `${PROFILE} PATCH must exist in the contract`).toBeDefined();
  expect(op!.operationId).toBe(OPERATION_ID);
  return op!;
}

async function detailOperation(): Promise<Operation> {
  const op = (await contract()).paths[DETAIL]?.get;
  expect(op, `${DETAIL} GET must exist in the contract`).toBeDefined();
  expect(op!.operationId).toBe('adminGetUser');
  return op!;
}

function check(op: Operation, response: Response) {
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const schema = op.responses[status]?.content?.['application/json']?.schema;
  expect(schema, `response ${status} must be in the contract`).toBeDefined();
  const validate = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  expect(validate(response.json()), JSON.stringify(validate.errors)).toBe(true);
}

/** The PATCH response against the contract response of its status class. */
export async function validate(response: Response) {
  check(await operation(), response);
}

/** A GET /admin/v1/users/{user_id} response against its contract. */
export async function validateDetail(response: Response) {
  check(await detailOperation(), response);
}
