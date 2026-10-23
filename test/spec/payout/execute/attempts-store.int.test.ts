// B2-06c: payout's read-only payout_attempts store (BR-WDR-12 ② "该单没有任何 kind=transfer 的
// payout_attempts 记录"; B2-05e's WithdrawalAttemptsPort, which app.module wires to it). Attempts are
// inserted as couli_payout (the only writer); the store reads as couli_app on the caller's transaction.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPayoutAttemptsStore } from '../../../../apps/api/src/modules/payout/infra/payout-attempts-store.ts';
import { TIMEOUT, close, open, setup, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-06c#2] hasTransfer：任何结果的 transfer 尝试都算，query 不算，别的提现单的不算', async () => {
  const f = await setup(h);
  const store = createPayoutAttemptsStore();
  const none = await f.seedWithdrawal();
  const failed = await f.seedWithdrawal();
  const queried = await f.seedWithdrawal();
  await f.seedAttempt(failed, 'transfer', 'fail');
  await f.seedAttempt(queried, 'query', 'success');
  const answers = await h.db.transaction().execute(async (trx) => ({
    none: await store.hasTransfer(trx, { appId: f.appId, withdrawalId: none }),
    failed: await store.hasTransfer(trx, { appId: f.appId, withdrawalId: failed }),
    queried: await store.hasTransfer(trx, { appId: f.appId, withdrawalId: queried }),
  }));
  expect(answers).toEqual({ none: false, failed: true, queried: false });
});

it('[AC-B2-06c#2] hasAttempt（WithdrawalAttemptsPort）：按 kinds 与 results 过滤，results 省略即任何结果', async () => {
  const f = await setup(h);
  const store = createPayoutAttemptsStore();
  const failed = await f.seedWithdrawal();
  const pending = await f.seedWithdrawal();
  const queried = await f.seedWithdrawal();
  await f.seedAttempt(failed, 'transfer', 'fail');
  await f.seedAttempt(pending, 'transfer', 'pending');
  await f.seedAttempt(queried, 'query', 'success');
  const live = ['pending', 'success', 'unknown'] as const;
  const answers = await h.db
    .transaction()
    .execute(async (trx) => [
      await store.hasAttempt(trx, failed, ['transfer']),
      await store.hasAttempt(trx, failed, ['transfer'], live),
      await store.hasAttempt(trx, failed, ['query']),
      await store.hasAttempt(trx, pending, ['transfer'], live),
      await store.hasAttempt(trx, queried, ['transfer']),
      await store.hasAttempt(trx, queried, ['query']),
      await store.hasAttempt(trx, queried, ['transfer', 'query'], ['success']),
      await store.hasAttempt(trx, queried, ['query'], ['fail']),
    ]);
  expect(answers).toEqual([true, false, false, true, false, true, true, false]);
});
