import type { DB } from '@couli/db';
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import type { Transaction } from 'kysely';
import { expect } from 'vitest';
import type { PayoutExecute } from '../../../../apps/api/src/modules/payout/application/payout-execute.ts';
import { jobs, type ExecuteFixture } from '../../../spec/payout/execute/kit.ts';

// B2-06c ⑦ (规划/08 BR-WDR-12 "jobId = {withdrawal_id}:{execute_seq}", 规划/02 §5.3): under any
// sequence of EXECUTE (single or two-member manual batches, repeated clicks included) and W9
// (PAYING → APPROVED, seeded: W9 belongs to B2-06d), each withdrawal's execute_seq rises by exactly
// one per successful EXECUTE and never otherwise, and its payout jobs are exactly
// {id}:1 … {id}:{execute_seq}, each once, each payload carrying its own execute_seq. The entry is
// spec/payout/execute/sequences.int.test.ts (the integration config discovers spec/** only); every
// generated case runs on real PG inside one transaction that is rolled back.
async function statuses(trx: Transaction<DB>, ids: readonly string[]) {
  const rows = await trx
    .withSchema('app')
    .selectFrom('withdrawals')
    .select(['id', 'status'])
    .where('id', 'in', [...ids])
    .execute();
  return new Map(rows.map((row) => [row.id, row.status]));
}

export async function assertExecuteSequences(f: ExecuteFixture, service: PayoutExecute) {
  const operation = fc.record({
    event: fc.constantFrom('EXECUTE', 'W9'),
    index: fc.nat({ max: 5 }),
    pair: fc.boolean(),
  });
  const rollback = new Error('property isolation rollback');
  await fc.assert(
    fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 12 }), async (ops) => {
      await expect(
        f.h.db.transaction().execute(async (trx) => {
          const ids = [
            await f.seedWithdrawal({ net: 100n }, trx),
            await f.seedWithdrawal({ net: 200n }, trx),
            await f.seedWithdrawal({ net: 300n }, trx),
          ];
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
              expect(result.kind).toBe('executed');
              if (result.kind !== 'executed') throw new Error(`refused: ${result.reason}`);
              for (const member of members) {
                if (before.get(member) === 'APPROVED') {
                  expected.set(member, expected.get(member)! + 1);
                  expect(result.paying).toContain(member);
                } else {
                  expect(result.left).toContainEqual({ id: member, reason: 'not_approved' });
                }
              }
            }
            const rows = await trx
              .withSchema('app')
              .selectFrom('withdrawals')
              .select(['id', 'execute_seq'])
              .where('id', 'in', ids)
              .execute();
            const queued = await jobs(f, trx);
            for (const each of ids) {
              const seq = expected.get(each)!;
              expect(rows.find((row) => row.id === each)!.execute_seq).toBe(seq);
              const own = queued.filter((job) => job.data.payload['withdrawal_id'] === each);
              expect(own.map((job) => job.singleton_key).sort()).toEqual(
                Array.from({ length: seq }, (_, i) => `${each}:${i + 1}`).sort(),
              );
              for (const job of own) {
                expect(job.singleton_key).toBe(`${each}:${String(job.data.payload['execute_seq'])}`);
              }
            }
          }
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    }),
    propParams(),
  );
}
