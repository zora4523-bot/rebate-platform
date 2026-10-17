// transitionWithdrawal 第三参数 outcome（CT-04d 编排者决定 3）：W10 的处置结果须属于 {to}∪alternatives，
// 单目标行传入不同结果一律拒绝；不传时行为与两参数调用相同。
import { expect, it } from 'vitest';
import { transitionWithdrawal } from '../index.ts';

const ILLEGAL = { ok: false, reason: 'illegal', id: null };

it('[AC-CT-04d-UNIT#3] W10 判失败经第三参数传 FAILED，得到 FAILED', () => {
  expect(transitionWithdrawal('PAYING', 'MANUAL_RESOLVE', 'FAILED')).toStrictEqual({
    ok: true,
    to: 'FAILED',
    id: 'W10',
    noop: false,
  });
});

it('[AC-CT-04d-UNIT#4] W10 传 PAID_API 或不传，得到 PAID_API', () => {
  const paid = { ok: true, to: 'PAID_API', id: 'W10', noop: false };
  expect(transitionWithdrawal('PAYING', 'MANUAL_RESOLVE', 'PAID_API')).toStrictEqual(paid);
  expect(transitionWithdrawal('PAYING', 'MANUAL_RESOLVE')).toStrictEqual(paid);
});

it('[AC-CT-04d-UNIT#5] W10 传表外结果 PAID_MANUAL、PAYING 被拒', () => {
  expect(transitionWithdrawal('PAYING', 'MANUAL_RESOLVE', 'PAID_MANUAL')).toStrictEqual(ILLEGAL);
  expect(transitionWithdrawal('PAYING', 'MANUAL_RESOLVE', 'PAYING')).toStrictEqual(ILLEGAL);
});

it('[AC-CT-04d-UNIT#6] 单目标行传不同结果被拒，传本行目标照常', () => {
  expect(transitionWithdrawal('PAYING', 'CHANNEL_SUCCESS', 'FAILED')).toStrictEqual(ILLEGAL);
  expect(transitionWithdrawal('PAYING', 'CHANNEL_FAIL', 'PAID_API')).toStrictEqual(ILLEGAL);
  expect(transitionWithdrawal('APPROVED', 'CHANNEL_SUCCESS_PROVEN', 'FAILED')).toStrictEqual(
    ILLEGAL,
  );
  expect(transitionWithdrawal('PAYING', 'CHANNEL_SUCCESS', 'PAID_API')).toStrictEqual({
    ok: true,
    to: 'PAID_API',
    id: 'W5',
    noop: false,
  });
});

it('[AC-CT-04d-UNIT#7] W7 自迁移只接受不传或当前状态，表外 (from, event) 传结果仍拒绝', () => {
  expect(transitionWithdrawal('PAYING', 'CHANNEL_UNKNOWN', 'PAYING')).toStrictEqual({
    ok: true,
    to: 'PAYING',
    id: 'W7',
    noop: true,
  });
  expect(transitionWithdrawal('PAYING', 'CHANNEL_UNKNOWN', 'FAILED')).toStrictEqual(ILLEGAL);
  expect(transitionWithdrawal('FAILED', 'MANUAL_RESOLVE', 'FAILED')).toStrictEqual(ILLEGAL);
});
