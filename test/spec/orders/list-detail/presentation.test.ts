import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  maskOrderNo,
  orderReasonActions,
  visibleOrderStart,
} from '../../../../apps/api/src/modules/orders/domain/query-rules.ts';

it.each([
  ['3712345678901234567', '3712****67'],
  ['251003-123456789012345', '2510****45'],
  ['12345678', '****78'],
  ['123456789', '****89'],
  ['1234567890', '1234****90'],
  ['1234-67890', '1234****90'],
  ['😀12345678', '****78'],
  ['😀123456789', '😀123****89'],
  ['1', '****1'],
  ['12', '****12'],
])('[AC-B1-08l#3] 脱敏按码点计算 %s → %s', (input, expected) => {
  expect(maskOrderNo(input)).toBe(expected);
});

it.each([
  ['2028-01-15T04:00:00.000Z', 12, '2027-01-01'],
  ['2028-01-15T04:00:00.000Z', 1, '2027-12-01'],
  ['2027-12-31T16:00:00.000Z', 12, '2027-01-01'],
  ['2027-12-31T15:59:59.999Z', 12, '2026-12-01'],
  ['2028-03-01T00:00:00.000Z', 25, '2026-02-01'],
  ['2028-01-15T04:00:00.000Z', 0, null],
] as const)('[AC-B1-08l#4] 可查范围 %s，%s 个月', (now, months, expected) => {
  expect(visibleOrderStart(new FixedClock(now), months)).toBe(expected);
});

const reasons: [Schema<'OrderReasonCode'> | null, string[]][] = [
  ['PUNISH', ['CONTACT_CS']],
  ['COMMISSION_ZERO', ['CONTACT_CS']],
  ['OTHER', ['CONTACT_CS']],
  ['BLACKLIST', ['APPEAL']],
  ['NOT_TRACKED', ['CLAIM']],
  ['RELATION_INVALID', ['REAUTH']],
  [null, []],
  ...(
    [
      'REFUND',
      'RIGHTS',
      'PRESALE_UNPAID',
      'PART_REFUND',
      'PRICE_COMPARE',
      'PRICE_PROTECT',
      'SETTLE_DIFF',
      'EXPIRED_CLICK',
      'OTHER_TLJ',
      'CANCELLED',
    ] as const
  ).map((reason): [Schema<'OrderReasonCode'>, string[]] => [reason, []]),
];
it.each(reasons)('[AC-B1-08l#5] 原因 %s 的动作只按 BR-TEXT-05', (reason, actions) => {
  expect(orderReasonActions(reason)).toEqual(actions);
});
