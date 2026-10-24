// B2-06d ④ (规划/08 BR-WDR-13 ③ daily_cap): "当日已发出合计" is Σ net_fen of the app's kind=transfer
// attempts whose `at` falls on today in +08:00 (@couli/domain's day boundary, from the injected
// Clock) and whose result is pending, success or unknown. A definite failure, a query attempt,
// yesterday (+08:00) and another app never count. sent + net = cap passes; sent + net = cap + 1 is
// W9 daily_cap.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DAY_START,
  HOUR,
  NOW,
  TIMEOUT,
  attempts,
  close,
  open,
  scripted,
  setup,
  withdrawal,
  type Harness,
  type ProcessFixture,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

/** Counted 100 + 200 + 300 = 600; everything else is 5000 each and must not count. */
async function seedDay(f: ProcessFixture) {
  await f.seedSent({ net: 100n, result: 'pending', at: DAY_START });
  await f.seedSent({ net: 200n, result: 'success', at: new Date(NOW.getTime() - HOUR) });
  await f.seedSent({ net: 300n, result: 'unknown', at: NOW });
  await f.seedSent({ net: 5000n, result: 'fail', at: new Date(NOW.getTime() - 2 * HOUR) });
  await f.seedSent({ net: 5000n, result: 'pending', at: new Date(DAY_START.getTime() - 1) });
  await f.seedSent({
    net: 5000n,
    result: 'unknown',
    kind: 'query',
    at: new Date(NOW.getTime() - HOUR),
  });
  const other = `process_other_${f.appId}`;
  const stranger = await f.newUser(1_000_000n, other);
  await f.seedSent({ net: 5000n, result: 'pending', at: NOW, appId: other, userId: stranger });
}

it.each([
  [400n, null],
  [401n, 'daily_cap'],
] as const)(
  '[AC-B2-06d#4] 当日口径：pending / success / unknown 计入，fail、查询尝试、+08:00 昨日与别的应用不计；daily_cap_fen=1000、已发出 600、本单 net=%s → hold_reason %s',
  async (net, reason) => {
    const f = await setup(h);
    await f.set('payout.daily_cap_fen', 1000);
    await seedDay(f);
    const w = await f.seedWithdrawal({ net });
    const ch = scripted({});
    const handler = f.job(ch.channel);
    await expect(handler(f.jobOf(w))).resolves.toBeUndefined();
    expect((await withdrawal(f, w.id)).hold_reason).toBe(reason);
    expect(ch.transfers()).toHaveLength(reason === null ? 1 : 0);
    expect(await attempts(f, w.id)).toHaveLength(reason === null ? 1 : 0);
  },
);

it('[AC-B2-06d#4] 跨 +08:00 日界：23:59:59.999 时同日的已发出计入（超限 W9），次日 00:00 起不再计入（照常转账）', async () => {
  const f = await setup(h);
  await f.set('payout.daily_cap_fen', 1000);
  // 2026-10-19 08:00 +08:00, the same UTC date as both instants below.
  await f.seedSent({ net: 600n, result: 'pending', at: new Date('2026-10-19T00:00:00.000Z') });
  const ch = scripted({});
  const handler = f.job(ch.channel);

  f.clock.set('2026-10-19T15:59:59.999Z'); // 2026-10-19 23:59:59.999 +08:00
  const late = await f.seedWithdrawal({ net: 500n });
  await handler(f.jobOf(late));
  expect(await withdrawal(f, late.id)).toMatchObject({
    status: 'APPROVED',
    hold_reason: 'daily_cap',
    hold_at: new Date('2026-10-19T15:59:59.999Z'),
  });

  f.clock.set('2026-10-19T16:00:00.000Z'); // 2026-10-20 00:00 +08:00
  const next = await f.seedWithdrawal({ net: 500n });
  await handler(f.jobOf(next));
  expect((await withdrawal(f, next.id)).hold_reason).toBeNull();
  expect(ch.transfers().map((request) => request.outBizNo)).toEqual([next.outBizNo]);
  expect(await attempts(f, next.id)).toEqual([
    expect.objectContaining({
      kind: 'transfer',
      at: new Date('2026-10-19T16:00:00.000Z'),
    }),
  ]);
});

it('[AC-B2-06d#4] 本任务写下的 pending 尝试计入后续单：两单各 600、daily_cap_fen=1000，第二单 W9 daily_cap', async () => {
  const f = await setup(h);
  await f.set('payout.daily_cap_fen', 1000);
  const ch = scripted({});
  const handler = f.job(ch.channel);
  const first = await f.seedWithdrawal({ net: 600n });
  const second = await f.seedWithdrawal({ net: 600n });
  await handler(f.jobOf(first));
  await handler(f.jobOf(second));
  expect((await withdrawal(f, first.id)).hold_reason).toBeNull();
  expect((await withdrawal(f, second.id)).hold_reason).toBe('daily_cap');
  expect(ch.transfers().map((request) => request.outBizNo)).toEqual([first.outBizNo]);
});
