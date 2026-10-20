// 单元测试：B2-01j buildVouchers 与模板生成器；规则测试在 test/spec/domain/ledger-templates。
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildVouchers } from './build-vouchers.ts';
import { renderLedgerTemplates } from './generate-templates.ts';

const header =
  'template_id,ledger_type,sub_type,uniq_key_pattern,line,account_owner,subject,sub_account,sign,amount_ref,note';

it('[AC-B2-01j#u1] templates.gen.ts 与 specs/ledger-templates.csv 逐字一致（--verify 同口径）', () => {
  const csv = readFileSync(new URL('../../../../specs/ledger-templates.csv', import.meta.url));
  const generated = readFileSync(new URL('./templates.gen.ts', import.meta.url), 'utf8');
  expect(renderLedgerTemplates(csv.toString('utf8'))).toBe(generated);
});

it('[AC-B2-01j#u2] 生成器保留引号、逗号、换行与 TBD 原文，表头不符则拒绝', () => {
  const text = `\uFEFF${header}\r\nA,T,,k:{x},1,user,USER_BALANCE,available,debit,a_fen,"x, ""y""\nz"\r\nA,T,,k:{x},2,platform,TBD(08 未定),,credit,a_fen,\r\n`;
  const out = renderLedgerTemplates(text);
  expect(out).toContain(JSON.stringify('x, "y"\nz'));
  expect(out).toContain(JSON.stringify('TBD(08 未定)'));
  expect(renderLedgerTemplates(text)).toBe(out);
  expect(() => renderLedgerTemplates('a,b\n1,2\n')).toThrow(/header/);
});

it('[AC-B2-01j#u3] 冻结凭证：借 available 正、贷 frozen 负，结果冻结不可改', () => {
  const vouchers = buildVouchers('WITHDRAW:FREEZE', {
    user_id: 'u1',
    withdrawal_id: 'w1',
    withdraw_fen: 3000n,
  });
  expect(vouchers).toHaveLength(1);
  expect(vouchers[0]?.uniq_key).toBe('wd:w1:FREEZE');
  expect(vouchers[0]?.entries.map((e) => [e.sub_account, e.amount_fen])).toEqual([
    ['available', 3000n],
    ['frozen', -3000n],
  ]);
  expect(Object.isFrozen(vouchers)).toBe(true);
  expect(Object.isFrozen(vouchers[0]?.entries)).toBe(true);
});

it('[AC-B2-01j#u4] 非字符串模板编号、非对象参数拒绝为 RangeError', () => {
  expect(() => buildVouchers(42 as unknown as string, {})).toThrow(RangeError);
  expect(() => buildVouchers('WITHDRAW:FREEZE', null as unknown as Record<string, bigint>)).toThrow(
    RangeError,
  );
  expect(() => buildVouchers('CREDIT:PLATFORM', { order_key: 'taobao:1' })).toThrow(RangeError);
});

it('[AC-B2-01l#u1] 平台行 csv 写 available，输出分录 sub_account 为 null（decision 29）', () => {
  const vouchers = buildVouchers('CREDIT:PLATFORM', {
    order_key: 'taobao:1',
    platform: 'taobao',
    platform_credit_fen: 494n,
  });
  expect(vouchers[0]?.uniq_key).toBe('taobao:1:PLATFORM:CREDIT');
  expect(vouchers[0]?.entries.map((e) => [e.account.subject, e.sub_account, e.amount_fen])).toEqual(
    [
      ['UNION_RECEIVABLE:taobao', null, 494n],
      ['COMMISSION_REVENUE', null, -494n],
    ],
  );
  expect(vouchers[0]?.entries.every((e) => e.ledger_type === 'REBATE_CREDIT')).toBe(true);
  expect(vouchers[0]?.entries.every((e) => e.sub_type === null)).toBe(true);
});

it('[AC-B2-01l#u2] order_key 的平台与 platform 参数不一致时拒绝', () => {
  const params = { order_key: 'jd:1', platform: 'taobao', platform_credit_fen: 1n };
  expect(() => buildVouchers('CREDIT:PLATFORM', params)).toThrow(RangeError);
  expect(buildVouchers('CREDIT:PLATFORM', { ...params, order_key: 'taobao:1' })).toHaveLength(1);
});

it('[AC-B2-01l#u3] 改派红冲按类型组逐组反向，零组省略，全部组为 0 不写凭证', () => {
  const groups = [
    'rebate_credit',
    'clawback_full',
    'clawback_part_refund',
    'clawback_rights',
    'clawback_punish',
    'settle_adjust_settle_diff',
    'settle_adjust_price_protect',
    'settle_adjust_price_compare',
    'admin_adjust_restore',
  ];
  const zero: Record<string, string | bigint> = {
    order_key: 'taobao:1',
    platform: 'taobao',
    reassign_id: 'a2',
  };
  for (const group of groups) {
    zero[`reassign_${group}_credit_fen`] = 0n;
    zero[`reassign_${group}_debit_fen`] = 0n;
  }
  expect(buildVouchers('REASSIGN_REV:PLATFORM', zero)).toEqual([]);
  const vouchers = buildVouchers('REASSIGN_REV:PLATFORM', {
    ...zero,
    reassign_rebate_credit_credit_fen: 500n,
    reassign_clawback_part_refund_debit_fen: 100n,
  });
  expect(vouchers).toHaveLength(1);
  expect(vouchers[0]?.uniq_key).toBe('taobao:1:PLATFORM:REASSIGN_REV:a2');
  expect(
    vouchers[0]?.entries.map((e) => [e.ledger_type, e.sub_type, e.account.subject, e.amount_fen]),
  ).toEqual([
    ['REBATE_CREDIT', null, 'COMMISSION_REVENUE', 500n],
    ['REBATE_CREDIT', null, 'UNION_RECEIVABLE:taobao', -500n],
    ['CLAWBACK', 'PART_REFUND', 'UNION_RECEIVABLE:taobao', 100n],
    ['CLAWBACK', 'PART_REFUND', 'COMMISSION_REVENUE', -100n],
  ]);
  expect(() => buildVouchers('REASSIGN_REV:BAD_DEBT', zero)).toThrow(RangeError);
  expect(() => buildVouchers('REWARD:newbie', {})).toThrow(RangeError);
});

it('[AC-B2-01l#u4] 提现成功一张凭证单键 wd:{id}:PAID，三种流水按 line 顺序、零金额分录不写', () => {
  const full = buildVouchers('WITHDRAW:SUCCESS:CASH_WECHAT', {
    withdrawal_id: 'w9',
    user_id: 'u1',
    net_fen: 9700n,
    fee_fen: 100n,
    tax_fen: 200n,
  });
  expect(full.map((voucher) => voucher.uniq_key)).toEqual(['wd:w9:PAID']);
  expect(
    full[0]?.entries.map((entry) => [
      entry.ledger_type,
      entry.account.subject,
      entry.sub_account,
      entry.amount_fen,
    ]),
  ).toEqual([
    ['WITHDRAW_PAID', 'USER_BALANCE', 'frozen', 9700n],
    ['WITHDRAW_PAID', 'CASH_WECHAT', null, -9700n],
    ['WITHDRAW_FEE', 'USER_BALANCE', 'frozen', 100n],
    ['WITHDRAW_FEE', 'FEE_INCOME', null, -100n],
    ['TAX_WITHHOLD', 'USER_BALANCE', 'frozen', 200n],
    ['TAX_WITHHOLD', 'TAX_PAYABLE', null, -200n],
  ]);
  const noFee = buildVouchers('WITHDRAW:SUCCESS:CASH_ALIPAY', {
    withdrawal_id: 'w9',
    user_id: 'u1',
    net_fen: 3000n,
    fee_fen: 0n,
    tax_fen: 0n,
  });
  expect(noFee).toHaveLength(1);
  expect(noFee[0]?.uniq_key).toBe('wd:w9:PAID');
  expect(noFee[0]?.entries.map((entry) => entry.ledger_type)).toEqual([
    'WITHDRAW_PAID',
    'WITHDRAW_PAID',
  ]);
});

it('[AC-B2-16a#u1] 邀请奖励：每方一张凭证，借 MKT_EXPENSE、贷 USER_BALANCE.available，键按被邀请人与受益方', () => {
  const vouchers = buildVouchers('REWARD:INVITE', {
    invitee_user_id: 'u2',
    side: 'inviter',
    user_id: 'u1',
    reward_fen: 1000n,
  });
  expect(vouchers.map((voucher) => voucher.uniq_key)).toEqual(['INVITE_REWARD:u2:inviter']);
  expect(
    vouchers[0]?.entries.map((e) => [
      e.account.owner_type,
      e.account.owner_id,
      e.account.subject,
      e.sub_account,
      e.amount_fen,
      e.ledger_type,
      e.sub_type,
    ]),
  ).toEqual([
    ['platform', 'platform', 'MKT_EXPENSE', null, 1000n, 'REWARD', 'invite'],
    ['user', 'u1', 'USER_BALANCE', 'available', -1000n, 'REWARD', 'invite'],
  ]);
  const invitee = buildVouchers('REWARD:INVITE', {
    invitee_user_id: 'u2',
    side: 'invitee',
    user_id: 'u2',
    reward_fen: 1000n,
  });
  expect(invitee[0]?.uniq_key).toBe('INVITE_REWARD:u2:invitee');
  expect(invitee[0]?.entries[1]?.account.owner_id).toBe('u2');
});

it('[AC-B2-16a#u2] 邀请奖励：side 非法时拒绝，金额为 0 与其他模板一样不出凭证', () => {
  const base = { invitee_user_id: 'u2', user_id: 'u1', reward_fen: 1000n };
  expect(() => buildVouchers('REWARD:INVITE', { ...base, side: 'self' })).toThrow(RangeError);
  expect(buildVouchers('REWARD:INVITE', { ...base, side: 'inviter', reward_fen: 0n })).toEqual([]);
  expect(() => buildVouchers('REWARD:INVITE', { ...base, side: 'self', reward_fen: 0n })).toThrow(
    RangeError,
  );
  expect(() => buildVouchers('REWARD:NEWBIE', { ...base, side: 'inviter' })).toThrow(RangeError);
});
