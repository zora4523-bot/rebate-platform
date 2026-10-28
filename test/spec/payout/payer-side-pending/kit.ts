// B2-06h rule-test helpers (规划/08 BR-WDR-17, BR-WDR-13 ②, BR-WDR-14; B2-06g money r1 S2): a
// transient database error injected once on the statement that completes the pending transfer
// attempt (completeAttempt), the release the queue redelivers, a FakeChannel scripted for both the
// transfer and the query of one out_biz_no, and the end state of a payer-side result that was held
// (W9 payer_side_after_transfer, nothing refunded, nothing queried). Built on the B2-06d process
// kit (process/kit.ts, read only); only *.int.test.ts files import this kit.
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

export const PAYER_SIDE_HOLD = 'payer_side_after_transfer';
export type Cause = 'payer_side' | 'unknown_code';

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

/**
 * BR-WDR-17: `w` is held with payer_side_after_transfer — W9 back to APPROVED (executor cleared,
 * batch and execute_seq kept), one wallet.withdrawal_changed, its one transfer attempt never
 * recorded as anything but the payer-side failure (or still pending), no W5 / W6 and no voucher but
 * its FREEZE (frozen stays, nothing refunded), and no query or landing job left for it.
 */
export async function expectPayerSideHeld(f: ProcessFixture, w: Seeded) {
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
  expect(['pending', 'fail']).toContain(rows[0]?.result);
  if (rows[0]?.result === 'fail') {
    expect(rows[0]).toMatchObject({ resp_code: '40004', resp_sub_code: 'TEST_PAYER_SIDE' });
  }
  expect((await changes(f)).filter((data) => data['withdrawal_id'] === w.id)).toEqual([
    expect.objectContaining({ withdrawal_id: w.id, status: 'APPROVED' }),
  ]);
  expect(await withdrawalVouchers(f)).toEqual([`wd:${w.id}:FREEZE`]);
  const left = jobsOf(await jobs(f), w);
  expect(queryJobs(left)).toEqual([]);
  expect(landJobs(left)).toEqual([]);
}
