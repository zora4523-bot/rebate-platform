import type { LedgerEntry, NegativeBalanceInput } from '@couli/domain';

export function userEntry(
  amount_fen: bigint,
  sub_account: 'available' | 'frozen' = 'available',
  account_id = 'user-42',
): LedgerEntry {
  return { account_id, account_code: 'USER_BALANCE', sub_account, amount_fen };
}

export function platformEntry(amount_fen: bigint): LedgerEntry {
  return {
    account_id: 'union-taobao',
    account_code: 'UNION_RECEIVABLE',
    sub_account: null,
    amount_fen,
  };
}

export function negativeInput(overrides: Partial<NegativeBalanceInput>): NegativeBalanceInput {
  return {
    ledger_type: 'REBATE_CREDIT',
    sub_type: null,
    uniq_key: 'taobao:1234567:42:self:CREDIT',
    resulting_available_fen: -1n,
    available_delta_fen: -1n,
    ...overrides,
  };
}
