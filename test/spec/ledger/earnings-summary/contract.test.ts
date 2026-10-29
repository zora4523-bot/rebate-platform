// B2-13a：getEarningsSummary 去掉 planned 后由生成物接管请求校验；响应形状保持 BR-FUND-25 /
// BR-INV-16、17 的三栏（邀请栏只有本月、上月，没有笔数，可为 null）。
import { expect, it } from 'vitest';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { contract } from '../wallet-summary/kit.ts';

const ROUTE = '/v1/earnings/summary';

function keysOf(schema: unknown, field: 'properties' | 'required'): string[] {
  const value = (schema as Record<string, unknown>)[field];
  return (Array.isArray(value) ? [...(value as string[])] : Object.keys(value as object)).sort();
}

it('[AC-B2-13a#10] 契约 getEarningsSummary 不再标 planned、生成请求 schema；登录权限、30701 与三栏响应形状不变', async () => {
  const doc = await contract();
  const op = doc.paths[ROUTE]?.get;
  expect(op).not.toHaveProperty('x-implementation');
  expect(plannedOperations.has('getEarningsSummary')).toBe(false);
  expect(CONTRACT_ROUTE_SCHEMAS).toHaveProperty('getEarningsSummary');
  expect(op).toMatchObject({
    operationId: 'getEarningsSummary',
    'x-auth': 'login',
    'x-signed': false,
    'x-idempotent': false,
    'x-error-codes': [30701],
  });
  const schemas = doc.components.schemas;
  for (const name of ['EarningsSummary', 'EarningsColumn', 'EarningsPeriod']) {
    expect(schemas[name]?.['additionalProperties'], name).toBe(false);
  }
  expect(keysOf(schemas['EarningsSummary'], 'required')).toEqual([
    'as_of',
    'referral',
    'self',
    'share',
  ]);
  expect(keysOf(schemas['EarningsColumn'], 'required')).toEqual([
    'last_month',
    'this_month',
    'today',
    'yesterday',
  ]);
  expect(keysOf(schemas['EarningsPeriod'], 'properties')).toEqual([
    'credited_fen',
    'est_fen',
    'paid_count',
  ]);
  expect(keysOf(schemas['ReferralEarnings'], 'properties')).toEqual(['last_month', 'this_month']);
  expect(keysOf(schemas['ReferralEarningsPeriod'], 'properties')).toEqual([
    'credited_fen',
    'est_fen',
  ]);
});
