import { expect, it } from 'vitest';
import {
  inviteBackfillDeadline,
  inviterUnavailable,
  isInviteCodeFormat,
  normalizeInviteCode,
  type InviterFacts,
} from './index.ts';

const facts: InviterFacts = {
  risk_state: 'normal',
  deletion_status: null,
  phone_bound: true,
  verified_minor: false,
};

it('[AC-B1-11c#unit-1] 非布尔的 phone_bound / verified_minor 抛 RangeError，不按真假值放行', () => {
  for (const patch of [
    { phone_bound: 1 },
    { phone_bound: 'true' },
    { verified_minor: 0 },
    { verified_minor: null },
  ]) {
    expect(() => inviterUnavailable({ ...facts, ...patch } as unknown as InviterFacts)).toThrow(
      RangeError,
    );
  }
  expect(() => inviterUnavailable(null as unknown as InviterFacts)).toThrow(RangeError);
  expect(() =>
    inviterUnavailable({ ...facts, risk_state: 'toString' } as unknown as InviterFacts),
  ).toThrow(RangeError);
});

it('[AC-B1-11c#unit-2] 补填期限超出 Date 范围或小时数超出安全整数时抛 RangeError', () => {
  const createdAt = instant(0);
  expect(() => inviteBackfillDeadline(createdAt, 3_000_000_000)).toThrow(RangeError);
  expect(() => inviteBackfillDeadline(createdAt, Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  expect(inviteBackfillDeadline(createdAt, 1).getTime()).toBe(3_600_000);
});

it('[AC-B1-11c#unit-3] 规范化拒绝非字符串，格式检查对非字符串返回 false', () => {
  expect(() => normalizeInviteCode(123456 as unknown as string)).toThrow(RangeError);
  expect(isInviteCodeFormat(234567 as unknown as string)).toBe(false);
});

function instant(ms: number): Date {
  // eslint-disable-next-line no-restricted-syntax -- 由入参时间值构造，不读墙钟（D10-21）
  return new Date(ms);
}
