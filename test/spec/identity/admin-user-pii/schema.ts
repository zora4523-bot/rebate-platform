import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { apiRequire, type Response } from '../../admin/auth/kit.ts';

export const REVEAL = '/admin/v1/users/{user_id}/reveal';
type Operation = {
  'x-implementation'?: string;
  responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
};
interface Document {
  components: { schemas: Record<string, JsonSchema> };
  paths: Record<string, { post: Operation }>;
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

export async function checkSchema(name: string, value: unknown) {
  const schema = (await contract()).components.schemas[name]!;
  const check = createValidatorCompiler()({ schema, httpPart: 'body' });
  expect(check(value), JSON.stringify(check.errors)).toBe(true);
}

export async function validate(response: Response) {
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contract()).paths[REVEAL]!.post.responses[status]!.content[
    'application/json'
  ]!.schema;
  const check = createValidatorCompiler()({ schema, httpPart: 'body' });
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}
