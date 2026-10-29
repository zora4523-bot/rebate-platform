// B2-07c (规划/08 BR-WDR-23 每日 T+1 对前一自然日（+08:00）; 编排裁定 D10-408): every run of the R2
// reconciliation writes app.payout_recon_runs for (app, alipay, bill day) — succeeded when the day ran
// to its end (finding diffs does not make it partial), partial / failed when the bill could not be
// had (a missing bill is never "everything agrees"); a rerun of the same day (at-least-once
// delivery) changes nothing that already holds and keeps one run row; each day's run enqueues the
// next day's run, never due before that day is over; the daily seed starts the chain at the
// previous +08:00 accounting day, not the UTC one. Top-level it() only (规划/11 §4.3).
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  BILL_DATE,
  END_OF_BILL_DAY,
  END_OF_DAY_AFTER,
  END_OF_NEXT_DAY,
  IN_DAY,
  NEXT_BILL_DATE,
  NOW,
  RECON_QUEUE,
  TIMEOUT,
  allHolds,
  books,
  close,
  diffs,
  dueMs,
  expectNoPayeeInLogs,
  lineOf,
  open,
  reconRows,
  reconSends,
  runs,
  setup,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it(
  '[AC-B2-07c#2] 账单齐、全部一致：读 2026-10-18 一次，运行登记 succeeded（bill_rows / matched / diffs 按账单与结果计，开始与结束取注入时钟），不生成差错单与冻结',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const a = await f.seedPaid(IN_DAY, { net: 1_000n });
    const b = await f.seedPaid(IN_DAY, { net: 2_500n });
    f.setBill(BILL_DATE, [lineOf(a), lineOf(b)]);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    expect(f.billCalls()).toContain(BILL_DATE);
    expect(await runs(f)).toEqual([
      {
        app_id: f.appId,
        channel: 'alipay',
        bill_date: BILL_DATE,
        status: 'succeeded',
        started_at: NOW,
        finished_at: NOW,
        bill_rows: 2,
        matched: 2,
        diffs: 0,
      },
    ]);
    expect(await diffs(f)).toEqual([]);
    expect(await allHolds(f)).toEqual([]);
    expectNoPayeeInLogs(f);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07c#2] 发现差错不改为 partial：一笔一致、一笔已付而账单无记录 → succeeded，matched 1、diffs 1',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const listed = await f.seedPaid(IN_DAY, { net: 1_000n });
    await f.seedPaid(IN_DAY, { net: 3_000n, userId: await f.newUser() });
    f.setBill(BILL_DATE, [lineOf(listed)]);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    expect(await runs(f)).toEqual([
      expect.objectContaining({
        bill_date: BILL_DATE,
        status: 'succeeded',
        bill_rows: 1,
        matched: 1,
        diffs: 1,
      }),
    ]);
    expect(await diffs(f)).toHaveLength(1);
  },
  TIMEOUT,
);

it.each([
  ['账单拿不到（通道拒绝 PAYOUT_BILL_UNAVAILABLE）', 'unavailable'],
  ['通道没有账单接口', 'no-port'],
] as const)(
  '[AC-B2-07c#3] %s：运行登记 partial 或 failed（不是 succeeded），bill_rows / matched / diffs 为 0；不写对账明细、不生成差错单与冻结、不发查询、提现单与账务不变',
  async (_label, kind) => {
    const f = await setup(h);
    const handler = kind === 'no-port' ? f.reconJob({ bills: { alipay: {} } }) : f.reconJob();
    // Paid inside the day: with an empty bill this would be a diff; with no bill it must not be.
    await f.seedPaid(IN_DAY, { net: 1_000n });
    const before = await books(f);
    // The job may resolve or reject (a retry); either way the run is recorded.
    await handler(f.reconJobOf(BILL_DATE)).catch(() => undefined);

    const recorded = await runs(f);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      app_id: f.appId,
      channel: 'alipay',
      bill_date: BILL_DATE,
      bill_rows: 0,
      matched: 0,
      diffs: 0,
    });
    expect(['partial', 'failed']).toContain(recorded[0]?.status);
    expect(await reconRows(f)).toEqual([]);
    expect(await diffs(f)).toEqual([]);
    expect(await allHolds(f)).toEqual([]);
    expect(f.send.mock.calls.filter((call) => call[0] === 'payout')).toEqual([]);
    expect(await books(f)).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07c#4] 同一账单日重跑（至少一次投递）：明细、差错单、冻结不重复，运行登记仍一条（失败后重跑改写为 succeeded）',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const owner = await f.newUser();
    const listed = await f.seedPaid(IN_DAY, { net: 1_000n });
    const returned = await f.seedWithdrawal({ status: 'FAILED', net: 4_000n, userId: owner });
    // First delivery: no bill yet → not succeeded.
    await handler(f.reconJobOf(BILL_DATE)).catch(() => undefined);
    expect((await runs(f)).map((row) => row.status)).not.toContain('succeeded');

    f.setBill(BILL_DATE, [lineOf(listed), lineOf(returned)]);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();
    const rows = await reconRows(f);
    const found = await diffs(f);
    const holds = await allHolds(f);
    expect(found).toHaveLength(1);
    expect(holds).toHaveLength(1);

    await expect(f.reconJob()(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();
    expect(await reconRows(f)).toEqual(rows);
    expect(await diffs(f)).toEqual(found);
    expect(await allHolds(f)).toEqual(holds);
    expect(await runs(f)).toEqual([
      expect.objectContaining({ bill_date: BILL_DATE, status: 'succeeded', bill_rows: 2 }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07c#5] 每日链：2026-10-18 的运行入队 payout-recon 的 recon（app_id、alipay、账单日 2026-10-19），键含 app 与账单日，到期不早于 10-19（+08:00）结束、不晚于 10-20 结束；重跑不另起一条键',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const w = await f.seedPaid(IN_DAY);
    f.setBill(BILL_DATE, [lineOf(w)]);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();

    const sent = reconSends(f);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    for (const job of sent) {
      expect(job.payload).toEqual({
        app_id: f.appId,
        channel: 'alipay',
        bill_date: NEXT_BILL_DATE,
      });
      expect(job.options.singletonKey ?? '').toContain(f.appId);
      expect(job.options.singletonKey ?? '').toContain(NEXT_BILL_DATE);
      expect(dueMs(f, job)).toBeGreaterThanOrEqual(END_OF_NEXT_DAY);
      expect(dueMs(f, job)).toBeLessThanOrEqual(END_OF_DAY_AFTER);
    }
    expect(new Set(sent.map((job) => job.options.singletonKey)).size).toBe(1);
  },
  TIMEOUT,
);

it.each([
  ['2026-10-19 10:00 +08:00', NOW.toISOString()],
  ['2026-10-19 01:00 +08:00（UTC 仍是 10-18）', '2026-10-18T17:00:00.000Z'],
])(
  '[AC-B2-07c#5] 每日种子在 %s 运行：为有支付宝提现单的 App 入队 2026-10-18（+08:00 前一自然日）的 recon，到期在 10-18 结束之后、10-19 结束之前；再种一次不多出任务',
  async (_label, instant) => {
    const f = await setup(h);
    await f.seedPaid(IN_DAY);
    f.clock.set(instant);
    await f.seed();
    await f.seed();

    const sent = reconSends(f);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    for (const job of sent) {
      expect(job.payload).toEqual({ app_id: f.appId, channel: 'alipay', bill_date: BILL_DATE });
      expect(dueMs(f, job)).toBeGreaterThanOrEqual(END_OF_BILL_DAY);
      expect(dueMs(f, job)).toBeLessThanOrEqual(END_OF_NEXT_DAY);
    }
    const queued = await sql<{ singleton_key: string | null }>`
      SELECT singleton_key FROM pgboss.job
      WHERE name = ${RECON_QUEUE} AND data->'payload'->>'app_id' = ${f.appId}`.execute(
      f.h.observer,
    );
    expect(queued.rows).toHaveLength(1);
  },
  TIMEOUT,
);
