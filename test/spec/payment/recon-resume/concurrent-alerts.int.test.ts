// B2-15n alert rule test, two runs at once (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-07（对账差错
// 生成差错单并告警）；rule-test review r1 S2 (a replayed daily run and a catch-up of the same bill day run
// side by side on queue pay — their singletonKeys differ — and an implementation that tells a new
// diff by reading recon_diffs before registering it sees no row in both, so one diff is alerted
// twice). A diff is new for the one registration ledger inserted it on, and alerted once, whatever
// runs register it at the same time and in whichever process. The barrier: on the suite's holder
// connection an uncommitted recon_diffs row with the diff's business key (app_id, type, period,
// ref_id; db/schema.sql recon_diffs_business_key) and a dedupe key of its own, invisible to every
// read of the two runs, makes the insert of each run wait for the holder's transaction (ledger's
// INSERT … ON CONFLICT DO NOTHING waits for an uncommitted conflicting row); once both wait, or
// after a while when the implementation keeps the two runs apart by itself, the holder rolls back
// and the two go on. The two runs are two processes (./fresh.ts freshWorker, a module graph each),
// so a memory of alerted diffs inside one process does not count. Plain SQL always names the
// schema. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { enable, suite, track, type Fixture, type Tracked } from '../orders/kit.ts';
import {
  AMOUNT,
  BILL_DATE,
  diffs,
  expectDiff,
  feeVoucherOf,
  lineOf,
  paidOrder,
  recon,
} from '../recon/kit.ts';
import { inDay } from '../recon-schedule/kit.ts';
import { freshWorker } from './fresh.ts';
import { feeShapes, mismatchAlerts, type PayWorker } from './kit.ts';

const s = suite();

/** 2026-10-22 15:00 +08:00: the daily run of the 10-21 bills. */
const RUN = '2026-10-22T07:00:00.000Z';
/** How long the barrier waits for both runs to block on it. */
const BARRIER_MS = 30_000;

/** Sessions waiting for the transaction `xid` (its row lock) in this database. */
async function xidWaiters(f: Fixture, xid: string): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM pg_catalog.pg_locks
    WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = ${xid}
      AND database IS NULL`.execute(f.db);
  return result.rows[0]?.n ?? 0;
}

/**
 * Holds an uncommitted recon_diffs row of the business key (pay_mismatch, `period`, `refId`) on the
 * holder connection while `run` goes; `until(n, pending)` waits for n sessions blocked on it (false
 * when one of `pending` ended first or after BARRIER_MS). Rolled back when `run` returns.
 */
async function holdingDiff<T>(
  f: Fixture,
  period: string,
  refId: string,
  run: (until: (n: number, pending: readonly Tracked<unknown>[]) => Promise<boolean>) => Promise<T>,
): Promise<T> {
  return f.s
    .holder()
    .connection()
    .execute(async (connection) => {
      await sql`BEGIN`.execute(connection);
      try {
        const now = f.clock.now();
        await connection
          .insertInto('recon_diffs')
          .values({
            id: randomUUID(),
            app_id: f.subject.app_id,
            type: 'pay_mismatch',
            source: 'R4',
            period,
            ref_type: 'pay_order',
            ref_id: refId,
            expected_fen: AMOUNT,
            actual_fen: 0n,
            diff_fen: AMOUNT,
            status: 'open',
            handler_id: null,
            closed_at: null,
            dedupe_key: `spec-barrier:${randomUUID()}`,
            resolution: null,
            created_at: now,
            updated_at: now,
          })
          .execute();
        const own = await sql<{ xid: string }>`
          SELECT (pg_catalog.pg_current_xact_id()::text::bigint % 4294967296)::text AS xid`.execute(
          connection,
        );
        const xid = own.rows[0]?.xid ?? '';
        expect(xid, 'the holder transaction id').not.toBe('');
        return await run(async (n, pending) => {
          const end = Date.now() + BARRIER_MS;
          while (Date.now() < end) {
            if ((await xidWaiters(f, xid)) >= n) return true;
            if (pending.some((p) => p.settled)) return false;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          return false;
        });
      } finally {
        await sql`ROLLBACK`.execute(connection);
      }
    });
}

it('[AC-B2-15n#7] 同一新差错两路同时登记只告警一次：10-21 的日跑无差错；次日一笔 10-21 支付宝漏单出现后，两个进程同时跑 10-21 日跑的死信重放与支付宝 10-21 的补跑，两路在登记前都读不到该差错单 → 只有一张差错单（去重键与金额同单路登记）、pay_recon_mismatch 两个进程合计只告警一次；PAY_FEE 每渠道仍只一张', async () => {
  const r = await recon(s, RUN);
  await enable(r.f);
  const appId = r.f.subject.app_id;
  const wechat = await paidOrder(r, 'wechat_pay', { paidAt: inDay(BILL_DATE) });
  const alipay = await paidOrder(r, 'alipay', { paidAt: inDay(BILL_DATE) });
  r.channels.wechat_pay.setBill(BILL_DATE, [lineOf(wechat, { feeFen: 61n })]);
  r.channels.alipay.setBill(BILL_DATE, [lineOf(alipay, { feeFen: 161n })]);
  const fees = [
    feeVoucherOf('wechat_pay', BILL_DATE, 61n),
    feeVoucherOf('alipay', BILL_DATE, 161n),
  ];

  const workers: PayWorker[] = [];
  try {
    const one = await freshWorker(r);
    workers.push(one);
    expect(await one.run({ app_id: appId, bill_date: BILL_DATE }), 'the daily run').toBe(
      'resolved',
    );
    expect(await diffs(r), 'a clean day').toEqual([]);
    const feesFirst = await feeShapes(r);
    expect(feesFirst).toHaveLength(2);
    expect(feesFirst).toEqual(expect.arrayContaining(fees));

    // Settled later with paid_at inside 10-21, missing from the alipay bill: new on both runs.
    const late = await paidOrder(r, 'alipay', { paidAt: inDay(BILL_DATE) });
    r.f.clock.advanceMs(86_400_000);
    const two = await freshWorker(r);
    workers.push(two);

    const runs = await holdingDiff(r.f, BILL_DATE, late.id, async (until) => {
      const replay = track(one.run({ app_id: appId, bill_date: BILL_DATE }));
      const catchUp = track(
        two.run({ app_id: appId, bill_date: BILL_DATE, pay_channel: 'alipay' }),
      );
      await until(2, [replay, catchUp]);
      return [replay, catchUp];
    });
    const outcomes = await Promise.all(runs.map((run) => run.promise));
    expect(outcomes, 'the replay and the catch-up').toEqual(['resolved', 'resolved']);

    const rows = await diffs(r);
    expect(rows, 'one diff of the missing payment').toHaveLength(1);
    expectDiff(r, rows[0], {
      type: 'pay_mismatch',
      refType: 'pay_order',
      refId: late.id,
      expectedFen: AMOUNT,
      actualFen: 0n,
    });
    expect(
      mismatchAlerts([...one.logs, ...two.logs], late.id),
      'one new diff: one alert over both processes',
    ).toHaveLength(1);
    expect(await feeShapes(r)).toEqual(feesFirst);
  } finally {
    for (const worker of workers) worker.release();
  }
}, 180_000);
