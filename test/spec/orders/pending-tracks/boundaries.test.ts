import { expect, it } from 'vitest';
import { at, attempt, card, select } from './kit.ts';

it.each([
  { elapsed: 30 * 60_000 - 1000, claim: false },
  { elapsed: 30 * 60_000 - 1, claim: false },
  { elapsed: 30 * 60_000, claim: true },
  { elapsed: 72 * 3600_000, claim: true },
])('[AC-B1-08m#8] 已过 $elapsed 毫秒时入口=$claim', async ({ elapsed, claim }) => {
  const a = attempt(1);
  expect(await select([a], { now: at(1, elapsed) })).toEqual([card(a, claim)]);
});

it('[AC-B1-08m#9] 超过 72 小时 1ms 不再参与第一档选择', async () => {
  const old = attempt(1, { jump_reported_at: at(2) });
  expect(await select([old], { now: at(1 + 72 * 60, 1) })).toEqual([]);
  const recent = attempt(3);
  expect(await select([old, recent], { now: at(1 + 72 * 60, 1) })).toEqual([card(recent, true)]);
});

it.each([
  { toleranceSec: 120, delta: -120_000, completed: true },
  { toleranceSec: 120, delta: -120_001, completed: false },
  { toleranceSec: 120, delta: -121_000, completed: false },
  { toleranceSec: 0, delta: -1, completed: false },
  { toleranceSec: 0, delta: 0, completed: true },
])(
  '[AC-B1-08m#10] 容差 $toleranceSec 秒、付款相差 $delta 毫秒，完成=$completed',
  async ({ toleranceSec, delta, completed }) => {
    const a = attempt(10);
    expect(
      await select([a], {
        toleranceSec,
        orders: [{ link_id: a.link_id, attr_at: at(10, delta), source_match: 'exact' }],
      }),
    ).toEqual(completed ? [] : [card(a)]);
  },
);

it.each(['none', null])('[AC-B1-08m#11] source_match=%s 不完成尝试', async (source_match) => {
  const a = attempt(1);
  expect(
    await select([a], { orders: [{ link_id: a.link_id, attr_at: at(10), source_match }] }),
  ).toEqual([card(a)]);
});

it.each(['exact', 'product', 'shop'])(
  '[AC-B1-08m#32] source_match=%s 都能完成已关闭的选中项',
  async (source_match) => {
    const a = attempt(1, { dismissed_at: at(3) });
    expect(
      await select([a], { orders: [{ link_id: a.link_id, attr_at: at(2), source_match }] }),
    ).toEqual([]);
  },
);

it('[AC-B1-08m#12] 同 link 旧订单含预售定金不完成新尝试；旧尝试关闭无影响', async () => {
  const old = attempt(1, { dismissed_at: at(3) });
  const recent = attempt(10, { link_id: old.link_id });
  expect(
    await select([old, recent], {
      orders: [{ link_id: old.link_id, attr_at: at(2), source_match: 'exact' }],
    }),
  ).toEqual([card(recent)]);
});

it.each([
  { no_rebate: false, reason: null, authorized: false, expected: true },
  { no_rebate: true, reason: 'auth_declined', authorized: true, expected: true },
  { no_rebate: true, reason: 'auth_failed', authorized: true, expected: true },
  { no_rebate: true, reason: 'auth_declined', authorized: false, expected: false },
  { no_rebate: true, reason: 'auth_failed', authorized: false, expected: false },
  { no_rebate: true, reason: 'no_commission', authorized: true, expected: false },
  { no_rebate: true, reason: null, authorized: true, expected: false },
])(
  '[AC-B1-08m#13] 无返利=$no_rebate 原因=$reason 后续授权=$authorized，入口=$expected',
  async ({ no_rebate, reason, authorized, expected }) => {
    const a = attempt(1, { no_rebate, no_rebate_reason: reason, authorized_after: authorized });
    expect(await select([a], { now: at(31) })).toEqual([card(a, expected)]);
    expect(await select([a], { now: at(30, 59_000) })).toEqual([card(a, false)]);
  },
);
