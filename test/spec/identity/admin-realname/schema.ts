// B1-27a · contract of adminCorrectUserRealname (POST /admin/v1/users/{user_id}/realname-correction,
// CT-24q); contracts/openapi.yaml is the only source.
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { apiRequire, type Response } from '../../admin/auth/kit.ts';

export const CORRECTION = '/admin/v1/users/{user_id}/realname-correction';
export const OPERATION_ID = 'adminCorrectUserRealname';
/** The x-error-codes of CT-24q; this task does not change them. */
export const ERROR_CODES = [
  10001, 10003, 10403, 20001, 30405, 30406, 30407, 30419, 44001, 50301, 50401,
];

export interface Operation {
  operationId: string;
  'x-implementation'?: string;
  'x-error-codes'?: number[];
  parameters?: unknown[];
  responses: Record<string, { content?: Record<string, { schema: JsonSchema }> }>;
}
interface Document {
  paths: Record<string, { post?: Operation }>;
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
  const op = (await contract()).paths[CORRECTION]?.post;
  expect(op, `${CORRECTION} POST must exist in the contract`).toBeDefined();
  expect(op!.operationId).toBe(OPERATION_ID);
  return op!;
}

/** The response against the contract response of its status class. */
export async function validate(response: Response) {
  const op = await operation();
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const schema = op.responses[status]?.content?.['application/json']?.schema;
  expect(schema, `response ${status} must be in the contract`).toBeDefined();
  const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}
