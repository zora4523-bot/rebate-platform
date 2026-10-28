// B2-06h rule-test helpers (规划/08 BR-WDR-17, BR-WDR-13 ②, BR-WDR-14; B2-06g money r1 S2): a
// transient database error injected once on the statement that completes the pending transfer
// attempt (completeAttempt), the release the queue redelivers, a FakeChannel scripted for both the
// transfer and the query of one out_biz_no, and the end state of a payer-side result that was held
// (W9 payer_side_after_transfer, nothing refunded, nothing queried). Built on the B2-06d process
// kit (process/kit.ts, read only); only *.int.test.ts files import this kit.
// r2 (spec-test review r1): an outage from the completion on (completion and W9 both fail), and the
// held end state requires the channel's code on the attempt once the same process landed it.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { PostgresQueryCompiler, type Kysely, type KyselyPlugin } from 'kysely';
import { expect } from 'vitest';
import type { JudgementLists } from '../../../../apps/api/src/modules/payout/application/judgement.ts';
import {
  FakeChannel,
  type FakeChannelOptions,
} from '../../../../apps/api/src/modules/payout/infra/channels/fake-channel.ts';
import type { PayoutChannel } from '../../../../apps/api/src/modules/payout/infra/channels/payout-channel.ts';
import type { ReceivedJob } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import {
  ALERT,
  NOW,
  attempts,
  changes,
  jobs,
  queryJobs,
  withdrawal,
  withdrawalVouchers,
  type JobRow,
  type ProcessFixture,
  type Seeded,
} from '../process/kit.ts';
import { SCHEDULE } from '../query/kit.ts';

export const PAYER_SIDE_HOLD = 'payer_side_after_transfer';
export type Cause = 'payer_side' | 'unknown_code';
/** The first query's delay on a query fixture (its payout.query_schedule, points_min[0]). */
export const FIRST_QUERY_S = (SCHEDULE.points_min[0] ?? 1) * 60;

/** A transient database failure (serialization failure), thrown once by the injection below. */
export function transient(): Error {
  return Object.assign(new Error('synthetic transient database error, injected once'), {
    code: '40001',
  });
}

/**
 * `db` with `hook` run on the first statement `matches` picks (raw sql included), right before it
 * is sent; a hook that throws makes that statement reject, so its transaction rolls back.
 */
export function onFirstStatement(
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

/**
 * `db` down from the first statement `matches` picks on: that statement and every later one
 * reject with the transient error (raw sql included) until `heal()` — a short PG outage over the
 * whole landing of one release (the completion, the W9 and any write after them).
 */
export function outageFrom(
  db: Kysely<DB>,
  matches: (text: string, parameters: readonly unknown[]) => boolean,
) {
  const compiler = new PostgresQueryCompiler();
  let state: 'up' | 'down' | 'healed' = 'up';
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      if (state === 'up') {
        const compiled = compiler.compileQuery(args.node, args.queryId);
        if (matches(compiled.sql, compiled.parameters)) state = 'down';
      }
      if (state === 'down') throw transient();
      return args.node;
    },
    transformResult: async (args) => args.result,
  };
  return {
    db: db.withPlugin(plugin),
    seen: () => state !== 'up',
    heal: () => {
      state = 'healed';
    },
  };
}

/**
 * completeAttempt: the first UPDATE of payout_attempts a release sends is the one that settles its
 * pending transfer attempt (④ only inserts; the result is written after ⑤).
 */
export function isAttemptCompletion(text: string): boolean {
  return /^\s*update\b/i.test(text) && /\bpayout_attempts\b/.test(text);
}

/** The release job the queue redelivers for `w` (same payload, a later attempt). */
export function releaseOf(w: Seeded, attempt: number): ReceivedJob {
  return Object.freeze({
    id: randomUUID(),
    queue: 'payout',
    name: 'release',
    payload: { withdrawal_id: w.id, execute_seq: w.executeSeq, app_id: w.appId },
    attempt,
  });
}

/** The jobs whose payload names `w`. */
export function jobsOf(rows: readonly JobRow[], w: Seeded): JobRow[] {
  return rows.filter((row) => row.data.payload['withdrawal_id'] === w.id);
}

/** The worker's pause jobs (payout-landing / pause, still created) of this app. */
export function pauseJobs(rows: readonly JobRow[]): JobRow[] {
  return rows.filter(
    (row) => row.queue === 'payout-landing' && row.data.name === 'pause' && row.state === 'created',
  );
}

/** The landing jobs (payout-landing / land) handed to the worker. */
export function landJobs(rows: readonly JobRow[]): JobRow[] {
  return rows.filter((row) => row.queue === 'payout-landing' && row.data.name === 'land');
}

/** How many payout_queue_paused alerts name `w` (with `cause` when given). */
export function alertCount(f: ProcessFixture, w: Seeded, cause?: Cause): number {
  return f.logger.warn.mock.calls.filter((call: readonly unknown[]) => {
    const fields = call[0] as Record<string, unknown> | undefined;
    return (
      call[1] === ALERT &&
      fields?.['withdrawal_id'] === w.id &&
      (cause === undefined || fields['cause'] === cause)
    );
  }).length;
}

export interface ScriptedBoth {
  readonly channel: PayoutChannel;
  /** The out_biz_no of every transfer call, in order. */
  transfers(): string[];
  /** The out_biz_no of every query call, in order. */
  queries(): string[];
}

/** FakeChannel judging with `lists`, scripted for the transfer and the query per out_biz_no. */
export function scriptedBoth(
  lists: JudgementLists,
  script: FakeChannelOptions['script'],
): ScriptedBoth {
  const fake = new FakeChannel({ mode: 'dry_run', lists, script });
  return {
    channel: fake,
    transfers: () =>
      fake.calls.flatMap((call): string[] =>
        call.kind === 'transfer' ? [call.request.outBizNo] : [],
      ),
    queries: () =>
      fake.calls.flatMap((call): string[] => (call.kind === 'query' ? [call.outBizNo] : [])),
  };
}

export interface HeldExpectation {
  /**
   * The process that judged the result landed the hold on a healthy database (the same transfer
   * handler: at once, or on the redelivered release), so it knows the channel's answer and must
   * have written it: the attempt is result=fail with 40004 / TEST_PAYER_SIDE and its response
   * (otherwise it shows no answer and dailySentFen keeps counting it as pending). False only where
   * the hold may have been landed by a handler that never saw the answer (the query handler, built
   * apart, while the release had rejected): the attempt may then still be pending with no response.
   */
  readonly recorded: boolean;
}

/**
 * BR-WDR-17: `w` is held with payer_side_after_transfer — W9 back to APPROVED (executor cleared,
 * batch and execute_seq kept), one wallet.withdrawal_changed, its one transfer attempt never
 * recorded as anything but the payer-side failure (still pending only as `expected.recorded`
 * allows), no W5 / W6 and no voucher of it but its FREEZE (frozen stays, nothing refunded), and no
 * query or landing job left for it.
 */
export async function expectPayerSideHeld(f: ProcessFixture, w: Seeded, expected: HeldExpectation) {
  expect(await withdrawal(f, w.id)).toMatchObject({
    status: 'APPROVED',
    hold_reason: PAYER_SIDE_HOLD,
    hold_at: NOW,
    executor_id: null,
    executed_at: null,
    batch_id: w.batchId,
    execute_seq: w.executeSeq,
    paid_at: null,
    channel_order_id: null,
    fail_code: null,
  });
  const rows = await attempts(f, w.id);
  expect(rows.map((row) => row.kind)).toEqual(['transfer']);
  if (expected.recorded || rows[0]?.result !== 'pending') {
    expect(rows[0]).toMatchObject({
      result: 'fail',
      resp_code: '40004',
      resp_sub_code: 'TEST_PAYER_SIDE',
      response: expect.anything(),
    });
  } else {
    expect(rows[0]).toMatchObject({ result: 'pending', resp_code: null, resp_sub_code: null });
  }
  expect((await changes(f)).filter((data) => data['withdrawal_id'] === w.id)).toEqual([
    expect.objectContaining({ withdrawal_id: w.id, status: 'APPROVED' }),
  ]);
  expect((await withdrawalVouchers(f)).filter((key) => key.startsWith(`wd:${w.id}:`))).toEqual([
    `wd:${w.id}:FREEZE`,
  ]);
  const left = jobsOf(await jobs(f), w);
  expect(queryJobs(left)).toEqual([]);
  expect(landJobs(left)).toEqual([]);
}
