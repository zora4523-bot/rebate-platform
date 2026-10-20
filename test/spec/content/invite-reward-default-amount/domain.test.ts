// Task §9.2: only ABSENCE gets the default; malformed stored values remain invalid on writes.
import { expect, it, vi } from 'vitest';
import {
  deriveInviteReward,
  INVITE_REWARD_DEFAULT_AMOUNT_FEN,
} from '../../../../apps/api/src/modules/content/domain/client-config.ts';
import { inviteRewardOpenRefused } from '../../../../apps/api/src/modules/content/domain/invite-reward.ts';
import { AMOUNT, DAILY, ENABLED, TOTAL } from '../invite-reward-config/oracle.ts';

it('[AC-F1-02zza#1] 只给缺行金额默认值；已有非法金额和缺行预算仍拒绝', () => {
  const values = new Map<string, unknown>([
    [DAILY, 100],
    [TOTAL, 100],
  ]);
  const before = [...values];
  expect(inviteRewardOpenRefused(values)).toBe(false);
  expect([...values]).toStrictEqual(before);
  expect(values.has(AMOUNT)).toBe(false);

  for (const amount of [0, -1, 1.5, '1000', null, true, false, [], {}, undefined]) {
    const stored = new Map(values).set(AMOUNT, amount);
    expect(stored.has(AMOUNT)).toBe(true);
    expect(inviteRewardOpenRefused(stored), `已有金额 ${JSON.stringify(amount)}`).toBe(true);
  }
  for (const amount of [1, 500, 1000]) {
    expect(inviteRewardOpenRefused(new Map(values).set(AMOUNT, amount))).toBe(false);
  }
  for (const key of [DAILY, TOTAL]) {
    const missing = new Map(values);
    missing.delete(key);
    expect(inviteRewardOpenRefused(missing), `${key} 缺行`).toBe(true);
    for (const invalid of [0, -1, 1.5, '100', null, true, [], {}]) {
      expect(inviteRewardOpenRefused(new Map(values).set(key, invalid)), key).toBe(true);
    }
  }
  expect(inviteRewardOpenRefused(new Map([[AMOUNT, 1000]]))).toBe(true);
  expect(inviteRewardOpenRefused(new Map())).toBe(true);
});

it('[AC-F1-02zza#2] 缺行金额开启校验与客户端下发默认每方 1000 分一致且不补键', () => {
  const values = new Map<string, unknown>([
    [ENABLED, true],
    [DAILY, 100],
    [TOTAL, 100],
  ]);
  const report = { missing: vi.fn(), invalid: vi.fn() };
  expect(INVITE_REWARD_DEFAULT_AMOUNT_FEN).toBe(1000);
  expect(deriveInviteReward({ values, availableBudgetFen: 2000, report })).toStrictEqual({
    reward_enabled: true,
    reward_amount_fen: 1000,
  });
  expect(inviteRewardOpenRefused(values)).toBe(false);
  expect(
    inviteRewardOpenRefused(new Map(values).set(AMOUNT, INVITE_REWARD_DEFAULT_AMOUNT_FEN)),
  ).toBe(false);
  expect(deriveInviteReward({ values, availableBudgetFen: 1999, report })).toStrictEqual({
    reward_enabled: false,
    reward_amount_fen: 1000,
  });
  expect(values.has(AMOUNT)).toBe(false);
  expect(report.missing).not.toHaveBeenCalled();
  expect(report.invalid).not.toHaveBeenCalled();
});
