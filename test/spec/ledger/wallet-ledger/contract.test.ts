// B2-04zc：listWalletLedger 去掉 planned 后由生成物接管请求校验；响应形状保持 BR-FUND-15 /
// BR-TEXT-19 的两种条目（available 子户分录、WITHDRAW_PAID 汇总条目）与游标分页。
import { expect, it } from 'vitest';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { contract } from '../wallet-summary/kit.ts';

const ROUTE = '/v1/wallet/ledger';

function keysOf(schema: unknown, field: 'properties' | 'required'): string[] {
  const value = (schema as Record<string, unknown>)[field];
  return (Array.isArray(value) ? [...(value as string[])] : Object.keys(value as object)).sort();
}

const COMMON = [
  'accounting_date',
  'amount_fen',
  'balance_after_fen',
  'ledger_type',
  'link_id',
  'link_type',
  'masked',
  'sub_type',
];

it('[AC-B2-04zc#9] 契约 listWalletLedger 不再标 planned、生成请求 schema；登录权限、cursor + limit 与两种条目形状不变', async () => {
  const doc = await contract();
  const op = doc.paths[ROUTE]?.get;
  expect(op).not.toHaveProperty('x-implementation');
  expect(plannedOperations.has('listWalletLedger')).toBe(false);
  expect(CONTRACT_ROUTE_SCHEMAS).toHaveProperty('listWalletLedger');
  expect(op).toMatchObject({
    operationId: 'listWalletLedger',
    'x-auth': 'login',
    'x-signed': false,
    'x-idempotent': false,
  });
  const parameters = (op?.['parameters'] ?? []) as { name: string; in: string }[];
  expect(
    parameters
      .filter((p) => p.in === 'query')
      .map((p) => p.name)
      .sort(),
  ).toEqual(['cursor', 'limit']);
  const schemas = doc.components.schemas;
  for (const name of ['LedgerPostingEntry', 'LedgerWithdrawPaidEntry', 'LedgerListData']) {
    expect(schemas[name]?.['additionalProperties'], name).toBe(false);
  }
  expect(keysOf(schemas['LedgerPostingEntry'], 'required')).toEqual(COMMON);
  expect(keysOf(schemas['LedgerPostingEntry'], 'properties')).toEqual(COMMON);
  const paid = [...COMMON, 'fee_fen', 'tax_fen'].sort();
  expect(keysOf(schemas['LedgerWithdrawPaidEntry'], 'required')).toEqual(paid);
  expect(keysOf(schemas['LedgerWithdrawPaidEntry'], 'properties')).toEqual(paid);
  expect(keysOf(schemas['LedgerListData'], 'required')).toEqual(['items', 'next_cursor']);
});
