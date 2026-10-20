import {
  applyEntries,
  buildVouchers,
  validateVoucher,
  type BuildVoucherParams,
  type BuiltVoucher,
} from '@couli/domain';
import { addFen, subFen } from '@couli/money';
import { expect, it } from 'vitest';

// SPEC_REF 5ecafb3: BR-INV-24 ⑦⑧, BR-FUND-01/13/15/16; task §9 decision 37.
// The pure builder has no app_id, clock, persistence or delivery semantics. B2-16b owns those.
const template = 'REWARD:INVITE';
const params = {
  invitee_user_id: 'invitee-42',
  side: 'inviter',
  user_id: 'inviter-7',
  reward_fen: 1000n,
} as const;

function build(input: BuildVoucherParams): BuiltVoucher {
  let vouchers: readonly BuiltVoucher[] = [];
  // Missing registration must be an assertion failure, not an uncaught RangeError.
  expect(() => {
    vouchers = buildVouchers(template, input);
  }).not.toThrow();
  expect(vouchers).toHaveLength(1);
  return vouchers[0]!;
}

it('[AC-B2-16a#1] 双方分别取得独立两行凭证，营销费用借记、单一余额 available 贷记且逐分平衡', () => {
  for (const [side, userId] of [
    ['inviter', 'inviter-7'],
    ['invitee', 'invitee-42'],
  ] as const) {
    for (const amount of [1n, 617n, 1000n, 9007199254740993n, 9223372036854775807n]) {
      const voucher = build({ ...params, side, user_id: userId, reward_fen: amount });
      expect(voucher).toEqual({
        uniq_key: `INVITE_REWARD:invitee-42:${side}`,
        entries: [
          {
            account: { owner_type: 'platform', owner_id: 'platform', subject: 'MKT_EXPENSE' },
            // Existing domain convention: platform CSV available maps to null.
            sub_account: null,
            amount_fen: amount,
            ledger_type: 'REWARD',
            sub_type: 'invite',
          },
          {
            account: { owner_type: 'user', owner_id: userId, subject: 'USER_BALANCE' },
            sub_account: 'available',
            amount_fen: subFen(0n, amount),
            ledger_type: 'REWARD',
            sub_type: 'invite',
          },
        ],
      });
      expect(voucher.entries.reduce((sum, entry) => addFen(sum, entry.amount_fen), 0n)).toBe(0n);
      const entries = voucher.entries.map((entry) => ({
        account_id: entry.account.owner_id,
        account_code: entry.account.subject,
        sub_account: entry.sub_account,
        amount_fen: entry.amount_fen,
      }));
      expect(validateVoucher(entries)).toEqual({ ok: true });
      expect(
        applyEntries({ account_id: userId, available_fen: 0n, frozen_fen: 73n }, entries),
      ).toEqual({ account_id: userId, available_fen: amount, frozen_fen: 73n });
    }
  }
});

it('[AC-B2-16a#2] 幂等键只按被邀请人与受益方隔离，重放稳定且不修改输入或先前凭证', () => {
  const input = Object.freeze({ ...params });
  const first = build(input);
  const saved = structuredClone(first);
  expect(build(input)).toEqual(saved);
  expect(build({ ...input, reward_fen: 617n }).uniq_key).toBe(first.uniq_key);
  expect(build({ ...input, user_id: 'another-inviter' }).uniq_key).toBe(first.uniq_key);
  expect(build({ ...input, side: 'invitee', user_id: input.invitee_user_id }).uniq_key).toBe(
    'INVITE_REWARD:invitee-42:invitee',
  );
  expect(build({ ...input, invitee_user_id: 'invitee-43' }).uniq_key).toBe(
    'INVITE_REWARD:invitee-43:inviter',
  );
  expect(first).toEqual(saved);
  expect(input).toEqual(params);
});

it('[AC-B2-16a#3] 奖励只接受正 int64 bigint 分，零、负数、溢出与隐式转换均拒绝', () => {
  expect(build(params).entries).toHaveLength(2);
  for (const amount of [
    0n,
    -1n,
    -9223372036854775808n,
    9223372036854775808n,
    '1000',
    1000,
    0.5,
    NaN,
    Infinity,
    null,
    undefined,
  ]) {
    expect(
      () =>
        buildVouchers(template, { ...params, reward_fen: amount } as unknown as BuildVoucherParams),
      `reward_fen=${String(amount)}`,
    ).toThrow(RangeError);
  }
});

it('[AC-B2-16a#4] 四个必要字段逐项缺失均拒绝，不从用户或订单推断被邀请人和金额', () => {
  expect(build(params).uniq_key).toBe('INVITE_REWARD:invitee-42:inviter');
  for (const field of Object.keys(params)) {
    const missing: Record<string, string | bigint> = { ...params };
    delete missing[field];
    expect(() => buildVouchers(template, missing), field).toThrow(RangeError);
  }
});

it('[AC-B2-16a#5] side 严格限定 inviter 和 invitee，不接受其他受益角色或大小写别名', () => {
  expect(build(params).entries).toHaveLength(2);
  for (const side of [
    '',
    'self',
    'share',
    'direct',
    'indirect',
    'INVITER',
    'INVITEE',
    'inviter ',
    'invitee:REVERSE',
    1n,
    null,
    undefined,
  ]) {
    expect(
      () => buildVouchers(template, { ...params, side } as unknown as BuildVoucherParams),
      `side=${String(side)}`,
    ).toThrow(RangeError);
  }
});

it('[AC-B2-16a#6] 被邀请人与受益用户标识拒绝空值和冒号注入，避免凭证键碰撞或串户', () => {
  expect(build(params).entries).toHaveLength(2);
  for (const field of ['invitee_user_id', 'user_id']) {
    for (const value of ['', ':', 'left:right', 42n, null, undefined]) {
      expect(
        () =>
          buildVouchers(template, { ...params, [field]: value } as unknown as BuildVoucherParams),
        `${field}=${String(value)}`,
      ).toThrow(RangeError);
    }
  }
});

it('[AC-B2-16a#7] 邀请奖励无需订单上下文，不能混入订单迁移、分佣份额或税费参数', () => {
  const voucher = build(params);
  expect(voucher).not.toHaveProperty('order_key');
  for (const entry of voucher.entries) expect(entry).not.toHaveProperty('order_key');
  for (const [field, value] of Object.entries({
    order_key: 'taobao:1234567',
    rebate_status: 'CREDITED',
    role: 'direct',
    share_fen: 1000n,
    tax_fen: 1n,
    fee_fen: 1n,
  })) {
    expect(() => buildVouchers(template, { ...params, [field]: value }), field).toThrow(RangeError);
  }
});

it('[AC-B2-16a#8] invite 已启用时新人奖和签到奖仍未登记，未知模板不能套用邀请模板', () => {
  expect(build(params).entries).toHaveLength(2);
  for (const id of [
    'REWARD:NEWBIE',
    'REWARD:CHECKIN',
    'REWARD:newbie',
    'REWARD:checkin',
    'REWARD:invite',
    'REWARD',
    'REWARD:UNKNOWN',
  ]) {
    expect(() => buildVouchers(id, params), id).toThrow(RangeError);
  }
});
