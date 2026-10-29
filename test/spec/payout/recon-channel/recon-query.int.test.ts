// B2-07c r3 (规划/08 BR-WDR-23 ①, BR-WDR-15; 编排裁定 D10-415 ②): where ①'s "query at once" lands.
// The query the reconciliation sends on queue `payout` (job `query`) carries source = 'recon' in its
// payload; the payout process's query job (B2-06e, couli_payout) reads that marker:
//   - a result that is not a success (a definite failure, or still unknown) → the conditional update
//     `status = 'PAYING' AND needs_manual = false` sets needs_manual = true, the withdrawal stays
//     PAYING and nothing is handed to W6 (no `land` job on payout-landing);
//   - a success → lands as usual (W5);
//   - a withdrawal no longer PAYING, or already needs_manual, when the job runs or while it queries
//     → the update hits nothing: no landing, no diff, no hold, the withdrawal as it was.
// Against the race of an ordinary (unmarked) query that gets a definite failure first: when the
// recon_channel row of this withdrawal already shows the bill's success, it too ends with
// needs_manual = true and no W6; without such evidence it is W6 as before.
// The query job is the trunk's (not a skeleton): the marked-query tests are red on its assertions,
// the others on the reconciliation's NotImplemented. Top-level it() only (规划/11 §4.3).
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ReceivedJob } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { LANDING_QUEUE } from '../process/kit.ts';
import {
  BILL_DATE,
  QUERY_FAIL_STEP,
  TIMEOUT,
  TRANSFERRED_AT,
  UNKNOWN_STEP,
  allHolds,
  balanceOf,
  channelOrderId,
  close,
  diffs,
  lineOf,
  open,
  queryJobsOf,
  queryScripted,
  querySuccess,
  rowsOf,
  setup,
  withdrawal,
  withdrawalVouchers,
  type Harness,
  type ReconFixture,
  type Seeded,
} from './kit.ts';

/** The marker of the reconciliation's immediate query (D10-415 ②). */
const RECON_SOURCE = 'recon';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

/** A query job of `w` as the reconciliation sends it: the chain's payload plus source = 'recon'. */
function reconQueryOf(f: ReconFixture, w: Seeded): ReceivedJob {
  const job = f.queryJobOf(w, 1);
  return Object.freeze({ ...job, payload: { ...job.payload, source: RECON_SOURCE } });
}

/** The payloads sent on payout-landing naming `w`, from send number `from` on. */
function landingSendsSince(f: ReconFixture, from: number, w: Seeded): unknown[] {
  return f.send.mock.calls
    .slice(from)
    .filter((call) => call[0] === LANDING_QUEUE && call[2]['withdrawal_id'] === w.id)
    .map((call) => call[2]);
}

it.each([
  ['明确失败', [QUERY_FAIL_STEP]],
  ['仍是未知（三次都处理中）', [UNKNOWN_STEP, UNKNOWN_STEP, UNKNOWN_STEP]],
] as const)(
  '[AC-B2-07c#20] D10-415 ② (a) 带 source=recon 的查询%s：payout 进程的 query 任务条件更新置 needs_manual=true，仍 PAYING、不退回，不向 payout-landing 投 land（不交接 W6）',
  async (_label, steps) => {
    const f = await setup(h);
    const owner = await f.newUser(5_000n);
    const w = await f.seedPaying(TRANSFERRED_AT, { net: 1_500n, userId: owner });
    const channel = queryScripted({ [w.outBizNo]: steps });
    const handler = f.rawQueryJob(channel.channel);
    await expect(handler(reconQueryOf(f, w))).resolves.toBeUndefined();

    expect(channel.queries().length).toBeGreaterThanOrEqual(1);
    expect(channel.transfers()).toBe(0);
    expect(await withdrawal(f, w.id)).toMatchObject({
      status: 'PAYING',
      needs_manual: true,
      fail_code: null,
      paid_at: null,
      channel_order_id: null,
    });
    expect(landingSendsSince(f, 0, w)).toEqual([]);
    expect(await f.landPending()).toBe(0);
    expect(await withdrawal(f, w.id)).toMatchObject({ status: 'PAYING', needs_manual: true });
    expect((await withdrawalVouchers(f)).filter((key) => key.startsWith(`wd:${w.id}:`))).toEqual([
      `wd:${w.id}:FREEZE`,
    ]);
    expect(await balanceOf(f, owner)).toEqual({ available_fen: 3_500n, frozen_fen: 1_500n });
  },
  TIMEOUT,
);

it(
  '[AC-B2-07c#21] D10-415 ② (b) 对账投出的即时查询负载带 source=recon；查询返回成功 → 照常落地 W5（PAID_API、channel_order_id、成功分录），不置 needs_manual，无差错单、无冻结',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const owner = await f.newUser(5_000n);
    const w = await f.seedPaying(TRANSFERRED_AT, { net: 1_500n, userId: owner });
    const line = lineOf(w);
    f.setBill(BILL_DATE, [line]);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();
    const queued = await queryJobsOf(f, w);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.data.payload).toMatchObject({
      app_id: f.appId,
      withdrawal_id: w.id,
      execute_seq: w.executeSeq,
      source: RECON_SOURCE,
    });
    const channel = queryScripted({ [w.outBizNo]: [querySuccess(line.channelOrderId)] });
    expect(await f.runImmediateQuery(w, channel.channel)).toBe(1);

    expect(channel.queries()).toEqual([w.outBizNo]);
    expect(channel.transfers()).toBe(0);
    expect(await withdrawal(f, w.id)).toMatchObject({
      status: 'PAID_API',
      needs_manual: false,
      channel_order_id: line.channelOrderId,
    });
    expect((await withdrawalVouchers(f)).filter((key) => key.startsWith(`wd:${w.id}:`))).toEqual([
      `wd:${w.id}:FREEZE`,
      `wd:${w.id}:PAID`,
    ]);
    expect(await balanceOf(f, owner)).toEqual({ available_fen: 3_500n, frozen_fen: 0n });
    expect(await diffs(f)).toEqual([]);
    expect(await allHolds(f)).toEqual([]);
  },
  TIMEOUT,
);

/** What moves the withdrawal away from ①'s precondition (PAYING, needs_manual = false). */
type Interference = 'manual' | 'landed';

/** manual: the T + 24 h decision sets needs_manual; landed: an ordinary query lands W5 first. */
async function interfere(f: ReconFixture, w: Seeded, kind: Interference): Promise<void> {
  if (kind === 'manual') {
    await f.markNeedsManual(w);
    return;
  }
  const ordinary = queryScripted({ [w.outBizNo]: [querySuccess(channelOrderId())] });
  await f.queryJob(ordinary.channel)(f.queryJobOf(w, 1));
}

it.each([
  ['needs_manual 已由 T+24h 判定置为 true', 'manual', { status: 'PAYING', needs_manual: true }],
  ['已不是 PAYING（普通查询先落地 W5）', 'landed', { status: 'PAID_API', needs_manual: false }],
] as const)(
  '[AC-B2-07c#22] D10-415 ② (c) 对账投出 source=recon 的查询后、它运行前单子%s：条件更新不生效，无副作用——不落地、不投 land、无差错单、无冻结，提现单与分录保持原样',
  async (_label, kind, want) => {
    const f = await setup(h);
    const handler = f.reconJob();
    const owner = await f.newUser(5_000n);
    const w = await f.seedPaying(TRANSFERRED_AT, { net: 1_500n, userId: owner });
    f.setBill(BILL_DATE, [lineOf(w)]);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();
    await interfere(f, w, kind);
    const settled = await withdrawal(f, w.id);
    expect(settled).toMatchObject(want);
    const vouchers = await withdrawalVouchers(f);
    const sendsThen = f.send.mock.calls.length;
    const channel = queryScripted({ [w.outBizNo]: [QUERY_FAIL_STEP] });
    expect(await f.runImmediateQuery(w, channel.channel)).toBe(1);

    expect(channel.transfers()).toBe(0);
    expect(await withdrawal(f, w.id)).toEqual(settled);
    expect(await withdrawalVouchers(f)).toEqual(vouchers);
    expect(landingSendsSince(f, sendsThen, w)).toEqual([]);
    expect(await diffs(f)).toEqual([]);
    expect(await allHolds(f)).toEqual([]);
  },
  TIMEOUT,
);

it.each([
  ['needs_manual 被 T+24h 判定置为 true', 'manual', { status: 'PAYING', needs_manual: true }],
  ['已不是 PAYING（普通查询落地 W5）', 'landed', { status: 'PAID_API', needs_manual: false }],
] as const)(
  '[AC-B2-07c#22] D10-415 ② (c) source=recon 的查询正在向通道查询时单子%s，查询随后明确失败：条件更新影响 0 行，无副作用——不投 land、无差错单、无冻结，提现单与分录停在并发改动后的样子',
  async (_label, kind, want) => {
    const f = await setup(h);
    const handler = f.reconJob();
    const owner = await f.newUser(5_000n);
    const w = await f.seedPaying(TRANSFERRED_AT, { net: 1_500n, userId: owner });
    f.setBill(BILL_DATE, [lineOf(w)]);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();
    let settled: Awaited<ReturnType<typeof withdrawal>> | undefined;
    let vouchers: string[] = [];
    let sendsThen = 0;
    const channel = queryScripted(
      { [w.outBizNo]: [QUERY_FAIL_STEP] },
      {
        async before(_outBizNo, call) {
          if (call !== 1) return;
          await interfere(f, w, kind);
          settled = await withdrawal(f, w.id);
          vouchers = await withdrawalVouchers(f);
          sendsThen = f.send.mock.calls.length;
        },
      },
    );
    expect(await f.runImmediateQuery(w, channel.channel)).toBe(1);

    expect(channel.queries().length).toBeGreaterThanOrEqual(1);
    expect(channel.transfers()).toBe(0);
    expect(settled, 'the withdrawal right after the concurrent change').toMatchObject(want);
    expect(await withdrawal(f, w.id)).toEqual(settled);
    expect(await withdrawalVouchers(f)).toEqual(vouchers);
    expect(landingSendsSince(f, sendsThen, w)).toEqual([]);
    expect(await diffs(f)).toEqual([]);
    expect(await allHolds(f)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-07c#23] D10-415 ② (d) 常规查询（不带 source=recon）明确失败，而 recon_channel 已有本笔「账单成功」的对账行：同样置 needs_manual=true、仍 PAYING，不走 W6（不退回、不投 land）',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const owner = await f.newUser(5_000n);
    const w = await f.seedPaying(TRANSFERRED_AT, { net: 1_500n, userId: owner });
    const line = lineOf(w);
    f.setBill(BILL_DATE, [line]);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();
    expect(await rowsOf(f, { outBizNo: w.outBizNo })).toEqual([
      expect.objectContaining({
        channel_order_id: line.channelOrderId,
        channel_status: 'SUCCESS',
        our_status: 'PAYING',
        result: 'paying_query',
      }),
    ]);
    const sendsThen = f.send.mock.calls.length;
    const ordinary = queryScripted({ [w.outBizNo]: [QUERY_FAIL_STEP] });
    await expect(f.queryJob(ordinary.channel)(f.queryJobOf(w, 1))).resolves.toBeUndefined();

    expect(ordinary.queries()).toEqual([w.outBizNo]);
    expect(ordinary.transfers()).toBe(0);
    expect(await withdrawal(f, w.id)).toMatchObject({
      status: 'PAYING',
      needs_manual: true,
      fail_code: null,
      paid_at: null,
      channel_order_id: null,
    });
    expect(landingSendsSince(f, sendsThen, w)).toEqual([]);
    expect((await withdrawalVouchers(f)).filter((key) => key.startsWith(`wd:${w.id}:`))).toEqual([
      `wd:${w.id}:FREEZE`,
    ]);
    expect(await balanceOf(f, owner)).toEqual({ available_fen: 3_500n, frozen_fen: 1_500n });
  },
  TIMEOUT,
);

it(
  '[AC-B2-07c#24] D10-415 ② (e) 常规查询明确失败，recon_channel 没有本笔的账单成功行（当日账单只有另一笔的成功行）：照旧 W6（FAILED、fail_code、WITHDRAW_RETURN 退回），不置 needs_manual',
  async () => {
    const f = await setup(h);
    const handler = f.reconJob();
    const owner = await f.newUser(5_000n);
    const w = await f.seedPaying(TRANSFERRED_AT, { net: 1_500n, userId: owner });
    const other = await f.seedPaying(TRANSFERRED_AT, { net: 1_500n });
    f.setBill(BILL_DATE, [lineOf(other)]);
    await expect(handler(f.reconJobOf(BILL_DATE))).resolves.toBeUndefined();
    expect(await rowsOf(f, { outBizNo: other.outBizNo })).toEqual([
      expect.objectContaining({ channel_status: 'SUCCESS', result: 'paying_query' }),
    ]);
    expect(
      (await rowsOf(f, { outBizNo: w.outBizNo })).filter((row) => row.channel_status !== null),
    ).toEqual([]);
    const ordinary = queryScripted({ [w.outBizNo]: [QUERY_FAIL_STEP] });
    await expect(f.queryJob(ordinary.channel)(f.queryJobOf(w, 1))).resolves.toBeUndefined();

    expect(ordinary.queries()).toEqual([w.outBizNo]);
    expect(await withdrawal(f, w.id)).toMatchObject({
      status: 'FAILED',
      needs_manual: false,
      fail_code: 'TEST_QUERY_FAIL',
      paid_at: null,
    });
    expect((await withdrawalVouchers(f)).filter((key) => key.startsWith(`wd:${w.id}:`))).toEqual([
      `wd:${w.id}:FREEZE`,
      `wd:${w.id}:RETURN`,
    ]);
    expect(await balanceOf(f, owner)).toEqual({ available_fen: 5_000n, frozen_fen: 0n });
  },
  TIMEOUT,
);
