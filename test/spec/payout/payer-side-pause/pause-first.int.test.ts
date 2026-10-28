// B2-06g rule tests (规划/08 BR-WDR-17, BR-WDR-28; 编排裁定 D10-398 ②, D10-404 ②; B2-06f money r4
// S2): a payer-side code, or an unknown code that pauses the queue, pauses the app in the payout
// process and raises the payout_queue_paused alert as soon as the transfer result is judged —
// before the W9 (payer_side_after_transfer) transaction, the first query job and the pause job.
// When that W9 transaction or the first query send fails with a transient database error, the
// in-process pause and the alert have already taken effect: the next release of the app is W9
// queue_paused without a channel call. The landing still happens: the failed call either landed
// it itself or rejected so the queue redelivers the release, and a redelivery repeats no side
// effect but the alert (one transfer, one attempt, one W9 event, one pause job, no refund).
// Real PostgreSQL through the B2-06d / B2-06f process kit (process/kit.ts, read only): the payout
// process's transfer handler on couli_payout (one instance per test: one process), the worker's
// review on couli_app. The transient error is injected once, on the couli_payout handle (the W9
// statement) or on the queue (the first query send); its message avoids connection wording.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { PostgresQueryCompiler, type Kysely, type KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  JobQueue,
  ReceivedJob,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import {
  ALERT,
  NOW,
  PAYER_SIDE_STEP,
  TIMEOUT,
  UNLISTED_STEP,
  attempts,
  balanceOf,
  changes,
  close,
  configOf,
  expectNoPayeeInLogs,
  expectQueryJob,
  jobs,
  open,
  queryJobs,
  scripted,
  settle,
  setup,
  successStep,
  withdrawal,
  type Harness,
  type JobRow,
  type ProcessFixture,
  type Seeded,
} from '../process/kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

const PAYER_SIDE_HOLD = 'payer_side_after_transfer';
type Cause = 'payer_side' | 'unknown_code';

/** A transient database failure (serialization failure), thrown once by the injections below. */
function transient(): Error {
  return Object.assign(new Error('synthetic transient database error, injected once'), {
    code: '40001',
  });
}

/**
 * `db` with `hook` run on the first statement `matches` picks (raw sql included), right before it
 * is sent; a hook that throws makes that statement reject, so its transaction rolls back.
 */
function onFirstStatement(
  db: Kysely<DB>,
  matches: (text: string, parameters: readonly unknown[]) => boolean,
  hook: () => void,
) {
  const compiler = new PostgresQueryCompiler();
  let seen = false;
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      if (!seen) {
        const compiled = compiler.compileQuery(args.node, args.queryId);
        if (matches(compiled.sql, compiled.parameters)) {
          seen = true;
          hook();
        }
      }
      return args.node;
    },
    transformResult: async (args) => args.result,
  };
  return { db: db.withPlugin(plugin), seen: () => seen };
}

/** The W9 of a payer-side result: the withdrawals UPDATE carrying payer_side_after_transfer. */
function isPayerSideHold(text: string, parameters: readonly unknown[]): boolean {
  return (
    /^\s*update\b/i.test(text) &&
    /\bwithdrawals\b/.test(text) &&
    (text.includes(PAYER_SIDE_HOLD) || parameters.includes(PAYER_SIDE_HOLD))
  );
}

/** The fixture's recording queue with `hook` run on the first send of `queue` / `name`. */
function onFirstSend(f: ProcessFixture, queue: string, name: string, hook: () => void) {
  let seen = false;
  const send: JobQueue['send'] = async (q, n, payload, options) => {
    if (!seen && q === queue && n === name) {
      seen = true;
      hook();
    }
    return f.send(q, n, payload, options);
  };
  return { send, seen: () => seen };
}

/** How many payout_queue_paused alerts name `w` with `cause`. */
function alertCount(f: ProcessFixture, w: Seeded, cause: Cause): number {
  return f.logger.warn.mock.calls.filter((call: readonly unknown[]) => {
    const fields = call[0] as Record<string, unknown> | undefined;
    return call[1] === ALERT && fields?.['withdrawal_id'] === w.id && fields['cause'] === cause;
  }).length;
}

/** The release job the queue redelivers for `w` (same payload, a later attempt). */
function releaseOf(w: Seeded, attempt: number): ReceivedJob {
  return Object.freeze({
    id: randomUUID(),
    queue: 'payout',
    name: 'release',
    payload: { withdrawal_id: w.id, execute_seq: w.executeSeq, app_id: w.appId },
    attempt,
  });
}

/** The worker's pause jobs (payout-landing / pause, still created) of this app. */
function pauseJobs(rows: readonly JobRow[]): JobRow[] {
  return rows.filter(
    (row) => row.queue === 'payout-landing' && row.data.name === 'pause' && row.state === 'created',
  );
}

/** A withdrawal the release held on the in-process pause: W9 queue_paused, nothing sent. */
async function expectPausedInProcess(f: ProcessFixture, w: Seeded) {
  expect(await withdrawal(f, w.id)).toMatchObject({
    status: 'APPROVED',
    hold_reason: 'queue_paused',
    hold_at: NOW,
    executor_id: null,
    executed_at: null,
  });
  expect(await attempts(f, w.id)).toEqual([]);
}

/** Three withdrawals of one member: `w` gets `step`, the other two would succeed. */
async function seedThree(f: ProcessFixture, step: typeof PAYER_SIDE_STEP) {
  const owner = await f.newUser(5_000n);
  const w = await f.seedWithdrawal({ userId: owner, net: 800n });
  const next = await f.seedWithdrawal({ userId: owner, net: 700n });
  const later = await f.seedWithdrawal({ userId: owner, net: 600n });
  const ch = scripted({
    [w.outBizNo]: [step],
    [next.outBizNo]: [successStep(`CH${next.outBizNo}`)],
    [later.outBizNo]: [successStep(`CH${later.outBizNo}`)],
  });
  return { owner, w, next, later, ch, balance: await balanceOf(f, owner) };
}

it(
  '[AC-B2-06g#1] 付款方侧失败且 W9（payer_side_after_transfer）事务遇瞬时 PG 错误：告警与进程内暂停已生效，下一单 release W9 queue_paused、不调用通道；W9 最终落下（本次已落或任务被拒以待重投），重投 release 不再转账、不多写尝试 / 事件 / pause 任务，不退回余额，暂停标记仍在',
  async () => {
    const f = await setup(h);
    const { owner, w, next, later, ch, balance } = await seedThree(f, PAYER_SIDE_STEP);
    const w9 = onFirstStatement(f.h.payout, isPayerSideHold, () => {
      throw transient();
    });
    // One payout process: the same transfer handler instance for every job below.
    const handler = f.rawJob(ch.channel, { db: w9.db, attemptsDb: w9.db });

    const first = await settle(handler(f.jobOf(w)));
    expect(w9.seen()).toBe(true);
    expect(ch.transfers().map((r) => r.outBizNo)).toEqual([w.outBizNo]);
    expect(f.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        withdrawal_id: w.id,
        out_biz_no: w.outBizNo,
        code: '40004',
        sub_code: 'TEST_PAYER_SIDE',
        cause: 'payer_side',
      }),
      ALERT,
    );
    const landedAtOnce = (await withdrawal(f, w.id)).status === 'APPROVED';
    expect(landedAtOnce || !first.ok).toBe(true);

    // The in-process pause holds although W9 failed: the worker's review passes (PG says false),
    // the release does W9 queue_paused and never calls the channel.
    await expect(handler(f.jobOf(next))).resolves.toBeUndefined();
    await expectPausedInProcess(f, next);
    expect(ch.transfers().map((r) => r.outBizNo)).toEqual([w.outBizNo]);

    // The queue redelivers the release (at least once): W9 lands, nothing else is repeated.
    expect(await settle(handler(releaseOf(w, 2)))).toEqual({ ok: true });
    expect(await withdrawal(f, w.id)).toMatchObject({
      status: 'APPROVED',
      hold_reason: PAYER_SIDE_HOLD,
      hold_at: NOW,
      executor_id: null,
      executed_at: null,
      execute_seq: w.executeSeq,
    });
    expect(await attempts(f, w.id)).toEqual([
      expect.objectContaining({
        kind: 'transfer',
        result: 'fail',
        resp_sub_code: 'TEST_PAYER_SIDE',
      }),
    ]);
    expect((await changes(f)).filter((data) => data['withdrawal_id'] === w.id)).toEqual([
      expect.objectContaining({ withdrawal_id: w.id, status: 'APPROVED' }),
    ]);
    expect(pauseJobs(await jobs(f))).toHaveLength(1);

    // The mark is still there (payout.queue_paused's version has not moved).
    await expect(handler(f.jobOf(later))).resolves.toBeUndefined();
    await expectPausedInProcess(f, later);
    expect(ch.transfers().map((r) => r.outBizNo)).toEqual([w.outBizNo]);
    expect(await configOf(f, 'payout.queue_paused')).toBe(false);
    expect(f.pause).not.toHaveBeenCalled();
    expect(await balanceOf(f, owner)).toEqual(balance);
    expectNoPayeeInLogs(f);
  },
  TIMEOUT,
);

it(
  '[AC-B2-06g#2] 清单外业务码（未知并暂停）且首个查询任务遇瞬时 PG 错误：告警与进程内暂停已生效，下一单 release W9 queue_paused、不调用通道；单据仍 PAYING，首个查询最终恰一条（本次已投或任务被拒以待重投），重投 release 不再转账、不多写尝试 / pause 任务，暂停标记仍在',
  async () => {
    const f = await setup(h);
    const { owner, w, next, later, ch, balance } = await seedThree(f, UNLISTED_STEP);
    const query = onFirstSend(f, 'payout', 'query', () => {
      throw transient();
    });
    const handler = f.rawJob(ch.channel, { queue: { send: query.send } });

    const first = await settle(handler(f.jobOf(w)));
    expect(query.seen()).toBe(true);
    expect(ch.transfers().map((r) => r.outBizNo)).toEqual([w.outBizNo]);
    expect(f.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        withdrawal_id: w.id,
        out_biz_no: w.outBizNo,
        code: '40004',
        sub_code: 'TEST_NOT_IN_ANY_LIST',
        cause: 'unknown_code',
      }),
      ALERT,
    );
    expect(await withdrawal(f, w.id)).toMatchObject({ status: 'PAYING', hold_reason: null });
    expect(await attempts(f, w.id)).toEqual([
      expect.objectContaining({ kind: 'transfer', result: 'unknown' }),
    ]);
    const queriedAtOnce = queryJobs(await jobs(f)).length > 0;
    expect(queriedAtOnce || !first.ok).toBe(true);

    await expect(handler(f.jobOf(next))).resolves.toBeUndefined();
    await expectPausedInProcess(f, next);
    expect(ch.transfers().map((r) => r.outBizNo)).toEqual([w.outBizNo]);

    expect(await settle(handler(releaseOf(w, 2)))).toEqual({ ok: true });
    expect(await withdrawal(f, w.id)).toMatchObject({ status: 'PAYING', hold_reason: null });
    expect(await attempts(f, w.id)).toEqual([
      expect.objectContaining({ kind: 'transfer', result: 'unknown' }),
    ]);
    const rows = await jobs(f);
    expectQueryJob(rows, w);
    expect(pauseJobs(rows)).toHaveLength(1);

    await expect(handler(f.jobOf(later))).resolves.toBeUndefined();
    await expectPausedInProcess(f, later);
    expect(ch.transfers().map((r) => r.outBizNo)).toEqual([w.outBizNo]);
    expect(await configOf(f, 'payout.queue_paused')).toBe(false);
    expect(f.pause).not.toHaveBeenCalled();
    expect(await balanceOf(f, owner)).toEqual(balance);
    expectNoPayeeInLogs(f);
  },
  TIMEOUT,
);

it.each([
  { label: '付款方侧失败（payer_side_codes 内）', payer: true },
  { label: '清单外业务码（未知并暂停）', payer: false },
])(
  '[AC-B2-06g#3] $label 正常落地：payout_queue_paused 告警先于 W9 payer_side_after_transfer 语句 / 首个查询任务发出，之后 W9 或首个查询照常落下、pause 任务恰一条、告警恰一次',
  async ({ payer }) => {
    const f = await setup(h);
    const w = await f.seedWithdrawal({ net: 800n });
    const ch = scripted({ [w.outBizNo]: [payer ? PAYER_SIDE_STEP : UNLISTED_STEP] });
    const cause: Cause = payer ? 'payer_side' : 'unknown_code';
    const at: { alerts: number | null } = { alerts: null };
    const record = () => {
      at.alerts = alertCount(f, w, cause);
    };
    const w9 = onFirstStatement(f.h.payout, isPayerSideHold, record);
    const query = onFirstSend(f, 'payout', 'query', record);
    const handler = payer
      ? f.rawJob(ch.channel, { db: w9.db, attemptsDb: w9.db })
      : f.rawJob(ch.channel, { queue: { send: query.send } });

    await expect(handler(f.jobOf(w))).resolves.toBeUndefined();
    expect(payer ? w9.seen() : query.seen()).toBe(true);
    expect(at.alerts).toBe(1);
    expect(alertCount(f, w, cause)).toBe(1);
    const rows = await jobs(f);
    if (payer) {
      expect(await withdrawal(f, w.id)).toMatchObject({
        status: 'APPROVED',
        hold_reason: PAYER_SIDE_HOLD,
        hold_at: NOW,
      });
    } else {
      expect(await withdrawal(f, w.id)).toMatchObject({ status: 'PAYING', hold_reason: null });
      expectQueryJob(rows, w);
    }
    expect(pauseJobs(rows)).toHaveLength(1);
  },
  TIMEOUT,
);
