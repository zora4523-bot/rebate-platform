// B2-04m rule tests of settlement's BeneficiaryGate (S2 option A): users rows are locked and states
// re-read only through identity's and risk's exported ports, on the caller's transaction
// (BR-FUND-16 细则「加锁流程」steps 2 and 4; BR-CALC-13 state classes).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { NOW, TIMEOUT, databaseFixture, deferred, harness } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04m#35] readStates：注销、风控、未成年按锁后读到的库内状态映射；冷静期 / 正常为 null，冻结与申诉保留原值',
  async () => {
    const h = await harness(p.db);
    const users = {
      normal: await h.user('normal'),
      frozen: await h.user('frozen'),
      appealing: await h.user('appealing'),
      banned: await h.user('banned'),
      deleting: await h.user('deleting'),
      deleted: await h.user('deleted'),
      minor: await h.user('minor'),
      adult: await h.user('adult'),
    };
    const gate = h.gate();
    const ids = Object.values(users);
    const states = await p.db.transaction().execute(async (trx) => {
      await gate.lockUsers(trx, { appId: h.appId, userIds: ids });
      const read = await gate.readStates(trx, { appId: h.appId, userIds: ids });
      expect(h.minorRead).toHaveBeenCalledWith(
        trx,
        expect.objectContaining({ appId: h.appId, at: new Date(NOW) }),
      );
      return read;
    });
    const normal = { risk_state: 'normal', deletion_status: null, is_minor: false };
    expect(states.get(users.normal)).toEqual(normal);
    expect(states.get(users.frozen)).toEqual({ ...normal, risk_state: 'frozen' });
    expect(states.get(users.appealing)).toEqual({ ...normal, risk_state: 'appealing' });
    expect(states.get(users.banned)).toEqual({ ...normal, risk_state: 'banned' });
    expect(states.get(users.deleting)).toEqual({ ...normal, deletion_status: 'processing' });
    expect(states.get(users.deleted)).toEqual({ ...normal, deletion_status: 'done' });
    expect(states.get(users.minor)).toEqual({ ...normal, is_minor: true });
    expect(states.get(users.adult)).toEqual(normal);
    expect(states.size).toBe(ids.length);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#36] lockUsers 经 identity 端口在调用方事务里锁住 users 行：事务未结束时另一连接 FOR UPDATE NOWAIT 失败（55P03），提交后可锁',
  async () => {
    const h = await harness(p.db);
    const a = await h.user();
    const b = await h.user();
    const gate = h.gate();
    const locked = deferred();
    const finish = deferred();
    let returned: ReadonlySet<string> | undefined;
    const holder = p.left.transaction().execute(async (trx) => {
      returned = await gate.lockUsers(trx, { appId: h.appId, userIds: [b, a] });
      expect(h.identityLock).toHaveBeenCalledWith(
        trx,
        expect.objectContaining({ appId: h.appId, userIds: expect.arrayContaining([a, b]) }),
      );
      locked.resolve();
      await finish.promise;
    });
    try {
      await locked.promise;
      expect(returned).toEqual(new Set([a, b]));
      await expect(
        p.right
          .selectFrom('users')
          .select('id')
          .where('app_id', '=', h.appId)
          .where('id', '=', a)
          .forUpdate()
          .noWait()
          .execute(),
      ).rejects.toMatchObject({ code: '55P03' });
      finish.resolve();
      await holder;
    } finally {
      finish.resolve();
      await holder.catch(() => undefined);
    }
    const after = await p.right
      .selectFrom('users')
      .select('id')
      .where('app_id', '=', h.appId)
      .where('id', '=', a)
      .forUpdate()
      .noWait()
      .execute();
    expect(after).toEqual([{ id: a }]);
  },
  TIMEOUT,
);
