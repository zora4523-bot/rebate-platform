import { afterAll, beforeAll, expect, it } from 'vitest';
import { closeKit, fixture, me, openKit, type Kit } from '../../identity/me/http-kit.ts';
import { CLAIM_CASES, claim } from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

for (const specimen of CLAIM_CASES) {
  it(`[AC-B1-11p#2] GET /v1/me：其他人的 ${specimen[0]} 申请不影响本人，本人提交后 eligible=false`, async () => {
    const f = await fixture(kit, { phone: true });
    const other = await fixture(kit, { appId: f.appId, phone: true });
    await claim(f.db, f.appId, other.uid, specimen, kit.clock.now());
    const before = await f.row();
    // me() validates each HTTP response against the real getMe contract.
    expect(me(kit, await f.get()).invite_backfill).toEqual({
      eligible: true,
      deadline_at: expect.any(String),
    });
    const savedClaim = await claim(f.db, f.appId, f.uid, specimen, kit.clock.now());
    const result = me(kit, await f.get());
    expect(result.user_id).toBe(f.uid);
    expect(result.inviter_bound).toBe(false);
    expect(result.invite_backfill).toEqual({ eligible: false, deadline_at: null });
    expect(await f.row()).toEqual(before);
    expect(
      await f.db
        .selectFrom('relation_change_logs')
        .selectAll()
        .where('app_id', '=', f.appId)
        .where('user_id', '=', f.uid)
        .execute(),
    ).toEqual([]);
    expect(
      await f.db.selectFrom('claims').selectAll().where('id', '=', savedClaim.id).execute(),
    ).toEqual([savedClaim]);
  });
}
