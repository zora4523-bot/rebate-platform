// Contract of the three read operations of F1-07b (contracts/openapi.yaml is the only source).
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { apiRequire, type Response } from '../../admin/auth/kit.ts';

export const LIST = '/admin/v1/users';
export const LOOKUP = '/admin/v1/users/lookup';
export const DETAIL = '/admin/v1/users/{user_id}';
export type Path = typeof LIST | typeof LOOKUP | typeof DETAIL;

export const OPERATIONS: Readonly<Record<Path, string>> = {
  [LIST]: 'adminListUsers',
  [LOOKUP]: 'adminLookupUser',
  [DETAIL]: 'adminGetUser',
};

export interface Operation {
  operationId: string;
  parameters?: unknown[];
  responses: Record<string, { content?: Record<string, { schema: JsonSchema }> }>;
}
interface Document {
  paths: Record<string, { get?: Operation }>;
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

export async function operation(path: Path): Promise<Operation> {
  const op = (await contract()).paths[path]?.get;
  expect(op, `${path} GET must exist in the contract`).toBeDefined();
  expect(op!.operationId).toBe(OPERATIONS[path]);
  return op!;
}

/** Validates a response body against the contract response of its status class. */
export async function validate(response: Response, path: Path) {
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await operation(path)).responses[status]!.content!['application/json']!.schema;
  const check = createValidatorCompiler()({ schema, httpPart: 'body' });
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}
