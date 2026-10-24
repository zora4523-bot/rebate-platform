// B1-22o / CT-24s adminListUnionAccountOptions (D10-243), SPEC_REF ec81e62: the operation goes live
// (x-implementation planned removed) and keeps its contract shape: admin identity, read only (no
// step-up header, no Idempotency-Key), an optional `platform` query, codes 10001 / 10403 / 20001.
import { expect, it } from 'vitest';
import { OPERATION_ID, PATH, paths } from './kit.ts';

it('[B1-22o][D10-243] GET /admin/v1/union/account-options 上线移除 planned；后台身份、只读、无动态码与幂等键，可选 platform 查询参数', async () => {
  const operation = (await paths())[PATH]?.['get'];
  expect(operation).toBeDefined();
  expect(operation!.operationId).toBe(OPERATION_ID);
  expect(operation!['x-implementation']).toBeUndefined();
  expect(operation!['x-auth']).toBe('admin');
  const parameters = operation!.parameters.map((p) => p.name.toLowerCase());
  expect(parameters).not.toContain('x-step-up-token');
  expect(parameters).not.toContain('idempotency-key');
  const query = operation!.parameters.filter((p) => p.in === 'query');
  expect(query.map((p) => p.name)).toEqual(['platform']);
  expect(query[0]!.required ?? false).toBe(false);
  expect([...operation!['x-error-codes']].sort()).toEqual([10001, 10403, 20001]);
  expect(Object.keys((await paths())[PATH]!)).toEqual(['get']);
});
