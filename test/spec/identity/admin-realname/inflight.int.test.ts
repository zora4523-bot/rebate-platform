// B1-27a · the re-check after the vendor's match (08 BR-ID-25 细则「实名更正」在途复核, D10-185; task
// §9 ②): in the transaction that overwrites, under the user row lock (the same user-level lock as a
// withdrawal application), the user's withdrawals are judged again; a non-terminal one that appeared
// meanwhile refuses the correction as 30419 withdrawal_in_progress and nothing is overwritten,
// invalidated, moved or published. The refusal is still audited.
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { useHarness, type Response } from '../../admin/auth/kit.ts';
import {
  PROVIDER,
  added,
  audits,
  body,
  correct,
  payoutAccount,
  priorWritten,
  rejected,
  rowText,
  setup,
  snapshot,
  someoneWaitsForALock,
  user,
  verified,
  withdrawal,
} from './kit.ts';

const h = useHarness();

it.each(['PENDING_REVIEW', 'APPROVED'] as const)(
  '[AC-B1-27a#29] 调用供应商期间出现 %s 提现单 → 一致后复判拒绝 30419 withdrawal_in_progress，什么都不改，记审计',
  async (status) => {
    const s = await setup(h);
    const target = await user(h, s.appId);
    await verified(h, target);
    // A paid-out withdrawal too, so a move to the isolated store would be due on success.
    await withdrawal(h.db, s.clock, target, 'PAID_API');
    await payoutAccount(h, target, 'alipay', true);
    s.vendor.mockImplementation(async () => {
      await withdrawal(h.db, s.clock, target, status);
      return { outcome: 'match', provider: PROVIDER };
    });
    const before = { data: await snapshot(h, s.appId), audits: await audits(h, s.appId) };
    const response = await correct(s, target.id, body());
    await rejected(response, 30419, { reason: 'withdrawal_in_progress' });
    expect(s.vendor).toHaveBeenCalledTimes(1);
    const after = await snapshot(h, s.appId);
    expect(after.withdrawals).toHaveLength(before.data.withdrawals.length + 1);
    expect({ ...after, withdrawals: [] }).toEqual({ ...before.data, withdrawals: [] });
    expect(priorWritten(s)).toEqual([]);
    const rows = added(before.audits, await audits(h, s.appId));
    expect(rows).toHaveLength(1);
    expect(rowText(rows[0]!)).toContain('30419');
  },
);

it('[AC-B1-27a#30] 复判在用户行锁内：锁被提现申请占着时更正等锁，拿到锁后看见新提现单即拒绝', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await verified(h, target);
  await payoutAccount(h, target, 'alipay', true);
  const before = await snapshot(h, s.appId);
  const run: { pending?: Promise<Response>; waited: boolean } = { waited: false };
  // Plays a withdrawal application: holds the user row lock, creates its withdrawal, commits.
  await h.db.transaction().execute(async (trx) => {
    await sql`SELECT id FROM app.users WHERE app_id = ${target.appId} AND id = ${target.id} FOR UPDATE`.execute(
      trx,
    );
    run.pending = correct(s, target.id, body());
    run.waited = await someoneWaitsForALock(h);
    if (run.waited) await withdrawal(trx, s.clock, target, 'PENDING_REVIEW');
  });
  expect(run.pending).toBeDefined();
  const response = await run.pending!;
  expect(run.waited, '更正必须在覆盖前等用户行锁').toBe(true);
  await rejected(response, 30419, { reason: 'withdrawal_in_progress' });
  const after = await snapshot(h, s.appId);
  expect(after.realname).toEqual(before.realname);
  expect(after.payoutAccounts).toEqual(before.payoutAccounts);
  expect(after.events).toEqual(before.events);
  expect(priorWritten(s)).toEqual([]);
});
