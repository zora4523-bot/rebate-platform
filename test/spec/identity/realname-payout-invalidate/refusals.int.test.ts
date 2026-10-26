// B1-27g · a correction that is refused or rolled back leaves the payout accounts alone (08 BR-WDR-02
// 细则「实名更正后的失效与重绑」; BR-ID-25 细则「实名更正」; task §9.3 ①「端口抛错 → 整笔回滚」, §9.4):
// no change row, the account still current — whether the refusal comes before the vendor, from the
// vendor, from the re-check under the user row lock (30419 withdrawal_in_progress) or from the
// rollback of the overwrite's transaction (23505 on the verified id_no index → 30405). Each case ends
// with an accepted correction of the same user, which writes exactly one exempt row: nothing of the
// refused attempts is left behind or counted twice.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  MINOR,
  NEW,
  OTHER,
  PROVIDER,
  blacklisted,
  body,
  correct,
  identity,
  ok,
  rejected,
  user,
  verified,
  withdrawal,
  wrongCheckDigit,
} from '../admin-realname/kit.ts';
import { EXEMPT, bound, operatorOf, payoutState, setup } from './kit.ts';

const h = useHarness();

/** Another identity of the user, for the accepted correction after a lost race on NEW. */
const AGAIN = identity(NEW.name, '440305', '1996-07-21', '064');

it('[AC-B1-27g#7] 受理前与供应商的每种拒绝（20001、44001、30407、30405、30406、50401、50301）都不写变更行、账号仍为当前；随后受理只写一条 exempt 行', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await verified(h, target);
  const current = await bound(h, target, 'alipay', true, 'old.payee@example.com');
  const occupant = await user(h, s.appId);
  await verified(h, occupant, OTHER);
  const blocked = identity('林小溪', '450103', '1991-02-14', '079');
  await blacklisted(h, s.appId, blocked.idNo);
  const before = await payoutState(h, target);
  expect(before.accounts.filter((account) => account.is_current)).toHaveLength(1);
  const refuse = async (payload: Record<string, unknown>, code: number) => {
    await rejected(await correct(s, target.id, payload), code);
    expect(await payoutState(h, target), `${code} 不动收款账号与变更行`).toEqual(before);
  };

  await refuse(body(NEW, { id_no: wrongCheckDigit(NEW.idNo) }), 20001);
  await refuse(body(blocked), 44001);
  await refuse(body(MINOR), 30407);
  await refuse(body(OTHER), 30405);
  s.vendor.mockResolvedValueOnce({ outcome: 'mismatch', provider: PROVIDER });
  await refuse(body(NEW), 30406);
  s.vendor.mockResolvedValueOnce({ outcome: 'timeout' });
  await refuse(body(NEW), 50401);
  s.vendor.mockResolvedValueOnce({ outcome: 'unavailable' });
  await refuse(body(NEW), 50301);

  await ok(await correct(s, target.id, body(NEW)));
  const after = await payoutState(h, target);
  expect(after.accounts.filter((account) => account.is_current)).toEqual([]);
  expect(after.changes).toHaveLength(1);
  expect(after.changes[0]).toMatchObject({
    old_hmac: current.alipay_hmac,
    operator: operatorOf(s.actor.id),
    changed_at: s.clock.now(),
    limit_exempt_reason: EXEMPT,
  });
});

it('[AC-B1-27g#8] 用户行锁内复判拒绝（调用供应商期间出现在途提现 → 30419）：不写变更行、账号仍为当前；提现结束后再更正只写一条 exempt 行', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await verified(h, target);
  await bound(h, target, 'alipay', true, 'old.payee@example.com');
  const before = await payoutState(h, target);
  s.vendor.mockImplementationOnce(async () => {
    await withdrawal(h.db, s.clock, target, 'PENDING_REVIEW');
    return { outcome: 'match', provider: PROVIDER };
  });
  await rejected(await correct(s, target.id, body()), 30419, { reason: 'withdrawal_in_progress' });
  expect(s.vendor).toHaveBeenCalledTimes(1);
  expect(await payoutState(h, target)).toEqual(before);

  // The withdrawal ends (rejected at the user's request); the correction is accepted next time.
  await h.db
    .updateTable('withdrawals')
    .set({ status: 'REJECTED', reject_reason_code: 'USER_REQUEST' })
    .where('app_id', '=', s.appId)
    .where('user_id', '=', target.id)
    .where('status', '=', 'PENDING_REVIEW')
    .execute();
  await ok(await correct(s, target.id, body()));
  const after = await payoutState(h, target);
  expect(after.accounts.filter((account) => account.is_current)).toEqual([]);
  expect(after.changes.map((row) => row.limit_exempt_reason)).toEqual([EXEMPT]);
});

it('[AC-B1-27g#9] 覆盖事务回滚（同号同时在别的用户名下核验通过，23505 → 30405）：不写变更行、账号仍为当前；随后受理只写一条 exempt 行', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await verified(h, target);
  await bound(h, target, 'alipay', true, 'old.payee@example.com');
  const occupant = await user(h, s.appId);
  const before = await payoutState(h, target);
  // While the vendor answers, NEW is verified on another user of the app (passed check 6 already).
  s.vendor.mockImplementationOnce(async () => {
    await verified(h, occupant, NEW, s.clock.now());
    return { outcome: 'match', provider: PROVIDER };
  });
  await rejected(await correct(s, target.id, body(NEW)), 30405);
  expect(s.vendor).toHaveBeenCalledTimes(1);
  expect(await payoutState(h, target)).toEqual(before);

  await ok(await correct(s, target.id, body(AGAIN)));
  const after = await payoutState(h, target);
  expect(after.accounts.filter((account) => account.is_current)).toEqual([]);
  expect(after.changes.map((row) => row.limit_exempt_reason)).toEqual([EXEMPT]);
  expect(after.changes[0]).toMatchObject({ changed_at: s.clock.now() });
});
