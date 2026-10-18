import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

const root = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', root));
interface Operation {
  operationId: string;
  'x-implementation'?: string;
}
interface Contract {
  components: { schemas: Record<string, JsonSchema> };
  paths: Record<string, { get?: Operation; post?: Operation }>;
}
let document: Promise<Contract> | undefined;
export function contract() {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<Contract>;
  };
  document ??= parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', root)));
  return document;
}
export async function validate(value: unknown, name: 'PendingTracksResponse' | 'EmptyResponse') {
  const schema = (await contract()).components.schemas[name]!;
  const check = createValidatorCompiler()({ schema, httpPart: 'body' });
  expect(check(value), JSON.stringify(check.errors)).toBe(true);
}
