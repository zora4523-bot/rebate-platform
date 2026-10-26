import type { DB } from '@couli/db';
import { createPropStats, propParams, type PropStatsRecord } from '@couli/testing';
import fc from 'fast-check';
import type { Transaction } from 'kysely';
import type { PayoutExecute } from '../../../../apps/api/src/modules/payout/application/payout-execute.ts';
import { jobs, type ExecuteFixture } from '../../../spec/payout/execute/kit.ts';

// B2-06c ⑦ (规划/08 BR-WDR-12 "jobId = {withdrawal_id}:{execute_seq}", 规划/02 §5.3): under any
// sequence of EXECUTE (single or two-member manual batches, repeated clicks included) and W9
// (PAYING → APPROVED, seeded: W9 belongs to B2-06d), each withdrawal's execute_seq rises by exactly
// one per successful EXECUTE and never otherwise, and its payout jobs are exactly
// {id}:1 … {id}:{execute_seq}, each once, each payload carrying its own execute_seq. The entry is
// spec/payout/execute/sequences.int.test.ts (the integration config discovers spec/** only); every
// generated case runs on real PG inside one transaction that is rolled back.
// test/properties/README.md: the property body returns a boolean (no expect inside); the entry makes
// the one summary assertion on the returned statistics (net tiers 0, 1, odd, > 2^31, each ≥ 1%).
// Generated nets stay ≤ 10^12 fen per withdrawal: the entry seeds a watermark far above any Σ.

const TWO_31 = 2n ** 31n;
const TIERS = ['zero', 'one', 'odd', 'above-2^31'] as const;

const net = fc.oneof(
  fc.constantFrom(0n, 1n),
  fc.bigInt({ min: 0n, max: 10n ** 6n }).map((v) => 2n * v + 1n),
  fc.bigInt({ min: TWO_31 + 1n, max: 10n ** 12n }),
  fc.bigInt({ min: 0n, max: 10n ** 9n }),
);

function tiersOf(fen: bigint): string[] {
  const hit: string[] = [];
  if (fen === 0n) hit.push('zero');
  if (fen === 1n) hit.push('one');
  if (fen % 2n === 1n) hit.push('odd');
  if (fen > TWO_31) hit.push('above-2^31');
  return hit;
}

async function statuses(trx: Transaction<DB>, ids: readonly string[]) {
  const rows = await trx
    .withSchema('app')
    .selectFrom('withdrawals')
    .select(['id', 'status'])
    .where('id', 'in', [...ids])
    .execute();
  return new Map(rows.map((row) => [row.id, row.status]));
}

/** execute_seq equals the expected count and the jobs are exactly {id}:1 … {id}:{seq}, once each. */
async function consistent(
  f: ExecuteFixture,
  trx: Transaction<DB>,
  ids: readonly string[],
  expected: ReadonlyMap<string, number>,
): Promise<boolean> {
  const rows = await trx
    .withSchema('app')
    .selectFrom('withdrawals')
    .select(['id', 'execute_seq'])
    .where('id', 'in', [...ids])
    .execute();
  const queued = await jobs(f, trx);
  return ids.every((each) => {
    const seq = expected.get(each) ?? -1;
    const own = queued.filter((job) => job.data.payload['withdrawal_id'] === each);
    const keys = own.map((job) => job.singleton_key ?? '').sort();
    const want = Array.from({ length: seq }, (_, i) => `${each}:${i + 1}`).sort();
    return (
      rows.find((row) => row.id === each)?.execute_seq === seq &&
      keys.length === want.length &&
      keys.every((key, i) => key === want[i]) &&
      own.every((job) => job.singleton_key === `${each}:${String(job.data.payload['execute_seq'])}`)
    );
  });
}

/** Runs the property; returns its generator statistics (flushed) for the entry's one assertion. */
export async function assertExecuteSequences(
  f: ExecuteFixture,
  service: PayoutExecute,
): Promise<PropStatsRecord> {
  const stats = createPropStats('B2-06c:execute-sequences');
  const operation = fc.record({
    event: fc.constantFrom('EXECUTE', 'W9'),
    index: fc.nat({ max: 5 }),
    pair: fc.boolean(),
  });
  const rollback = new Error('property isolation rollback');
  await fc.assert(
    fc.asyncProperty(
      fc.tuple(net, net, net),
      fc.array(operation, { minLength: 1, maxLength: 12 }),
      async (nets, ops) => {
        stats.hit('run');
        for (const tier of new Set(nets.flatMap(tiersOf))) stats.hit(tier);
        let valid = true;
        try {
          await f.h.db.transaction().execute(async (trx) => {
            const ids: string[] = [];
            for (const value of nets) {
              ids.push(await f.seedWithdrawal({ net: value, fee: value === 0n ? 1n : 0n }, trx));
            }
            const expected = new Map(ids.map((id) => [id, 0]));
            // Every case starts with EXECUTE → W9 → EXECUTE on the first withdrawal (seq 2).
            const sequence: { event: string; index: number; pair: boolean }[] = [
              { event: 'EXECUTE', index: 0, pair: false },
              { event: 'W9', index: 0, pair: false },
              { event: 'EXECUTE', index: 0, pair: false },
              ...ops,
            ];
            for (const op of sequence) {
              const id = ids[op.index % ids.length]!;
              if (op.event === 'W9') {
                await f.seedHold(id, trx);
              } else {
                const members = op.pair ? [id, ids[(op.index + 1) % ids.length]!] : [id];
                const before = await statuses(trx, members);
                const result = await service.executeBatch(trx, {
                  appId: f.appId,
                  members,
                  executorId: f.adminId,
                  now: f.clock.now(),
                });
                if (result.kind !== 'executed') {
                  valid = false;
                  break;
                }
                for (const member of members) {
                  if (before.get(member) === 'APPROVED') {
                    expected.set(member, (expected.get(member) ?? 0) + 1);
                    valid &&= result.paying.includes(member);
                  } else {
                    valid &&=
                      !result.paying.includes(member) &&
                      result.left.some(
                        (left) => left.id === member && left.reason === 'not_approved',
                      );
                  }
                }
              }
              valid &&= await consistent(f, trx, ids, expected);
              if (!valid) break;
            }
            throw rollback;
          });
        } catch (error) {
          if (error !== rollback) throw error;
        }
        return valid;
      },
    ),
    propParams(),
  );
  return stats.flush();
}

/** The one summary of the entry: runs, discards, and the net tiers hit in fewer than 1% of runs. */
export function summarize(record: PropStatsRecord) {
  const runs = record.hits['run'] ?? 0;
  return {
    runs,
    discards: record.discards,
    thin: TIERS.filter((tier) => (record.hits[tier] ?? 0) * 100 < runs),
  };
}
