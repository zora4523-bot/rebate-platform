import { checkCreditInvariant } from '@couli/domain';
import { expect, it } from 'vitest';
import { deepFreeze, position } from './fixtures.ts';

it('[AC-B2-04e#29] BR-FUND-19⑤ 拒绝重复用户角色，不能把同一义务的待补记额重复相加', () => {
  expect(() =>
    checkCreditInvariant({
      booked_base_fen: 960n,
      booked_n_fen: 1200n,
      union_receivable_net_fen: 1040n,
      positions: [position(), position()],
    }),
  ).toThrow(RangeError);
});

it('[AC-B2-04e#20] BR-FUND-19⑤ 未完成义务剩余80，应收=booked N减80，而不是B减80', () => {
  expect(
    checkCreditInvariant({
      booked_base_fen: 960n,
      booked_n_fen: 1200n,
      union_receivable_net_fen: 1120n,
      positions: [position()],
    }),
  ).toEqual({
    pending_credit_fen: 80n,
    beneficiary_net_fen: 400n,
    expected_receivable_fen: 1120n,
    receivable_matches: true,
    beneficiary_net_within_base: true,
    valid: true,
  });
});

it('[AC-B2-04e#21] BR-FUND-19⑤ 没有未完成义务就没有待补记，封禁份额已归平台不可再算欠付', () => {
  expect(
    checkCreditInvariant({
      booked_base_fen: 960n,
      booked_n_fen: 1200n,
      union_receivable_net_fen: 1200n,
      positions: [position({ has_open_obligation: false })],
    }),
  ).toMatchObject({ pending_credit_fen: 0n, expected_receivable_fen: 1200n, valid: true });
});

it('[AC-B2-04e#22] BR-FUND-19⑤ 逐人截零后求和，不以一个人的超额抵销另一个人的待补记', () => {
  const positions = [
    position({ net_fen: 450n }),
    position({ user_id: 'u-direct', role: 'direct', ratio_bp: 1000n, net_fen: 20n }),
  ];
  expect(
    checkCreditInvariant({
      booked_base_fen: 800n,
      booked_n_fen: 1000n,
      union_receivable_net_fen: 940n,
      positions,
    }),
  ).toEqual({
    pending_credit_fen: 60n,
    beneficiary_net_fen: 470n,
    expected_receivable_fen: 940n,
    receivable_matches: true,
    beneficiary_net_within_base: true,
    valid: true,
  });
});

it('[AC-B2-04e#23] BR-FUND-19⑤ 整单包含全部未完成义务，不只本次执行对象', () => {
  expect(
    checkCreditInvariant({
      booked_base_fen: 800n,
      booked_n_fen: 1000n,
      union_receivable_net_fen: 520n,
      positions: [
        position({ net_fen: 0n }),
        position({ user_id: 'u-direct', role: 'direct', ratio_bp: 1000n, net_fen: 0n }),
      ],
    }),
  ).toMatchObject({
    pending_credit_fen: 480n,
    beneficiary_net_fen: 0n,
    expected_receivable_fen: 520n,
    valid: true,
  });
});

it('[AC-B2-04e#24] BR-FUND-19⑤ 应收差一分也不通过', () => {
  expect(
    checkCreditInvariant({
      booked_base_fen: 960n,
      booked_n_fen: 1200n,
      union_receivable_net_fen: 1121n,
      positions: [position()],
    }),
  ).toMatchObject({ receivable_matches: false, beneficiary_net_within_base: true, valid: false });
});

it('[AC-B2-04e#25] BR-FUND-19⑤ 应收相等但用户净额合计超过B仍失败，等于B允许', () => {
  const input = {
    booked_base_fen: 800n,
    booked_n_fen: 1000n,
    union_receivable_net_fen: 1000n,
    positions: [position({ net_fen: 801n, has_open_obligation: false })],
  };
  expect(checkCreditInvariant(input)).toMatchObject({
    receivable_matches: true,
    beneficiary_net_within_base: false,
    valid: false,
  });
  expect(
    checkCreditInvariant({
      ...input,
      positions: [position({ net_fen: 800n, has_open_obligation: false })],
    }),
  ).toMatchObject({ beneficiary_net_within_base: true, valid: true });
});

it('[AC-B2-04e#26] BR-FUND-19⑤ 当前booked B下调后按新份额360计算，预留仍用N口径', () => {
  expect(
    checkCreditInvariant({
      booked_base_fen: 720n,
      booked_n_fen: 900n,
      union_receivable_net_fen: 540n,
      positions: [
        position({ net_fen: 0n }),
        position({
          user_id: 'u-direct',
          role: 'direct',
          ratio_bp: 1000n,
          net_fen: 72n,
          has_open_obligation: false,
        }),
      ],
    }),
  ).toMatchObject({ pending_credit_fen: 360n, beneficiary_net_fen: 72n, valid: true });
});

it('[AC-B2-04e#27] BR-FUND-19⑤ 全部扣回后的零账本成立；计算不改变输入', () => {
  const input = deepFreeze({
    booked_base_fen: 0n,
    booked_n_fen: 0n,
    union_receivable_net_fen: 0n,
    positions: [position({ net_fen: 0n, has_open_obligation: false })],
  });
  const before = structuredClone(input);
  expect(checkCreditInvariant(input)).toEqual({
    pending_credit_fen: 0n,
    beneficiary_net_fen: 0n,
    expected_receivable_fen: 0n,
    receivable_matches: true,
    beneficiary_net_within_base: true,
    valid: true,
  });
  expect(input).toEqual(before);
});

it('[AC-B2-04e#28] BR-FUND-19⑤ 余额净额已包含恢复和扣回，剩余按净额而非历史CREDIT求差', () => {
  // 调用方聚合400 CREDIT -100 CLAWBACK +60 RESTORE=360，当前应得480，欠120。
  expect(
    checkCreditInvariant({
      booked_base_fen: 960n,
      booked_n_fen: 1200n,
      union_receivable_net_fen: 1080n,
      positions: [position({ net_fen: 360n })],
    }),
  ).toMatchObject({ pending_credit_fen: 120n, valid: true });
});
