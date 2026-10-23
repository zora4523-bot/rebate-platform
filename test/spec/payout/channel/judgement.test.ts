import { expect, it } from 'vitest';
import {
  judgeQuery,
  judgeTransfer,
} from '../../../../apps/api/src/modules/payout/application/judgement.ts';
import { EMPTY_LISTS, VERIFIED_TEST_LISTS } from './fixtures.ts';

it.each([
  { code: '10000', subCode: undefined, kind: 'success', pause: false },
  { code: '40004', subCode: 'TEST_CONFIRMED_FAIL', kind: 'fail', pause: false },
  { code: '40004', subCode: 'TEST_PAYER_SIDE', kind: 'payer_side', pause: true },
  { code: '40004', subCode: 'TEST_UNRECOGNIZED', kind: 'unknown', pause: true },
])('[AC-B2-06b#1] transfer $code/$subCode -> $kind using only configured lists', (row) => {
  const raw = {
    code: row.code,
    ...(row.subCode ? { subCode: row.subCode } : {}),
    msg: 'test evidence',
  };
  const result = judgeTransfer(raw, VERIFIED_TEST_LISTS);
  expect(result.kind).toBe(row.kind);
  expect(result.pauseQueue === true).toBe(row.pause);
  expect(result.raw).toStrictEqual(raw);
});

it.each([
  'PAYEE_NOT_EXIST',
  'PAYER_BALANCE_NOT_ENOUGH',
  'EXCEED_LIMIT_DM_AMOUNT',
  'UNKNOWN_NEW_CODE',
])('[AC-B2-06b#2] unverified example %s remains unknown and pauses the queue', (subCode) => {
  const raw = { code: '40004', subCode, msg: 'synthetic, not a platform recording' };
  const result = judgeTransfer(raw, EMPTY_LISTS);
  expect(result).toMatchObject({ kind: 'unknown', pauseQueue: true, raw });
});

it.each(['20000', '40004', '10001', '10000 ', 'success'])(
  '[AC-B2-06b#3] no broad success inference from business code %s',
  (code) => {
    expect(judgeTransfer({ code }, EMPTY_LISTS)).toMatchObject({
      kind: 'unknown',
      pauseQueue: true,
    });
  },
);

it('[AC-B2-06b#4] fail/payer lists match subCode exactly, not code or message substrings', () => {
  for (const raw of [
    { code: 'TEST_CONFIRMED_FAIL' },
    { code: '40004', msg: 'TEST_PAYER_SIDE' },
    { code: '40004', subCode: 'test_confirmed_fail' },
    { code: '40004', subCode: 'TEST_CONFIRMED_FAIL_EXTRA' },
  ]) {
    expect(judgeTransfer(raw, VERIFIED_TEST_LISTS)).toMatchObject({
      kind: 'unknown',
      pauseQueue: true,
    });
  }
});

it.each([
  'SUCCESS',
  'FAIL',
  'PROCESSING',
  'ORDER_NOT_EXIST',
  'WAIT_PAY',
  'success',
  '',
  'toString',
  '__proto__',
])('[AC-B2-06b#5] default query mapping for %s is conservative and uses own keys', (status) => {
  const raw = { code: '10000', msg: 'query accepted' };
  expect(judgeQuery(raw, status, EMPTY_LISTS)).toStrictEqual({
    kind: status === 'SUCCESS' ? 'success' : 'unknown',
    raw,
  });
});

it.each([
  ['SUCCESS', 'success'],
  ['TEST_FINAL_FAIL', 'fail'],
  ['TEST_PENDING', 'unknown'],
  ['OTHER', 'unknown'],
])(
  '[AC-B2-06b#6] configured query status %s -> %s without consulting transfer lists',
  (status, kind) => {
    const raw = { code: '10000', subCode: 'TEST_PAYER_SIDE' };
    expect(judgeQuery(raw, status, VERIFIED_TEST_LISTS)).toStrictEqual({ kind, raw });
  },
);

it('[AC-B2-06b#7] missing query status and order-not-found errors cannot become success or failure', () => {
  expect(judgeQuery({ code: '10000' }, undefined, EMPTY_LISTS).kind).toBe('unknown');
  expect(
    judgeQuery({ code: '40004', subCode: 'ORDER_NOT_EXIST' }, undefined, EMPTY_LISTS).kind,
  ).toBe('unknown');
});
