// BR-WDR-30 告警 (并入 BR-WDR-24): when an automatic decision takes today's automatic total (⑨'s
// rows: this app, review_mode=auto, status ∉ {REJECTED, FAILED}, reviewed_at today +08:00, this one
// included) to at least 80% of platform_daily_max_fen (exactly: total × 10000 ≥ max × 8000, no
// rounding of 80% first), the consumer raises the finance alert (logger.warn, ids and amounts only).
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  NEAR_CAP_ALERT,
  TIMEOUT,
  close,
  key,
  open,
  setup,
  type AutoFixture,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

/**
 * platform_daily_max_fen `max` (default 10000, 80% = 8000); another member already auto-paid
 * `existing` today; this withdrawal is 1000.
 */
async function scene(existing: bigint, max = 10_000) {
  const f = await setup(h);
  await f.set(key('platform_daily_max_fen'), max);
  const other = await f.member();
  const id = await f.start(1_000n);
  await f.seedReviewed({ userId: other.actor.userId, amount: existing });
  return { f, id };
}

function nearCapCalls(f: AutoFixture) {
  return f.logger.warn.mock.calls.filter(([, message]) => message === NEAR_CAP_ALERT);
}

it('[AC-B2-11c#70] 本单判 auto 后当日自动合计 7000 + 1000 = 8000，恰达 platform_daily_max_fen 的 80% → 告警一次（带 app_id，不带收款信息）', async () => {
  const { f, id } = await scene(7_000n);
  await f.consumer().consume(await f.event(id));
  expect((await f.row(id)).review_mode).toBe('auto');
  const calls = nearCapCalls(f);
  expect(calls).toHaveLength(1);
  expect(calls[0]![0]).toEqual(expect.objectContaining({ app_id: f.appId }));
  const logged = JSON.stringify(calls);
  expect(logged).not.toContain(f.hmac);
  expect(logged).not.toContain('合成姓名');
});

it('[AC-B2-11c#71] 合计 6999 + 1000 = 7999 未达 80% → 不告警', async () => {
  const { f, id } = await scene(6_999n);
  await f.consumer().consume(await f.event(id));
  expect((await f.row(id)).review_mode).toBe('auto');
  expect(nearCapCalls(f)).toEqual([]);
});

it('[AC-B2-11c#73] 80% 不是整数分：上限 10003（80% = 8002.4），合计 7002 + 1000 = 8002 未达 → 不告警（按 合计 × 10000 ≥ 上限 × 8000 比较，不先取整）', async () => {
  const { f, id } = await scene(7_002n, 10_003);
  await f.consumer().consume(await f.event(id));
  expect((await f.row(id)).review_mode).toBe('auto');
  expect(nearCapCalls(f)).toEqual([]);
});

it('[AC-B2-11c#74] 上限 10003 时合计 7003 + 1000 = 8003 ≥ 8002.4 → 告警一次', async () => {
  const { f, id } = await scene(7_003n, 10_003);
  await f.consumer().consume(await f.event(id));
  expect((await f.row(id)).review_mode).toBe('auto');
  expect(nearCapCalls(f)).toHaveLength(1);
});

it('[AC-B2-11c#72] 本单判 manual 时自动合计不变 → 不告警', async () => {
  const { f, id } = await scene(7_500n);
  f.minors.add(f.actor.userId);
  await f.consumer().consume(await f.event(id));
  expect((await f.row(id)).review_mode).toBe('manual');
  expect(nearCapCalls(f)).toEqual([]);
});
