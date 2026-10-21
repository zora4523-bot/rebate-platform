import { createAppApi } from '../../../../apps/h5/src/shared/api/app-api.ts';
import type { BridgeMethods } from '@couli/bridge-sdk';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import { installBridge } from '../bridge-sdk/kit.ts';
import { reply, server } from '../h5-notices/fixtures.ts';
import dictionary from '../../../../contracts/texts.default.json' with { type: 'json' };

export { reply } from '../h5-notices/fixtures.ts';
export type LedgerEntry = components['schemas']['LedgerEntry'];
export const inviteName = dictionary.texts['ledger_type.REWARD.name_invite'];
export const inviteHint = dictionary.texts['ledger_type.REWARD.hint_invite'];
export const balanceTemplate = dictionary.texts['ledger.balance_after'];
// BR-TEXT-19 表原文（SPEC_REF）；CT-16f 尚未补齐的字典键使用这些默认值。
export const ledgerNames = {
  REBATE_CREDIT: '自购返利入账',
  SHARE_CREDIT: '分享收益入账',
  REFERRAL_CREDIT: '邀请分佣入账',
  INDIRECT: '好友推广奖励',
  CLAWBACK: '订单扣回',
  PART_REFUND: '部分退款扣回',
  SETTLE_ADJUST: '结算补差',
  WITHDRAW_FREEZE: '提现冻结',
  WITHDRAW_RETURN: '提现退回',
  WITHDRAW_PAID: '提现到账',
  WITHDRAW_FEE: '提现手续费',
  TAX_WITHHOLD: '代扣个税',
  BAD_DEBT_WRITEOFF: '负余额核销',
};
export const referralHint = '邀请好友订单';
export const adjustmentCopy = {
  RESTORE: ['订单恢复补发', '订单经核实恢复，补发对应金额'],
  RECON_FIX: ['结算核对更正', '按联盟结算核对结果更正'],
  PAYOUT_RECOVERY: ['重复到账追回', '追回重复或异常到账的提现金额'],
  OTHER: ['人工调账', '如有疑问请联系客服'],
} as const;
// Design app-ledger §7 / LedgerStates：BAD_DEBT_WRITEOFF hint 的占位原文。
export const writeoffHint = '余额为负的部分已由平台核销';
// Design app-ledger §7: these two strings currently have no contract dictionary key.
export const emptyTitle = '还没有余额变动';
export const emptyHint = '返利结算入账、提现等变动会显示在这里';
export const endText = '没有更多记录了';
export const orderId = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a91';
export const withdrawalId = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a90';
// Browser-safe data; the older app-api kit also re-exports Node-only filesystem helpers.
const nativeEnv: BridgeMethods['app.getEnv']['result'] = {
  platform: 'android',
  app_version: '2.4.6',
  build: '2468',
  channel: 'official',
  os_version: '15',
  bridge_version: 1,
  safe_area: { top: 0, right: 0, bottom: 0, left: 0 },
};

export function posting(
  overrides: Partial<components['schemas']['LedgerPostingEntry']> = {},
): components['schemas']['LedgerPostingEntry'] {
  return {
    ledger_type: 'REBATE_CREDIT',
    sub_type: null,
    amount_fen: 601,
    accounting_date: '2026-10-12',
    link_type: 'order',
    link_id: orderId,
    masked: false,
    balance_after_fen: 1234,
    ...overrides,
  };
}

export const invite = posting({
  ledger_type: 'REWARD',
  sub_type: 'invite',
  amount_fen: 1001,
  accounting_date: '2026-10-11',
  link_type: null,
  link_id: null,
  balance_after_fen: -567,
});

export const paid: components['schemas']['LedgerWithdrawPaidEntry'] = {
  ledger_type: 'WITHDRAW_PAID',
  sub_type: null,
  amount_fen: -9876,
  accounting_date: '2026-09-28',
  link_type: 'withdrawal',
  link_id: withdrawalId,
  masked: false,
  balance_after_fen: null,
  fee_fen: 23,
  tax_fen: 101,
};

export const entries: LedgerEntry[] = [
  posting(),
  posting({ ledger_type: 'REFERRAL_CREDIT', sub_type: 'DIRECT', amount_fen: 151, masked: true }),
  posting({ ledger_type: 'REFERRAL_CREDIT', sub_type: 'INDIRECT', amount_fen: 61, masked: true }),
  invite,
  posting({
    ledger_type: 'CLAWBACK',
    sub_type: 'PART_REFUND',
    amount_fen: -401,
    accounting_date: '2026-10-09',
  }),
  posting({
    ledger_type: 'WITHDRAW_RETURN',
    amount_fen: 801,
    accounting_date: '2026-10-08',
    link_type: 'withdrawal',
    link_id: withdrawalId,
  }),
  posting({ ledger_type: 'SHARE_CREDIT', amount_fen: 187, accounting_date: '2026-10-08' }),
  paid,
];

export function list(
  items: LedgerEntry[] = entries,
  next_cursor: string | null = null,
): components['schemas']['LedgerListData'] {
  return { items, next_cursor };
}

/** Real app API + SDK token manager; only native and HTTP boundaries are fake. */
export function ledgerServer(handler: Parameters<typeof server>[0] = () => reply(list())) {
  let tokens = 0;
  const native = installBridge(['app.getEnv', 'auth.getH5Token', 'nav.open'], (request) => {
    if (request.method === 'app.getEnv')
      return { id: request.id, code: 0, msg: '', data: nativeEnv };
    if (request.method === 'auth.getH5Token') {
      tokens += 1;
      return {
        id: request.id,
        code: 0,
        msg: '',
        data: {
          token: `ledger-token-${tokens}`,
          scope: 'standard',
          expire_at: '2099-01-01T00:00:00Z',
        },
      };
    }
    return { id: request.id, code: 0, msg: '', data: { opened: true } };
  });
  const http = server(handler);
  const api = createAppApi({
    env: { apiBaseUrl: 'https://api.example.invalid', appId: 'fixture_brand' },
    fetch: http.fetch,
  });
  return {
    api,
    requests: http.requests,
    tokenCalls: () => tokens,
    navigation: () =>
      native.postMessage.mock.calls
        .map(([request]) => request)
        .filter((request) => request.method === 'nav.open'),
  };
}
