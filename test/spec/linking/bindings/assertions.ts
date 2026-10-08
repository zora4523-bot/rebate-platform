import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { ACCOUNT_NAME, ROOT, type WireResponse } from './kit.ts';

const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
let schemas: Promise<Record<string, JsonSchema>> | undefined;
export async function validate(
  value: unknown,
  name: 'UnionBindingResponse' | 'UnionBindingsResponse' | 'ErrorEnvelope',
) {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  schemas ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    })
    .then((doc) => doc.components.schemas);
  const check = createValidatorCompiler()({ schema: (await schemas)[name]!, httpPart: 'body' });
  expect(check(value)).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}
export async function accepted(response: WireResponse) {
  expect(response.statusCode).toBe(200);
  await validate(response.json(), 'UnionBindingResponse');
  expect(response.json()).toMatchObject({
    code: 0,
    data: { platform: 'taobao', status: 'active' },
  });
  expect(response.json<{ data: unknown }>().data).toEqual({ platform: 'taobao', status: 'active' });
  expect(response.payload).not.toContain(ACCOUNT_NAME);
}
export async function rejected(response: WireResponse, code: number, reason?: string) {
  expect(response.statusCode).toBe(code === 10001 ? 401 : code === 20001 ? 400 : 422);
  await validate(response.json(), 'ErrorEnvelope');
  const body = response.json<{ code: number; data?: { reason?: string; auth_url?: string } }>();
  expect(body.code).toBe(code);
  expect(body.data?.reason).toBe(reason);
  expect(body.data ?? {}).not.toHaveProperty('auth_url');
}
