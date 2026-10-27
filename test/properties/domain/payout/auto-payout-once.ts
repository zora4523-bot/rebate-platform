import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { createPropStats, propParams, type PropStatsRecord } from '@couli/testing';
import fc from 'fast-check';
import type { Transaction } from 'kysely';
import type { AutoPayoutConsumer } from '../../../../apps/api/src/modules/payout/application/auto-payout.ts';
import type { ExecuteBatchInput } from '../../../../apps/api/src/modules/payout/application/payout-execute.ts';
import type { AutoFixture, Fixture } from '../../../spec/payout/auto-payout/kit.ts';

// B2-11c (规划/08 BR-WDR-30 判定时点与并发「每单只判定一次」, 自动路径): under any order of
// withdrawal.created deliveries (redeliveries with new event ids included), human W2 and human W3 on
// two withdrawals of two members that both meet every condition, each withdrawal gets at most one
// W2 in total (one APPROVED wallet.withdrawal_changed), at most one system W2 (one executeBatch for
// it); exactly one system W2 when its first effective event is a delivery, none when a human
// reviewed it first. The entry is spec/payout/auto-payout/sequences.int.test.ts (the integration
// config discovers spec/** only); every generated case runs W1, the consumer's handle (the handler
// registerEventConsumer runs inside its claim transaction) and B2-05e's commands on real PG inside
// one transaction that is rolled back. executeBatch is the recording fake the consumer is given.
// test/properties/README.md: the property body returns a boolean (no expect inside); the entry makes
// the one summary assertion on the returned statistics (each event-order tier ≥ 1% of runs).

const TIERS = ['human_first', 'delivery_first', 'redelivered', 'reject_after_auto'] as const;

interface Op {
  readonly event: 'deliver' | 'approve' | 'reject';
  readonly index: number;
}

/** wallet.withdrawal_changed APPROVED events of `id` on `trx` (every W2, human or system). */
async function approvals(f: AutoFixture, trx: Transaction<DB>, id: string): Promise<number> {
  return (await f.approvals(id, trx)).length;
}

export interface AutoPayoutOnceInput {
  readonly f: AutoFixture;
  /** The second member (same app, own payee). */
  readonly other: Fixture;
  /** createAutoPayoutConsumer with `execute` recording into `calls`. */
  readonly consumer: AutoPayoutConsumer;
  readonly calls: ExecuteBatchInput[];
}

/** Runs the property; returns its generator statistics (flushed) for the entry's one assertion. */
export async function assertAutoPayoutOnce(input: AutoPayoutOnceInput): Promise<PropStatsRecord> {
  const { f, other, consumer, calls } = input;
  const stats = createPropStats('B2-11c:auto-payout-once');
  const operation = fc.record({
    event: fc.constantFrom('deliver', 'approve', 'reject'),
    index: fc.nat({ max: 1 }),
  });
  const commands = f.commands();
  const reviewerId = randomUUID();
  const rollback = new Error('property isolation rollback');
  await fc.assert(
    fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 8 }), async (ops: Op[]) => {
      stats.hit('run');
      calls.length = 0;
      let valid = true;
      try {
        await f.h.db.transaction().execute(async (trx) => {
          const ids = [await f.start(100n, undefined, trx), await f.start(100n, other, trx)];
          const first = new Map<string, 'human' | 'delivery'>();
          const deliveries = new Map<string, number>();
          const autoThenRejected = new Set<string>();
          for (const op of ops) {
            const id = ids[op.index]!;
            const row = await f.row(id, trx);
            if (op.event === 'deliver') {
              if (!first.has(id)) first.set(id, 'delivery');
              deliveries.set(id, (deliveries.get(id) ?? 0) + 1);
              await consumer.handle(await f.event(id, randomUUID(), trx), trx);
              continue;
            }
            const command = {
              appId: f.appId,
              withdrawalId: id,
              expectedStatus: row.status as 'PENDING_REVIEW' | 'APPROVED',
              expectedRowVersion: row.row_version,
              reviewerId,
            };
            if (op.event === 'approve' && row.status === 'PENDING_REVIEW') {
              if (!first.has(id)) first.set(id, 'human');
              const result = await commands.approve(trx, command);
              valid &&= result.kind === 'changed';
            } else if (
              op.event === 'reject' &&
              (row.status === 'PENDING_REVIEW' || row.status === 'APPROVED')
            ) {
              if (!first.has(id)) first.set(id, 'human');
              if (row.review_mode === 'auto') autoThenRejected.add(id);
              const result = await commands.reject(trx, {
                ...command,
                reasonCode: 'OTHER',
                note: null,
              });
              valid &&= result.kind === 'changed';
            }
            if (!valid) break;
          }
          if ([...first.values()].includes('human')) stats.hit('human_first');
          if ([...first.values()].includes('delivery')) stats.hit('delivery_first');
          if ([...deliveries.values()].some((count) => count > 1)) stats.hit('redelivered');
          if (autoThenRejected.size > 0) stats.hit('reject_after_auto');
          for (const id of ids) {
            const system = calls.filter((call) => call.members.includes(id)).length;
            const row = await f.row(id, trx);
            const expected = first.get(id) === 'delivery' ? 1 : 0;
            valid &&=
              system === expected &&
              (await approvals(f, trx, id)) <= 1 &&
              (expected === 0 || row.review_mode === 'auto');
          }
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
      return valid;
    }),
    propParams(),
  );
  return stats.flush();
}

/** The one summary of the entry: runs, discards, and the event-order tiers hit in < 1% of runs. */
export function summarize(record: PropStatsRecord) {
  const runs = record.hits['run'] ?? 0;
  return {
    runs,
    discards: record.discards,
    thin: TIERS.filter((tier) => (record.hits[tier] ?? 0) * 100 < runs),
  };
}
