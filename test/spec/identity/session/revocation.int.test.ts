import { afterAll, beforeAll, expect, it } from 'vitest';
import { revokeSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import type { SessionRevokeReason } from '../../../../apps/api/src/modules/identity/application/revoke-sessions.ts';
import { seedUser } from '../registration/kit.ts';
import { openSuite, closeSuite, fixture, identityExports, success, type Suite } from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
}, 30_000);

for (const target of ['user', 'device'] as const) {
  for (const reason of [
    'logout',
    'refresh_reuse',
    'phone_changed',
    'merged',
    'banned',
    'admin_revoked',
    'device_revoked',
  ] satisfies SessionRevokeReason[]) {
    it(`[AC-ACC-05][BR-ID-06/07] 按${target}吊销所有活跃sid，reason=${reason}且不改已吊销会话`, async () => {
      const f = await fixture(suite);
      const api = await identityExports();
      const otherUid = await seedUser(f.db, f.appId);
      const otherDevice = await f.device();
      const second =
        target === 'user' ? await f.issue(f.uid, otherDevice) : await f.issue(otherUid, f.deviceId);
      const unrelated =
        target === 'user' ? await f.issue(otherUid, f.deviceId) : await f.issue(f.uid, otherDevice);
      const old = await f.issue();
      await f.db
        .transaction()
        .execute((trx) =>
          revokeSession(trx, { app_id: f.appId, sid: old.sid, reason: 'logout' }, f.clock),
        );
      const oldRow = await f.session(old.sid);
      const devices = await Promise.all([f.deviceRow(), f.deviceRow(otherDevice)]);
      const chain = await f.chain();
      f.clock.advanceMs(1000);
      const expected = [f.initial.sid, second.sid].sort();
      let hookSids: readonly string[] | undefined;
      const returned = await f.db.transaction().execute(async (trx) => {
        const hook = async (same: typeof trx, sids: readonly string[]) => {
          expect(same).toBe(trx);
          hookSids = sids;
          const rows = await same
            .selectFrom('sessions')
            .select(['sid', 'revoked_at', 'revoke_reason'])
            .where('app_id', '=', f.appId)
            .where('sid', 'in', [...sids])
            .execute();
          expect(rows).toHaveLength(2);
          for (const row of rows)
            expect(row).toMatchObject({ revoked_at: f.clock.now(), revoke_reason: reason });
        };
        return target === 'user'
          ? api.revokeSessionsByUser(
              trx,
              { app_id: f.appId, user_id: f.uid, reason },
              f.clock,
              hook,
            )
          : api.revokeSessionsByDevice(
              trx,
              { app_id: f.appId, device_id: f.deviceId, reason },
              f.clock,
              hook,
            );
      });
      expect(returned.sort()).toEqual(expected);
      expect(hookSids?.toSorted()).toEqual(expected);
      for (const sid of expected)
        expect(await f.session(sid)).toMatchObject({
          revoked_at: f.clock.now(),
          revoke_reason: reason,
        });
      expect(await f.session(old.sid)).toEqual(oldRow);
      expect((await f.session(unrelated.sid)).revoked_at).toBeNull();
      expect(await Promise.all([f.deviceRow(), f.deviceRow(otherDevice)])).toEqual(devices);
      expect(await f.chain()).toEqual(chain);
      for (const issued of [f.initial, second]) {
        const deviceId = issued === second && target === 'user' ? otherDevice : f.deviceId;
        expect(
          await f.refresh({
            refresh_token: issued.refresh_token,
            verifiedDevice: { appId: f.appId, deviceId },
          }),
        ).toEqual({ code: 10404 });
        await expect(f.access(issued.access_token, deviceId)).rejects.toMatchObject({
          code: 10002,
        });
      }
      const again = await f.db
        .transaction()
        .execute((trx) =>
          target === 'user'
            ? api.revokeSessionsByUser(
                trx,
                { app_id: f.appId, user_id: f.uid, reason: 'admin_revoked' },
                f.clock,
              )
            : api.revokeSessionsByDevice(
                trx,
                { app_id: f.appId, device_id: f.deviceId, reason: 'admin_revoked' },
                f.clock,
              ),
        );
      expect(again).toEqual([]);
      for (const sid of expected) expect((await f.session(sid)).revoke_reason).toBe(reason);
    });
  }

  it(`[AC-ACC-05][BR-ID-07] 按${target}吊销限定app_id，错误app不影响任何会话`, async () => {
    const f = await fixture(suite);
    const api = await identityExports();
    const before = await f.session();
    const returned = await f.db
      .transaction()
      .execute((trx) =>
        target === 'user'
          ? api.revokeSessionsByUser(
              trx,
              { app_id: `${f.appId}_other`, user_id: f.uid, reason: 'admin_revoked' },
              f.clock,
            )
          : api.revokeSessionsByDevice(
              trx,
              { app_id: `${f.appId}_other`, device_id: f.deviceId, reason: 'device_revoked' },
              f.clock,
            ),
      );
    expect(returned).toEqual([]);
    expect(await f.session()).toEqual(before);
  });

  for (const failure of ['caller', 'hook'] as const) {
    it(`[AC-ACC-05][BR-ID-06/07] 按${target}吊销与${failure}失败同事务回滚`, async () => {
      const f = await fixture(suite);
      const api = await identityExports();
      const before = await f.session();
      const abort = new Error('fixture abort');
      await expect(
        f.db.transaction().execute(async (trx) => {
          const hook = async (same: typeof trx) => {
            expect(same).toBe(trx);
            if (failure === 'hook') throw abort;
          };
          if (target === 'user')
            await api.revokeSessionsByUser(
              trx,
              { app_id: f.appId, user_id: f.uid, reason: 'phone_changed' },
              f.clock,
              hook,
            );
          else
            await api.revokeSessionsByDevice(
              trx,
              { app_id: f.appId, device_id: f.deviceId, reason: 'device_revoked' },
              f.clock,
              hook,
            );
          throw abort;
        }),
      ).rejects.toBe(abort);
      expect(await f.session()).toEqual(before);
    });
  }
}

it('[AC-S1-171#3] 复用吊销的解绑钩子可读本事务吊销结果，钩子失败使吊销回滚', async () => {
  const f = await fixture(suite);
  success(await f.refresh());
  f.clock.advanceMs(31_000);
  const before = await f.session();
  const seen: string[][] = [];
  expect(
    await f.refresh(
      {},
      {
        afterRevoked: async (trx, sids) => {
          expect(trx.isTransaction).toBe(true);
          expect(sids).toEqual([f.initial.sid]);
          const row = await trx
            .selectFrom('sessions')
            .selectAll()
            .where('app_id', '=', f.appId)
            .where('sid', '=', f.initial.sid)
            .executeTakeFirstOrThrow();
          expect(row).toMatchObject({ revoked_at: f.clock.now(), revoke_reason: 'refresh_reuse' });
          seen.push([...sids]);
          throw new Error('fixture unbind failed');
        },
      },
    ),
  ).toEqual({ code: 50001 });
  expect(seen).toEqual([[f.initial.sid]]);
  expect(await f.session()).toEqual(before);
  expect(await f.refresh()).toEqual({ code: 10404 });
  expect((await f.session()).revoked_at).toEqual(f.clock.now());
});
