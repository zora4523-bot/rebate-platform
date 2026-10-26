// B2-15n catch-up rule test (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-07（每日 T+1 逐笔核对，每个账单日
// 都要核对、不能漏日）；B2-15m money review r2 S2 (a chain catching up after days down enqueued the next
// day, due at once, before reconciling its own, so the overdue days ran side by side and took every
// slot of queue pay) and r1 S2-b kept (a catch-up send that fails never leaves the chain without its
// next day). While an App's chain catches up, at most one of its daily bill.recon runs is in flight
// (due and waiting, or running): a run makes its next day due only once its own day is reconciled
// (every channel's bill of the day downloaded, its PAY_FEE booked), and a heal of the same process
// adds no second bill day. Days go one by one, none skipped; catch-up runs are not concerned.
// The worker's own handler and seed (./kit.ts payWorker) on a JOB_QUEUE that records every send and
// refuses the catch-up sends; each daily send made due at once is checked as it is made, inside
// the send's transaction when it has one. Top-level it() only (规划/11 §4.3).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import type { JobPayload } from '../../../../apps/api/src/modules/platform/index.ts';
import { enable, suite } from '../orders/kit.ts';
import { feeVoucherOf, lineOf, paidOrder, recon, settled } from '../recon/kit.ts';
import type { SentJob } from '../result/kit.ts';
import {
  BILL_RECON_JOB,
  billDateOf,
  cleanDay,
  dayEndMs,
  dueMs,
  inDay,
} from '../recon-schedule/kit.ts';
import { daily, dueAtOnce, feeKeys, feeShapes, payWorker, type Ran } from './kit.ts';

const s = suite();

/** 2026-10-24 12:00 +08:00: the worker comes back after being stopped since 2026-10-19. */
const BACK = '2026-10-24T04:00:00.000Z';
const DAYS = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];
/** The day whose alipay bill is not available (its catch-up send is refused). */
const GAP = '2026-10-21';

/** What had happened when a daily run of `billDate` was made due at once. */
interface AtSend {
  readonly billDate: string;
  readonly wechat: readonly string[];
  readonly alipay: readonly string[];
  readonly fees: readonly string[];
}

/** The daily runs a heal made due at once after the run of `after`, while `pending` was next. */
interface Heal {
  readonly after: string;
  readonly pending: string;
  readonly sent: readonly string[];
}

it('[AC-B2-15n#4] 停机多日后追赶（2026-10-24 12:00 +08:00 新进程，自 10-19 起无一日对账）：同一 App 同时在途（已到期待领或执行中）的日跑不超过 1 个——每个日跑在本账单日两渠道账单都已下载、PAY_FEE 已记之后才让下一日到期，进程内的 heal 不另添账单日；逐日推进 10-19～10-23、不跳日、不扇出；10-21 支付宝账单不可得且其补跑入队被拒时，链照常推进到 10-22；追上后 10-24 的日跑不早于 10-24 结束', async () => {
  const r = await recon(s, BACK);
  await enable(r.f);
  const appId = r.f.subject.app_id;
  for (const day of DAYS) {
    if (day === GAP) {
      const order = await paidOrder(r, 'wechat_pay', { paidAt: inDay(day) });
      r.channels.wechat_pay.setBill(day, [lineOf(order, { feeFen: 70n })]);
      await paidOrder(r, 'alipay', { paidAt: inDay(day) });
      r.channels.alipay.setBill(day, 'unknown');
    } else {
      await cleanDay(r, day, { wechat_pay: 70n, alipay: 170n });
    }
  }

  const atSend: AtSend[] = [];
  const refused: SentJob[] = [];
  const w = await payWorker(r, async (job) => {
    if (job.name !== BILL_RECON_JOB || job.payload['app_id'] !== appId) return;
    if (job.payload['pay_channel'] !== undefined) {
      refused.push(job);
      throw new Error('spec: the catch-up send is refused');
    }
    if (!dueAtOnce(job)) return;
    const handle: Kysely<DB> = job.options.trx ?? r.f.db;
    atSend.push({
      billDate: billDateOf(job),
      wechat: [...r.channels.wechat_pay.billDates],
      alipay: [...r.channels.alipay.billDates],
      fees: await feeKeys(handle, appId),
    });
  });
  const ran: Ran[] = [];
  const healed: Heal[] = [];
  try {
    const started = new Map<string, string>();
    await w.seed(started);
    const seeded = daily(w.sent, appId);
    expect(seeded.map(billDateOf), 'nothing reconciled: the first bill day').toEqual([DAYS[0]]);

    let payload: JobPayload | null = seeded[0]!.payload;
    while (payload !== null && ran.length < DAYS.length + 2) {
      const billDate = String(payload['bill_date']);
      const from = w.sent.length;
      ran.push({ billDate, outcome: await w.run(payload) });
      const next = daily(w.sent.slice(from), appId).at(-1);
      payload =
        next !== undefined &&
        dueAtOnce(next) &&
        !ran.some((done) => done.billDate === billDateOf(next))
          ? next.payload
          : null;
      // The same process heals between two runs: it may only repeat the day already pending. (Its
      // outcome is not judged: a catch-up it sends again is refused like the first.)
      const healFrom = w.sent.length;
      await settled(w.seed(started));
      healed.push({
        after: billDate,
        pending: payload === null ? '' : String(payload['bill_date']),
        sent: daily(w.sent.slice(healFrom), appId).filter(dueAtOnce).map(billDateOf),
      });
    }
  } finally {
    w.release();
  }

  expect(
    ran.map((run) => run.billDate),
    'every bill day once, in order',
  ).toEqual(DAYS);
  for (const run of ran) {
    if (run.billDate !== GAP) expect(run.outcome, `the run of ${run.billDate}`).toBe('resolved');
  }
  expect(r.channels.wechat_pay.billDates).toEqual(DAYS);
  expect(r.channels.alipay.billDates).toEqual(DAYS);

  // At most one in flight: each next day was made due only after its previous day was reconciled.
  for (const [index, day] of DAYS.entries()) {
    if (index === 0) continue;
    const previous = DAYS[index - 1]!;
    const seen = atSend.filter((entry) => entry.billDate === day);
    expect(seen.length, `the run of ${day} made due at once`).toBeGreaterThanOrEqual(1);
    for (const entry of seen) {
      expect(entry.wechat, `${previous} wechat bill downloaded before ${day} was due`).toContain(
        previous,
      );
      expect(entry.alipay, `${previous} alipay bill downloaded before ${day} was due`).toContain(
        previous,
      );
      expect(entry.fees, `${previous} reconciled before ${day} was due`).toContain(
        `PAY_FEE:wechat_pay:${previous}`,
      );
      if (previous !== GAP) {
        expect(entry.fees, `${previous} reconciled before ${day} was due`).toContain(
          `PAY_FEE:alipay:${previous}`,
        );
      }
    }
  }
  for (const heal of healed) {
    for (const day of heal.sent) {
      expect(day, `a heal after the run of ${heal.after} adds no second bill day`).toBe(
        heal.pending,
      );
    }
  }

  // The refused catch-up did not stop the chain (r1 S2-b).
  const tried = refused.filter((job) => job.payload['pay_channel'] === 'alipay');
  expect(tried.map(billDateOf), 'the alipay catch-up of the gap day was tried').toContain(GAP);

  const last = daily(w.sent, appId).at(-1);
  expect(last, 'the run of 10-24').toBeDefined();
  expect(billDateOf(last!)).toBe('2026-10-24');
  expect(dueMs(r.f.clock, last!), 'not before 10-24 is over').toBeGreaterThanOrEqual(
    dayEndMs('2026-10-24'),
  );

  const want = DAYS.flatMap((day) => [
    feeVoucherOf('wechat_pay', day, 70n),
    ...(day === GAP ? [] : [feeVoucherOf('alipay', day, 170n)]),
  ]);
  const got = await feeShapes(r);
  expect(got).toHaveLength(want.length);
  expect(got).toEqual(expect.arrayContaining(want));
}, 240_000);
