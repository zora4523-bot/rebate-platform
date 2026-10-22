import { expect, it } from 'vitest';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import { contract, ZERO } from './kit.ts';

it('[AC-B2-04y#15] 钱包 operation 标记 implemented，生成请求 schema，保持 13 字段响应与登录权限', async () => {
  const doc = await contract();
  expect(doc.paths['/v1/wallet/summary']?.get).toMatchObject({
    operationId: 'getWalletSummary',
    'x-implementation': 'implemented',
    'x-auth': 'login',
    'x-signed': false,
    'x-idempotent': false,
    'x-session-scopes': ['full', 'deletion_only'],
  });
  expect(CONTRACT_ROUTE_SCHEMAS).toHaveProperty('getWalletSummary');
  const schema = doc.components.schemas['WalletSummary']!;
  expect(schema['additionalProperties']).toBe(false);
  expect([...(schema['required'] as string[])].sort()).toEqual(Object.keys(ZERO).sort());
  expect(Object.keys(schema['properties'] as object).sort()).toEqual(Object.keys(ZERO).sort());
});
