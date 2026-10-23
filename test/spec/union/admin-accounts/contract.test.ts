// B1-22d / BR-ID-24 ③, SPEC_REF 48e55e6: the five admin-unions account operations go live.
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { apiRequire } from '../../admin/auth/kit.ts';

const operations = [
  ['get', '/admin/v1/union-accounts', 'adminListUnionAccounts', false],
  [
    'post',
    '/admin/v1/union-accounts/{union_account_id}/reauthorize',
    'adminStartUnionReauthorization',
    true,
  ],
  [
    'get',
    '/admin/v1/union-accounts/{union_account_id}/reauthorize/{session_id}',
    'adminGetUnionReauthorization',
    false,
  ],
  ['post', '/admin/v1/union-accounts/oauth/callback', 'adminCompleteUnionReauthorization', false],
  [
    'put',
    '/admin/v1/union-accounts/{union_account_id}/credential',
    'adminPutUnionCredential',
    true,
  ],
] as const;

interface OperationDoc {
  operationId: string;
  'x-implementation'?: string;
  'x-auth': string;
  'x-error-codes': number[];
  parameters: { name: string }[];
}

async function paths() {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{ paths: Record<string, Record<string, OperationDoc>> }>;
  };
  const doc = await parser.dereference(
    fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  return doc.paths;
}

it.each(operations)(
  '[B1-22d][BR-ID-24] %s %s 上线移除 planned；后台身份、无幂等键，只有写操作要 step-up',
  async (method, path, operationId, stepUp) => {
    const operation = (await paths())[path]?.[method];
    expect(operation).toBeDefined();
    expect(operation!.operationId).toBe(operationId);
    expect(operation!['x-implementation']).not.toBe('planned');
    expect(operation!['x-auth']).toBe('admin');
    const parameters = operation!.parameters.map((p) => p.name.toLowerCase());
    expect(parameters).not.toContain('idempotency-key');
    if (stepUp) {
      expect(parameters).toContain('x-step-up-token');
      expect(operation!['x-error-codes']).toContain(10003);
    } else {
      expect(parameters).not.toContain('x-step-up-token');
      expect(operation!['x-error-codes']).not.toContain(10003);
    }
    expect(operation!['x-error-codes']).toContain(10403);
  },
);

it('[B1-22d][BR-ID-24] 联盟账号资源不提供删除', async () => {
  const doc = await paths();
  const live = operations.map(([method, path]) => doc[path]?.[method]?.['x-implementation']);
  expect(live).toEqual(operations.map(() => undefined));
  for (const [, path] of operations) expect(doc[path]).not.toHaveProperty('delete');
});
