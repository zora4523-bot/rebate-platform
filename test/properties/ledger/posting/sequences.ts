// PG property body. The discoverable *.int.test.ts entry lives in test/spec/ledger/posting:
// the protected integration config only includes spec/**/*.int.test.ts.
import { randomUUID } from 'node:crypto';
import { addFen, subFen } from '@couli/money';
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect } from 'vitest';
import {
  context,
  entry,
  snapshot,
  voucher,
  type Harness,
} from '../../../spec/ledger/posting/kit.ts';

const operation = fc.record({
  user: fc.integer({ min: 0, max: 1 }),
  kind: fc.constantFrom('credit', 'clawback', 'adjust', 'freeze', 'return'),
  amount: fc.bigInt({ min: 1n, max: 100_000n }),
  positiveAdjust: fc.boolean(),
  replay: fc.boolean(),
});

/** Independent oracle: derive sub-account balances from signed persisted entries and compare
 * every intermediate cache/version. No validateVoucher/applyEntries/mayGoNegative oracle. */
export async function assertPostingSequences(h: Harness): Promise<number> {
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 24 }), async (steps) => {
      const { ledger, appId } = context();
      await h.db.transaction().execute(async (trx) => {
        const accounts = [
          await ledger.openUserAccount(trx, { appId, userId: randomUUID() }),
          await ledger.openUserAccount(trx, { appId, userId: randomUUID() }),
        ];
        await ledger.lockBalances(trx, {
          appId,
          userIds: accounts.map((a) => a.user_id).reverse(),
        });
        const models = accounts.map(() => ({ available: 0n, frozen: 0n, version: 0n }));
        let posted = 0;
        for (const step of steps) {
          const a = accounts[step.user]!;
          const model = models[step.user]!;
          const amount = step.amount;
          const type =
            step.kind === 'credit'
              ? 'REBATE_CREDIT'
              : step.kind === 'clawback'
                ? 'CLAWBACK'
                : step.kind === 'adjust'
                  ? 'ADMIN_ADJUST'
                  : step.kind === 'freeze'
                    ? 'WITHDRAW_FREEZE'
                    : 'WITHDRAW_RETURN';
          const signed =
            step.kind === 'credit' || (step.kind === 'adjust' && step.positiveAdjust)
              ? -amount
              : amount;
          const base = voucher(appId, a.account_id, signed);
          const entries =
            step.kind === 'freeze'
              ? [
                  entry(a.account_id, amount, type),
                  { ...entry(a.account_id, -amount, type), sub_account: 'frozen' as const },
                ]
              : step.kind === 'return'
                ? [
                    entry(a.account_id, -amount, type),
                    { ...entry(a.account_id, amount, type), sub_account: 'frozen' as const },
                  ]
                : base.entries.map((e) => ({ ...e, ledger_type: type }));
          const v = { ...base, entries };
          const invalid =
            step.kind === 'freeze'
              ? model.available < amount
              : step.kind === 'return' && model.frozen < amount;
          const before = await snapshot(trx, appId);
          if (invalid) {
            await expect(ledger.post(trx, v)).rejects.toThrow();
            expect(await snapshot(trx, appId)).toEqual(before);
          } else {
            const result = await ledger.post(trx, v);
            expect(result.kind).toBe('posted');
            posted += 1;
            if (step.kind === 'freeze') {
              model.available = subFen(model.available, amount);
              model.frozen = addFen(model.frozen, amount);
            } else if (step.kind === 'return') {
              model.available = addFen(model.available, amount);
              model.frozen = subFen(model.frozen, amount);
            } else {
              model.available = subFen(model.available, signed);
            }
            model.version += 1n;
            const written = await snapshot(trx, appId);
            for (const e of written.entries.filter(
              (e) => e.voucher_id === result.voucherId && e.account_id === a.account_id,
            )) {
              expect(e.account_version).toBe(model.version);
              expect(e.balance_after_fen).toBe(
                e.sub_account === 'available' ? model.available : model.frozen,
              );
            }
            if (step.replay) {
              expect(await ledger.post(trx, v)).toEqual({
                kind: 'duplicate',
                voucherId: result.voucherId,
              });
              expect(await snapshot(trx, appId)).toEqual(written);
            }
          }
          const state = await snapshot(trx, appId);
          expect(state.vouchers).toHaveLength(posted);
          for (const saved of state.vouchers) {
            const lines = state.entries.filter((e) => e.voucher_id === saved.id);
            expect(lines.length).toBeGreaterThanOrEqual(2);
            expect(lines.every((e) => e.amount_fen !== 0n)).toBe(true);
            expect(lines.reduce((sum, e) => addFen(sum, e.amount_fen), 0n)).toBe(0n);
          }
          for (const [index, acct] of accounts.entries()) {
            const expected = models[index]!;
            const lines = state.entries.filter((e) => e.account_id === acct.account_id);
            const available = lines
              .filter((e) => e.sub_account === 'available')
              .reduce((sum, e) => subFen(sum, e.amount_fen), 0n);
            const frozen = lines
              .filter((e) => e.sub_account === 'frozen')
              .reduce((sum, e) => subFen(sum, e.amount_fen), 0n);
            expect(state.balances.find((b) => b.account_id === acct.account_id)).toMatchObject({
              available_fen: available,
              frozen_fen: frozen,
              version: expected.version,
            });
            expect([available, frozen]).toEqual([expected.available, expected.frozen]);
            expect(frozen).toBeGreaterThanOrEqual(0n);
            const versions = [...new Set(lines.map((e) => e.account_version))];
            expect(versions).toEqual(
              Array.from({ length: Number(expected.version) }, (_, i) => BigInt(i + 1)),
            );
            expect(await ledger.getBalances(trx, { appId, userIds: [acct.user_id] })).toEqual([
              {
                ...acct,
                available_fen: available,
                frozen_fen: frozen,
                version: expected.version,
                negative_since: available < 0n ? '2032-06-15' : null,
              },
            ]);
          }
        }
      });
      checked += 1;
    }),
    propParams(),
  );
  return checked;
}
