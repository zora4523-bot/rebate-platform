// B1-28m (D10-462 ③, BR-PRICE-11): getHotRank takes the optional bearer token of searchProducts, in
// the contract and in the auth table generated from it. Stages ② ③ read that table, so without it
// the route never sees a token.
import { expect, it } from 'vitest';
import { contractAuthOf } from '../../../../apps/api/src/modules/platform/http/auth-routes.ts';
import { contract } from '../hot-rank/kit.ts';

it('[AC-B1-28m#1] 契约 getHotRank：x-auth optional，security 与 searchProducts 相同（游客或 bearerAuth），不签名、不幂等、错误码不变', async () => {
  const { paths } = await contract();
  const hot = paths['/v1/rank/hot']?.get;
  const search = paths['/v1/products/search']?.get;
  expect(hot).toMatchObject({
    operationId: 'getHotRank',
    'x-auth': 'optional',
    'x-signed': false,
    'x-idempotent': false,
    'x-error-codes': [20001, 50304],
    security: [{}, { bearerAuth: [] }],
  });
  expect(hot?.['x-auth']).toBe(search?.['x-auth']);
  expect(hot?.['security']).toEqual(search?.['security']);
});

it('[AC-B1-28m#2] 契约描述写明 optional 的依据：报价按当前用户（BR-PRICE-11），08 高于 04', async () => {
  const { paths } = await contract();
  const description = String(paths['/v1/rank/hot']?.get?.['description']);
  expect(description).toContain('BR-PRICE-11');
  expect(description).toMatch(/08\s+wins\s+over\s+04|08\s*高于\s*04/);
});

it('[AC-B1-28m#3] 生成的鉴权表：GET /v1/rank/hot 是 optional，HEAD 沿用 GET', () => {
  expect(contractAuthOf('GET', '/v1/rank/hot')).toBe('optional');
  expect(contractAuthOf('HEAD', '/v1/rank/hot')).toBe('optional');
});
