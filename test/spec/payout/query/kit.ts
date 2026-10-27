// B2-06e rule tests (规划/08 BR-WDR-14, BR-WDR-15, BR-WDR-17, BR-WDR-28; state machine W5 / W6;
// 规划/12 §5.4): the payout process's query job, its schedule and the crash recovery scan, on a
// real PostgreSQL with the real `payout` queue (pgboss.job read with plain SQL), the real ledger
// and event bus, and B2-06b's FakeChannel behind a thin recording wrapper. B2-06d's process kit
// does the rest: the database, the PAYING seeds with their real WITHDRAW:FREEZE voucher, attempts
// inserted as couli_payout, observers and snapshots.
// Conventions of these tests (from the orchestrator's brief of B2-06e):
//   - T is the `at` of the seeded transfer attempt; the clock stays at NOW and T is set relative
//     to it. payout.query_schedule is the default [1, 5, 30, 120] / 120 / 1440.
//   - The wait between two tries is the injected `sleep` port (vi.fn: never really waits).
//   - Each try is one kind=query attempt whose request carries { out_biz_no, point, try } with
//     try = 1, 2, 3.
//   - The next point's job: singletonKey `${id}:${seq}:query:${n}`, delaySeconds T + offset − now.
// Only *.int.test.ts files call setup (they create the database). The handler and recovery
// factories are called inside each test before anything is observed: red is NotImplemented.
// B2-06fz (D10-326 C): `f.queryJob(...)` runs the worker's turn after the handler (landing jobs
// landed, their rows deleted); `f.rawQueryJob(...)` is the payout process's handler alone.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { vi } from 'vitest';
import type { JudgementLists } from '../../../../apps/api/src/modules/payout/application/judgement.ts';
import {
  createQueryRecovery,
  type QueryRecoveryOptions,
} from '../../../../apps/api/src/modules/payout/application/query-recovery.ts';
import {
  FakeChannel,
  type FakeStep,
} from '../../../../apps/api/src/modules/payout/infra/channels/fake-channel.ts';
import type { PayoutChannel } from '../../../../apps/api/src/modules/payout/infra/channels/payout-channel.ts';
import {
  createQueryJob,
  type QueryJobOptions,
} from '../../../../apps/api/src/modules/payout/jobs/query-job.ts';
import type {
  JobHandler,
  ReceivedJob,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import {
  HOUR,
  NOW,
  setup as processSetup,
  type Harness,
  type JobRow,
  type SeedWithdrawal,
  type Seeded,
} from '../process/kit.ts';

export {
  HOUR,
  MINUTE,
  NOW,
  TIMEOUT,
  LOGON_ID,
  PAYEE_NAME,
  attempts,
  balanceOf,
  changes,
  close,
  configOf,
  entries,
  expectNoPayeeInLogs,
  open,
  snapshot,
  withdrawal,
  withdrawalVouchers,
  type Harness,
  type JobRow,
  type Seeded,
} from '../process/kit.ts';

export const SECOND = 1_000;
export const DAY = 24 * HOUR;
/** The gap between two tries of one point (BR-WDR-14: at most 3 tries, 10 seconds apart). */
export const RETRY_GAP_MS = 10_000;
export const NEEDS_MANUAL_ALERT = 'payout_needs_manual';

/** payout.query_schedule of these tests: the default of 规划/04 §10 / BR-WDR-14. */
export const SCHEDULE = {
  points_min: [1, 5, 30, 120],
  interval_min: 120,
  manual_after_min: 1440,
};

/** An instant `offsetMs` from NOW (negative: before). */
export function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

/**
 * Synthetic lists (not verified Alipay codes or statuses): FakeChannel judges queries with them
 * and the same query_status_map is stored in config (BR-WDR-28).
 */
export const QUERY_LISTS: JudgementLists = {
  definiteFailCodes: ['TEST_CONFIRMED_FAIL'],
  payerSideCodes: ['TEST_PAYER_SIDE'],
  queryStatusMap: { SUCCESS: 'success', TEST_CLOSED: 'fail', DEALING: 'unknown' },
};

export function querySuccess(channelOrderId: string, paidAt?: string): FakeStep {
  return paidAt === undefined
    ? { kind: 'response', raw: { code: '10000' }, status: 'SUCCESS', channelOrderId }
    : { kind: 'response', raw: { code: '10000' }, status: 'SUCCESS', channelOrderId, paidAt };
}
/** A status query_status_map maps to fail (W6); its sub code becomes fail_code. */
export const QUERY_FAIL_STEP: FakeStep = {
  kind: 'response',
  raw: { code: '10000', subCode: 'TEST_QUERY_FAIL' },
  status: 'TEST_CLOSED',
};
/** "The order does not exist" (a business error of the query): unknown (BR-WDR-14). */
export const NOT_FOUND_STEP: FakeStep = {
  kind: 'response',
  raw: { code: '40004', subCode: 'ORDER_NOT_EXIST', msg: 'synthetic' },
};
/** Processing: unknown. */
export const DEALING_STEP: FakeStep = {
  kind: 'response',
  raw: { code: '10000' },
  status: 'DEALING',
};
/** A status outside query_status_map: unknown. */
export const UNLISTED_STATUS_STEP: FakeStep = {
  kind: 'response',
  raw: { code: '10000' },
  status: 'TEST_STATUS_NOT_IN_MAP',
};
export const SYSTEM_ERROR_STEP: FakeStep = {
  kind: 'response',
  raw: { code: '20000', subCode: 'SYSTEM_ERROR', msg: 'synthetic' },
};
/** A payer-side transfer code answered to a query: still only unknown (no pause). */
export const PAYER_SIDE_CODE_STEP: FakeStep = {
  kind: 'response',
  raw: { code: '40004', subCode: 'TEST_PAYER_SIDE', msg: 'synthetic' },
};
export const UNKNOWN_STEP: FakeStep = { kind: 'unknown' };
export const TIMEOUT_STEP: FakeStep = { kind: 'timeout' };

/** A scripted query step: FakeChannel's steps plus a rejected call (network error). */
export type QueryStep = FakeStep | { kind: 'network' };
export const NETWORK_STEP: QueryStep = { kind: 'network' };

export interface QueryHooks {
  /** Runs when a query call starts, before the fake answers (`call` counts from 1). */
  before?: (outBizNo: string, call: number) => Promise<void>;
}

export interface QueryChannel {
  channel: PayoutChannel;
  /** The out_biz_no of every query call, in order. */
  queries(): string[];
  /** Number of transfer calls (must stay 0: a query never transfers again). */
  transfers(): number;
}

/** FakeChannel with query scripts per out_biz_no, behind a recording wrapper. */
export function queryScripted(
  steps: Readonly<Record<string, readonly QueryStep[]>>,
  hooks: QueryHooks = {},
): QueryChannel {
  const fake = new FakeChannel({
    mode: 'dry_run',
    lists: QUERY_LISTS,
    script: Object.fromEntries(
      Object.entries(steps).map(([outBizNo, list]): [string, { query: FakeStep[] }] => [
        outBizNo,
        { query: list.filter((step): step is FakeStep => step.kind !== 'network') },
      ]),
    ),
  });
  const pending = new Map<string, QueryStep[]>(
    Object.entries(steps).map(([outBizNo, list]): [string, QueryStep[]] => [outBizNo, [...list]]),
  );
  const queried: string[] = [];
  let transfers = 0;
  const channel: PayoutChannel = {
    async transfer() {
      transfers += 1;
      return { kind: 'unknown', raw: { code: 'TEST_NO_TRANSFER' }, latencyMs: 0 };
    },
    async query(outBizNo) {
      queried.push(outBizNo);
      if (hooks.before !== undefined) await hooks.before(outBizNo, queried.length);
      const step = pending.get(outBizNo)?.shift();
      if (step?.kind === 'network') throw new Error('synthetic network failure');
      return fake.query(outBizNo);
    },
  };
  return { channel, queries: () => [...queried], transfers: () => transfers };
}

export async function setup(h: Harness) {
  const f = await processSetup(h);
  await f.set('payout.query_schedule', SCHEDULE);
  await f.set('payout.query_status_map', QUERY_LISTS.queryStatusMap);
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);

  /**
   * The payout process's query handler alone: nothing lands what it enqueued on payout-landing
   * (B2-06fz handoff tests; called inside each test: red is the skeleton's NotImplemented).
   */
  function rawQueryJob(channel: PayoutChannel, extra: Partial<QueryJobOptions> = {}): JobHandler {
    const { db, attemptsDb, clock, config, ledger, lockUsersForUpdate, queue, eventBus } =
      f.options;
    return createQueryJob({
      db,
      attemptsDb,
      clock,
      config,
      ledger,
      lockUsersForUpdate,
      queue,
      eventBus,
      channels: { alipay: channel, bank_card: channel },
      sleep,
      logger: f.logger,
      ...extra,
    });
  }

  /**
   * The query handler (called inside each test: red is the skeleton's NotImplemented), followed
   * by the worker's turn (B2-06fz, D10-326 C): the landing jobs it enqueued are landed and their
   * rows deleted (process kit's withAutoLand), so the assertions read the landed result.
   */
  function queryJob(channel: PayoutChannel, extra: Partial<QueryJobOptions> = {}): JobHandler {
    return f.withAutoLand(rawQueryJob(channel, extra));
  }

  /** The recovery scan (called inside each test: red is the skeleton's NotImplemented). */
  function recovery(extra: Partial<QueryRecoveryOptions> = {}) {
    return createQueryRecovery({
      attemptsDb: f.options.attemptsDb,
      config: f.options.config,
      queue: f.options.queue,
      logger: f.logger,
      ...extra,
    });
  }

  /** The query job of point `point` for `w` (overrides: a stale seq, another app, a redelivery). */
  function queryJobOf(
    w: Pick<Seeded, 'id' | 'appId' | 'executeSeq'>,
    point: number,
    overrides: { seq?: number; appId?: string; attempt?: number } = {},
  ): ReceivedJob {
    return Object.freeze({
      id: randomUUID(),
      queue: 'payout',
      name: 'query',
      payload: {
        withdrawal_id: w.id,
        execute_seq: overrides.seq ?? w.executeSeq,
        app_id: overrides.appId ?? w.appId,
        point,
      },
      attempt: overrides.attempt ?? 1,
    });
  }

  /** A PAYING (by default) withdrawal whose transfer attempt was written at T = `transferAt`. */
  async function seedPaying(
    transferAt: Date,
    values: SeedWithdrawal = {},
    result: 'pending' | 'success' | 'unknown' = 'unknown',
  ): Promise<Seeded> {
    const w = await f.seedWithdrawal(values);
    await f.seedAttempt(w.id, 'transfer', result, transferAt, w.appId);
    return w;
  }

  /** needs_manual = true as an earlier T + 24 h decision left it (couli_payout's column). */
  async function markNeedsManual(w: Seeded) {
    await sql`UPDATE app.withdrawals SET needs_manual = true, row_version = row_version + 1
      WHERE app_id = ${w.appId} AND id = ${w.id}`.execute(h.payout);
  }

  /** A query job of point `point` already queued for `w` (straight through the runtime). */
  async function seedQueued(w: Seeded, point: number, delaySeconds: number) {
    await h.setup.runtime.send(
      'payout',
      'query',
      { withdrawal_id: w.id, execute_seq: w.executeSeq, app_id: w.appId, point },
      { trx: null, singletonKey: `${w.id}:${w.executeSeq}:query:${point}`, delaySeconds },
    );
  }

  return {
    ...f,
    sleep,
    queryJob,
    rawQueryJob,
    recovery,
    queryJobOf,
    seedPaying,
    markNeedsManual,
    seedQueued,
  };
}
export type QueryFixture = Awaited<ReturnType<typeof setup>>;

/** The query job row the handler or the scan should leave for point `point` of `w`. */
export function queryJobRow(w: Seeded, point: number, delayS: number, seq = w.executeSeq): JobRow {
  return {
    queue: 'payout',
    singleton_key: `${w.id}:${seq}:query:${point}`,
    state: 'created',
    data: {
      name: 'query',
      payload: { withdrawal_id: w.id, execute_seq: seq, app_id: w.appId, point },
    },
    delay_s: delayS,
  };
}

/** Every job (any queue, any app) whose payload names this withdrawal. */
export async function jobsOf(
  f: QueryFixture,
  withdrawalId: string,
  db: Kysely<DB> = f.h.observer,
): Promise<JobRow[]> {
  const result = await sql<JobRow>`
    SELECT name AS queue, singleton_key, state::text AS state, data,
      round(extract(epoch FROM start_after - created_on))::int AS delay_s
    FROM pgboss.job
    WHERE data->'payload'->>'withdrawal_id' = ${withdrawalId}
    ORDER BY name, singleton_key NULLS LAST, created_on, id`.execute(db);
  return result.rows;
}

function field(request: unknown, key: string): unknown {
  return typeof request === 'object' && request !== null
    ? (request as Record<string, unknown>)[key]
    : undefined;
}

/** `try` of a query attempt's request (NaN when absent). */
export function tryOf(request: unknown): number {
  const value = field(request, 'try');
  return typeof value === 'number' ? value : Number.NaN;
}

/** `point` of a query attempt's request (NaN when absent). */
export function pointOf(request: unknown): number {
  const value = field(request, 'point');
  return typeof value === 'number' ? value : Number.NaN;
}

/** The kind=query attempts of a withdrawal, in try order. */
export async function queryAttempts(
  f: QueryFixture,
  withdrawalId: string,
  db: Kysely<DB> = f.h.observer,
) {
  const rows = await db
    .withSchema('app')
    .selectFrom('payout_attempts')
    .selectAll()
    .where('withdrawal_id', '=', withdrawalId)
    .where('kind', '=', 'query')
    .orderBy('at')
    .orderBy('id')
    .execute();
  return [...rows].sort((a, b) => tryOf(a.request) - tryOf(b.request));
}

/** [result, point, try] of each query attempt, in try order. */
export async function querySummary(f: QueryFixture, withdrawalId: string) {
  return (await queryAttempts(f, withdrawalId)).map((row) => [
    row.result,
    pointOf(row.request),
    tryOf(row.request),
  ]);
}

/** A member entry (USER_BALANCE; debit positive, credit negative). */
export function user(sub: 'available' | 'frozen', amount: bigint, type: string) {
  return {
    owner_type: 'user',
    subject: 'USER_BALANCE',
    sub_account: sub,
    amount_fen: amount,
    ledger_type: type,
  };
}

/** A platform entry (stored on the available sub-account). */
export function platform(subject: string, amount: bigint, type: string) {
  return {
    owner_type: 'platform',
    subject,
    sub_account: 'available',
    amount_fen: amount,
    ledger_type: type,
  };
}

/** The same-transaction sends of query jobs the handler / scan made (the options argument). */
export function querySends(f: QueryFixture) {
  return f.send.mock.calls
    .filter((call) => call[0] === 'payout' && call[1] === 'query')
    .map((call) => call[3]);
}
