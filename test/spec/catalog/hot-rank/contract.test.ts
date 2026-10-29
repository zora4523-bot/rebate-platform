// B1-28h: getHotRank (CT-22c) leaves planned once implemented, and the generated route schema
// takes over request validation; anonymous access, error codes and the response shape unchanged.
import { expect, it } from 'vitest';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { contract } from './kit.ts';

it('[AC-B1-28h#29] 契约 getHotRank 不再标 planned、生成请求 schema；游客可访问（x-auth none、security []）、只有 20001 / 50304，响应形状不变', async () => {
  const doc = await contract();
  const op = doc.paths['/v1/rank/hot']?.get;
  expect(op).toBeDefined();
  expect(op).not.toHaveProperty('x-implementation');
  expect(plannedOperations.has('getHotRank')).toBe(false);
  expect(CONTRACT_ROUTE_SCHEMAS).toHaveProperty('getHotRank');
  expect(op).toMatchObject({
    operationId: 'getHotRank',
    'x-auth': 'none',
    'x-signed': false,
    'x-idempotent': false,
    'x-error-codes': [20001, 50304],
    security: [],
  });
  const names = ((op?.['parameters'] ?? []) as { name?: string; in?: string }[])
    .filter((parameter) => parameter.in === 'query')
    .map((parameter) => parameter.name)
    .sort();
  expect(names).toEqual(['category', 'cursor', 'platform']);

  const schemas = doc.components.schemas;
  const data = schemas['HotRankData'] as Record<string, unknown>;
  expect([...((data['required'] as string[] | undefined) ?? [])].sort()).toEqual([
    'categories',
    'channel',
    'items',
    'next_cursor',
    'notice_key',
  ]);
  expect((data['properties'] as Record<string, Record<string, unknown>>)['items']).toMatchObject({
    maxItems: 20,
  });
  const item = schemas['HotRankItem'] as Record<string, unknown>;
  expect([...((item['required'] as string[] | undefined) ?? [])].sort()).toEqual([
    'product_card',
    'rank',
    'sales_text',
  ]);
});
