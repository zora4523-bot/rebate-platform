// Unit tests of appealAttempts (CT-26e; BR-ID-36 细则): attempt_no and can_resubmit computed from
// the caller's appeal history only. The SQL runs against PostgreSQL in the rule tests.
import { expect, it } from 'vitest';
import {
  appealAttempts,
  MAX_APPEAL_ATTEMPTS,
  nextAppealAttempt,
  type AccountRestriction,
  type AppealHistoryRow,
} from './appeals.ts';

const NOW = new Date('2026-10-23T02:00:00.000Z');
const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a01';

function account(
  n: number,
  status: string,
  prev: 'frozen' | 'banned' = 'banned',
): AppealHistoryRow {
  return {
    id: `0199a3b4-5c6d-7e8f-9a0b-00000000000${n}`,
    target_type: 'account',
    target_id: USER,
    status,
    prev_risk_state: prev,
    created_at: new Date(Date.UTC(2026, 8, n)),
  };
}

const BANNED: AccountRestriction = { state: 'banned', frozen_until: null };

it('[AC-CT-26e-UNIT#1] attempt_no counts appeals on the same target and penalty from 1', () => {
  const rows = [account(1, 'upheld'), account(2, 'upheld'), account(3, 'processing')];
  const result = appealAttempts([...rows].reverse(), BANNED, NOW);
  expect(rows.map((row) => result.get(row.id)?.attempt_no)).toEqual([1, 2, 3]);
  expect(rows.map((row) => result.get(row.id)?.can_resubmit)).toEqual([false, false, false]);
});

it('[AC-CT-26e-UNIT#2] latest upheld appeal with attempts left on a still-restricted account → can_resubmit', () => {
  const rows = [account(1, 'upheld'), account(2, 'upheld')];
  expect(appealAttempts(rows, BANNED, NOW).get(rows[1]!.id)).toEqual({
    attempt_no: 2,
    can_resubmit: true,
  });
  const frozen = { state: 'frozen', frozen_until: new Date(NOW.getTime() + 1000) } as const;
  const one = [account(1, 'upheld', 'frozen')];
  expect(appealAttempts(one, frozen, NOW).get(one[0]!.id)?.can_resubmit).toBe(true);
});

it('[AC-CT-26e-UNIT#3] the third upheld appeal of one penalty uses up the attempts', () => {
  const rows = [account(1, 'upheld'), account(2, 'upheld'), account(3, 'upheld')];
  const last = appealAttempts(rows, BANNED, NOW).get(rows[2]!.id);
  expect(last).toEqual({ attempt_no: MAX_APPEAL_ATTEMPTS, can_resubmit: false });
});

it('[AC-CT-26e-UNIT#4] no resubmission when the account is no longer restricted', () => {
  const rows = [account(1, 'upheld', 'frozen')];
  const expired = { state: 'frozen', frozen_until: new Date(NOW.getTime() - 1) } as const;
  expect(appealAttempts(rows, expired, NOW).get(rows[0]!.id)?.can_resubmit).toBe(false);
  const normal = { state: 'normal', frozen_until: null } as const;
  expect(appealAttempts(rows, normal, NOW).get(rows[0]!.id)?.can_resubmit).toBe(false);
  expect(appealAttempts(rows, null, NOW).get(rows[0]!.id)?.can_resubmit).toBe(false);
});

it('[AC-CT-26e-UNIT#5] a revoked appeal or a frozen → banned change starts a new penalty at 1', () => {
  const rows = [
    account(1, 'upheld', 'frozen'),
    account(2, 'upheld', 'frozen'),
    account(3, 'upheld', 'frozen'),
    account(4, 'upheld', 'banned'),
    account(5, 'revoked', 'banned'),
    account(6, 'upheld', 'banned'),
  ];
  const result = appealAttempts(rows, BANNED, NOW);
  expect(rows.map((row) => result.get(row.id)?.attempt_no)).toEqual([1, 2, 3, 1, 2, 1]);
  // Escalated after three upheld appeals on the freeze: the ban is a new penalty.
  const escalated = rows.slice(0, 3);
  expect(appealAttempts(escalated, BANNED, NOW).get(rows[2]!.id)?.can_resubmit).toBe(true);
});

it('[AC-CT-26e-UNIT#6] order appeals count per order and never offer a resubmission yet', () => {
  const order = (n: number, target: string, status: string): AppealHistoryRow => ({
    id: `0199a3b4-5c6d-7e8f-9a0b-10000000000${n}`,
    target_type: 'order',
    target_id: target,
    status,
    prev_risk_state: null,
    created_at: new Date(Date.UTC(2026, 8, n)),
  });
  const rows = [order(1, 'a', 'upheld'), order(2, 'b', 'upheld'), order(3, 'a', 'upheld')];
  const result = appealAttempts(rows, BANNED, NOW);
  expect(rows.map((row) => result.get(row.id))).toEqual([
    { attempt_no: 1, can_resubmit: false },
    { attempt_no: 1, can_resubmit: false },
    { attempt_no: 2, can_resubmit: false },
  ]);
});

it('[AC-CT-26e-UNIT#9] after the third upheld appeal of one penalty can_resubmit is false whatever the current state', () => {
  const rows = [account(1, 'upheld'), account(2, 'upheld'), account(3, 'upheld')];
  // banned → frozen is the same penalty: the attempts stay used up.
  const frozen = { state: 'frozen', frozen_until: null } as const;
  expect(appealAttempts(rows, frozen, NOW).get(rows[2]!.id)).toEqual({
    attempt_no: 3,
    can_resubmit: false,
  });
  expect(appealAttempts(rows, BANNED, NOW).get(rows[2]!.id)?.can_resubmit).toBe(false);
});

it('[AC-CT-26e-UNIT#10] nextAppealAttempt is the 30418 rule: above the cap only within one penalty', () => {
  expect(nextAppealAttempt(undefined, 0, 'banned')).toBe(1);
  expect(nextAppealAttempt({ status: 'upheld', prev_risk_state: 'banned' }, 3, 'banned')).toBe(4);
  expect(nextAppealAttempt({ status: 'upheld', prev_risk_state: 'banned' }, 3, 'frozen')).toBe(4);
  expect(nextAppealAttempt({ status: 'upheld', prev_risk_state: 'frozen' }, 3, 'banned')).toBe(1);
  expect(nextAppealAttempt({ status: 'revoked', prev_risk_state: 'banned' }, 3, 'banned')).toBe(1);
  expect(nextAppealAttempt({ status: 'upheld', prev_risk_state: null }, 2, null)).toBe(3);
});
