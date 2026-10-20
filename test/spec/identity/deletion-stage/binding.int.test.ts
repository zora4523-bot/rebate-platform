import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createLandingInviteBinder } from '../../../../apps/api/src/modules/growth/application/landing-binder.ts';
import type { InviteSubject } from '../../../../apps/api/src/modules/growth/application/invite-binder.ts';
import {
  closeSuite,
  failed,
  openSuite,
  withFixture,
  type Fixture,
  type Suite,
} from '../../growth/bind/kit.ts';
import { keys } from '../../risk/rate-limit/kit.ts';
import { cancel, identity, request } from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
});

async function ports(f: Fixture) {
  const reader = (await identity()).createDeletionStageReader({ db: f.db });
  return {
    ...f.deps,
    readDeletionStage: async (trx: Transaction<DB>, subject: InviteSubject) =>
      (await reader.read(trx, { appId: subject.app_id, userIds: [subject.user_id] })).get(
        subject.user_id,
      ) ?? 'none',
  };
}

it.each(['register', 'backfill'] as const)(
  '[AC-B1-15c#9] %s 绑定拒绝冷静期邀请人，30401 进入原频控且不写关系',
  async (channel) => {
    await withFixture(suite, async (f) => {
      const deps = await ports(f);
      await request(f.db, f.app, f.parentId, 'cooling', f.clock.now());
      for (let count = 1; count <= 5; count++) {
        expect(await failed(f, 30401, { channel }, deps)).toEqual({
          result: 'failed',
          code: 30401,
        });
        const stored = await keys(f.raw, `*${f.app}*`);
        expect(stored).toHaveLength(1);
        expect(await f.raw.call('GET', stored[0]!)).toBe(String(count));
      }
      expect(await failed(f, 42901, { channel }, deps)).toMatchObject({ code: 42901 });
    });
  },
);

it.each(['register', 'backfill'] as const)(
  '[AC-B1-15c#10] %s 同一邀请人取消冷静期后恢复绑定，阶段在 risk 之后读取',
  async (channel) => {
    await withFixture(suite, async (f) => {
      const base = await ports(f);
      const calls: string[] = [];
      const deps = {
        ...base,
        readRisk: async (trx: Transaction<DB>, subject: InviteSubject) => {
          calls.push('risk');
          return base.readRisk(trx, subject);
        },
        readDeletionStage: vi.fn(async (trx: Transaction<DB>, subject: InviteSubject) => {
          calls.push('stage');
          expect(subject).toEqual({ app_id: f.app, user_id: f.parentId });
          expect(trx.isTransaction).toBe(true);
          return base.readDeletionStage(trx, subject);
        }),
      };
      const rid = await request(f.db, f.app, f.parentId, 'cooling', f.clock.now());
      await failed(f, 30401, { channel, invite_code: 'BAD' }, deps);
      expect(calls).toEqual([]);
      await failed(f, 30401, { channel }, deps);
      expect(calls).toEqual(['risk', 'stage']);
      await cancel(f.db, rid, f.clock.now());
      expect(await f.bind({ channel }, deps)).toEqual({
        result: 'bound',
        parent_id: f.parentId,
        bound_at: f.clock.now(),
      });
      expect((await f.row()).parent_id).toBe(f.parentId);
      expect(await f.logs()).toEqual([
        expect.objectContaining({ source: channel, to_parent_id: f.parentId }),
      ]);
      expect(calls).toEqual(['risk', 'stage', 'risk', 'stage']);
    });
  },
);

it.each(['register', 'backfill'] as const)(
  '[AC-B1-15c#11] %s 省略新端口时 deleting 按 processing 拒绝，正常用户仍可绑定',
  async (channel) => {
    await withFixture(suite, async (f) => {
      await f.patch({ status: 'deleting' }, f.parentId);
      expect(await failed(f, 30401, { channel })).toEqual({ result: 'failed', code: 30401 });
      await f.patch({ status: 'normal' }, f.parentId);
      expect(await f.bind({ channel })).toMatchObject({ result: 'bound', parent_id: f.parentId });
    });
  },
);

it('[AC-B1-15c#12] landing 预检通过后同事务出现 cooling，最终绑定重新判定并拒绝', async () => {
  await withFixture(suite, async (f) => {
    const binder = createLandingInviteBinder(await ports(f));
    const before = await f.row();
    const input = {
      app_id: f.app,
      phone_hmac: before.phone_hmac!,
      client_ip: '192.0.2.73',
      invite_code: f.command.invite_code,
      attempt_key: randomUUID(),
    };
    await f.db.transaction().execute(async (trx) => {
      expect(await binder.precheck(trx, input)).toEqual({ ok: true, inviter_id: f.parentId });
      await request(trx, f.app, f.parentId, 'cooling', f.clock.now());
      expect(
        await binder.bind(trx, {
          ...input,
          user_id: f.userId,
          inviter_id: f.parentId,
        }),
      ).toEqual({ result: 'failed', code: 30401 });
    });
    expect(await f.row()).toEqual(before);
    expect(await f.logs()).toEqual([]);
  });
});
