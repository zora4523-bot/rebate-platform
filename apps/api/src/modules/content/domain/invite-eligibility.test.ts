import { expect, it } from 'vitest';
import {
  deriveInviteEligibilityDays,
  INVITE_ELIGIBILITY_DAYS_KEY,
  INVITE_ELIGIBILITY_DEFAULT_DAYS,
} from './invite-eligibility.ts';

function derive(entries: [string, unknown][]) {
  const invalid: string[] = [];
  const missing: string[] = [];
  const days = deriveInviteEligibilityDays(new Map(entries), {
    invalid: (k) => invalid.push(k),
    missing: (k) => missing.push(k),
  });
  return { days, invalid, missing };
}

it('[AC-F1-02zze] absent key gives 30 silently; the same-named invite key is ignored', () => {
  expect(INVITE_ELIGIBILITY_DEFAULT_DAYS).toBe(30);
  expect(derive([['invite.eligibility_days', 7]])).toEqual({ days: 30, invalid: [], missing: [] });
});

it('[AC-F1-02zze] integers 1..3650 pass through unchanged', () => {
  for (const value of [1, 30, 45, 3650]) {
    expect(derive([[INVITE_ELIGIBILITY_DAYS_KEY, value]])).toEqual({
      days: value,
      invalid: [],
      missing: [],
    });
  }
});

it('[AC-F1-02zze] anything else gives 30 (never clamped) and is reported once', () => {
  for (const value of [
    0,
    -1,
    3651,
    30.5,
    Number.NaN,
    Infinity,
    '30',
    null,
    true,
    [],
    {},
    undefined,
  ]) {
    expect(derive([[INVITE_ELIGIBILITY_DAYS_KEY, value]])).toEqual({
      days: 30,
      invalid: [INVITE_ELIGIBILITY_DAYS_KEY],
      missing: [],
    });
  }
});
