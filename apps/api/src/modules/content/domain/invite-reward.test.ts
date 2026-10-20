import { expect, it } from 'vitest';
import { configItemSpecOf, configValueFits } from './config-registry.ts';
import {
  INVITE_REWARD_POSITIVE_KEYS,
  inviteRewardEnabled,
  inviteRewardGuardedKey,
  inviteRewardOpenRefused,
  inviteRewardPositive,
  inviteRewardTurnsOn,
  inviteRewardZeroedKeys,
} from './invite-reward.ts';
import { switchSpecOf } from './switch-registry.ts';

const AMOUNT = 'growth.invite_reward.amount_fen';
const DAILY = 'growth.invite_reward.daily_budget_fen';
const TOTAL = 'growth.invite_reward.total_budget_fen';

it('[AC-F1-02zn#8] 单元：只有 ≥1 的整数算已设置', () => {
  for (const value of [1, 100, 2147483647]) expect(inviteRewardPositive(value)).toBe(true);
  for (const value of [0, -0, -1, 1.5, NaN, Infinity, '100', null, undefined, true, [], {}]) {
    expect(inviteRewardPositive(value), String(value)).toBe(false);
  }
});

it('[AC-F1-02zn#7] 单元：三项都为正才能开启，缺键按 0', () => {
  const full = new Map<string, unknown>([
    [AMOUNT, 1],
    [DAILY, 1],
    [TOTAL, 1],
  ]);
  expect(inviteRewardOpenRefused(full)).toBe(false);
  for (const key of INVITE_REWARD_POSITIVE_KEYS) {
    const missing = new Map(full);
    missing.delete(key);
    expect(inviteRewardOpenRefused(missing), key).toBe(true);
    expect(inviteRewardOpenRefused(new Map(full).set(key, 0)), key).toBe(true);
  }
});

it('[AC-F1-02zn#12] 单元：只有把 enabled 写 true 才校验；只有存值 true 算开启', () => {
  expect(inviteRewardTurnsOn('growth.invite_reward.enabled', true)).toBe(true);
  expect(inviteRewardTurnsOn('growth.invite_reward.enabled', false)).toBe(false);
  expect(inviteRewardTurnsOn('growth.invite_reward.payout_paused', true)).toBe(false);
  expect(inviteRewardEnabled(true)).toBe(true);
  for (const value of [false, 'true', 1, null, undefined]) {
    expect(inviteRewardEnabled(value)).toBe(false);
  }
});

it('[AC-F1-02zn#13] 单元：受保护的只有金额与两个预算；置零键按请求顺序列出', () => {
  expect(INVITE_REWARD_POSITIVE_KEYS).toStrictEqual([AMOUNT, DAILY, TOTAL]);
  for (const key of INVITE_REWARD_POSITIVE_KEYS) {
    expect(inviteRewardGuardedKey(key)).toBe(true);
    expect(configItemSpecOf(key)).not.toBeNull();
    expect(configValueFits(configItemSpecOf(key)!, 0)).toBe(true);
  }
  for (const key of [
    'growth.invite_reward.min_paid_fen',
    'growth.invite_reward.ip_window_hours',
    'growth.invite_reward.enabled',
    'growth.invite_reward',
  ]) {
    expect(inviteRewardGuardedKey(key), key).toBe(false);
  }
  expect(switchSpecOf('growth.invite_reward.enabled')?.defaultValue).toBe(false);
  expect(
    inviteRewardZeroedKeys([
      { key: TOTAL, value: 0 },
      { key: 'growth.invite_reward.min_paid_fen', value: 0 },
      { key: DAILY, value: 5 },
      { key: AMOUNT, value: 0 },
    ]),
  ).toStrictEqual([TOTAL, AMOUNT]);
});
