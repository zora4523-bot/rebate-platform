// B2-11b ⑨ platform_daily_max_fen = 0 (规划/08 BR-WDR-30 细则 ⑨, orchestrator ruling D10-377):
// 0 means no amount auto-pays and every withdrawal goes manual, the same reading as ②
// max_amount_fen = 0; it is not "unlimited". withdrawals.amount_fen > 0 (db/schema.sql
// withdrawals_amount_check), so every real amount is at least 1 fen.
import { expect, it } from 'vitest';
import { decideAutoPayout } from '../../../../apps/api/src/modules/payout/domain/auto-decision.ts';
import { passing } from './kit.ts';

function withPlatformMax(amount: bigint, existing: bigint, max: bigint) {
  const value = passing();
  value.amount_fen = amount;
  value.frozen_fen = amount;
  value.config.max_amount_fen = 1_000_000n;
  value.platform_daily_auto_fen = existing;
  value.config.platform_daily_max_fen = max;
  return value;
}

it('[AC-B2-11b#64] ⑨ platform_daily_max_fen=0 表示任何金额都不自动到账（与 ② 同口径，不是不限）', () => {
  for (const amount of [1n, 100n, 28000n, 30000n, 1_000_000n]) {
    expect(decideAutoPayout(withPlatformMax(amount, 0n, 0n))).toMatchObject({
      result: 'manual',
      failed_conditions: ['platform_daily_max'],
    });
  }
  expect(decideAutoPayout(withPlatformMax(1n, 2n ** 53n, 0n))).toMatchObject({
    result: 'manual',
    failed_conditions: ['platform_daily_max'],
  });
});

it('[AC-B2-11b#65] ⑨ 与 ② 同时为 0：两项都记，按 ② → ⑨ 排列', () => {
  const value = withPlatformMax(1n, 0n, 0n);
  value.config.max_amount_fen = 0n;
  expect(decideAutoPayout(value)).toMatchObject({
    result: 'manual',
    failed_conditions: ['max_amount', 'platform_daily_max'],
  });
});

it('[AC-B2-11b#66] ⑨ 上限 1 分：当日无自动到账时 1 分可自动，2 分转人工', () => {
  expect(decideAutoPayout(withPlatformMax(1n, 0n, 1n))).toMatchObject({
    result: 'auto',
    failed_conditions: [],
  });
  expect(decideAutoPayout(withPlatformMax(2n, 0n, 1n))).toMatchObject({
    result: 'manual',
    failed_conditions: ['platform_daily_max'],
  });
});
