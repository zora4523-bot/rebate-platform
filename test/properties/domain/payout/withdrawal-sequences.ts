import { addFen } from '@couli/money';
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect } from 'vitest';
import type { StateFixture } from '../../../spec/payout/state/kit.ts';
import type { WithdrawalCommands } from '../../../../apps/api/src/modules/payout/application/withdrawal-commands.ts';

// The integration test entry is in spec/payout/state because the existing integration config
// discovers spec/**/*.int.test.ts only. This property exercises actual APPLY/W2/W3 and PG;
// no duplicate state-machine implementation or mock ledger serves as the system under test.
export async function assertWithdrawalSequences(f: StateFixture, commands: WithdrawalCommands) {
  const operation = fc.record({
    event: fc.constantFrom('APPLY', 'APPROVE', 'REJECT'),
    index: fc.nat({ max: 12 }),
    amount: fc.integer({ min: 1, max: 5 }).map((yuan) => BigInt(yuan) * 100n),
  });
  const rollback = new Error('property isolation rollback');
  const apply = f.service();
  await fc.assert(
    fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 12 }), async (ops) => {
      await expect(
        f.h.db.transaction().execute(async (trx) => {
          const ids: string[] = [];
          // Every generated case includes APPLY -> APPROVE -> REJECT, followed by arbitrary events.
          const sequence = [
            { event: 'APPLY', index: 0, amount: 100n },
            { event: 'APPROVE', index: 0, amount: 100n },
            { event: 'REJECT', index: 0, amount: 100n },
            ...ops,
          ];
          for (const op of sequence) {
            if (op.event === 'APPLY') {
              const result = await apply.apply(trx, {
                ...f.actor,
                amountFen: op.amount,
                stepUpValid: true,
              });
              expect(result.code).toBe(0);
              if (result.code !== 0 || !('withdrawal_id' in result.data))
                throw new Error('APPLY refused');
              expect(typeof result.data.withdrawal_id).toBe('string');
              if (typeof result.data.withdrawal_id !== 'string')
                throw new Error('invalid withdrawal id');
              ids.push(result.data.withdrawal_id);
            } else {
              const id = ids[op.index % ids.length]!;
              const row = await trx
                .withSchema('app')
                .selectFrom('withdrawals')
                .selectAll()
                .where('id', '=', id)
                .executeTakeFirstOrThrow();
              const input = {
                ...f.command(id),
                expectedStatus: row.status as 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED',
                expectedRowVersion: row.row_version,
              };
              const result =
                op.event === 'APPROVE'
                  ? await commands.approve(trx, input)
                  : await commands.reject(trx, {
                      ...input,
                      reasonCode: 'USER_REQUEST',
                      note: null,
                    });
              const allowed =
                op.event === 'APPROVE'
                  ? row.status === 'PENDING_REVIEW'
                  : row.status === 'PENDING_REVIEW' || row.status === 'APPROVED';
              expect(result.kind).toBe(allowed ? 'changed' : 'refused');
            }
            const rows = await trx
              .withSchema('app')
              .selectFrom('withdrawals')
              .selectAll()
              .where('app_id', '=', f.actor.appId)
              .where('user_id', '=', f.actor.userId)
              .execute();
            const balances = await f.ledger.getBalances(trx, {
              appId: f.actor.appId,
              userIds: [f.actor.userId],
            });
            const frozen = rows
              .filter((r) => ['PENDING_REVIEW', 'APPROVED', 'PAYING'].includes(r.status))
              .reduce((total, row) => addFen(total, row.amount_fen), 0n);
            expect(balances[0]!.frozen_fen).toBe(frozen);
            expect(addFen(balances[0]!.available_fen, frozen)).toBe(10000n);
            expect(
              rows.every(
                (row) => row.amount_fen === row.net_fen && row.fee_fen === 0n && row.tax_fen === 0n,
              ),
            ).toBe(true);
            const returns = await trx
              .withSchema('app')
              .selectFrom('ledger_vouchers')
              .select(['uniq_key'])
              .where('app_id', '=', f.actor.appId)
              .where('uniq_key', 'like', 'wd:%:RETURN')
              .execute();
            expect(returns.map((row) => row.uniq_key).sort()).toEqual(
              rows
                .filter((row) => row.status === 'REJECTED')
                .map((row) => `wd:${row.id}:RETURN`)
                .sort(),
            );
          }
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    }),
    propParams(),
  );
}
