import { randomBytes, randomUUID } from 'node:crypto';
import { PostgresQueryCompiler } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ALPHABET, seedUser } from '../../identity/registration/kit.ts';
import {
  openSuite,
  closeSuite,
  withFixture,
  bound,
  failed,
  loginLog,
  identity,
  logs,
  NOW,
  OTHER_CODE,
  type Suite,
} from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
});

it.each(['backfill', 'register'] as const)(
  '[AC-B1-11d#31] %s 成功仅更新指定列并恰写一条完整关系日志',
  async (channel) => {
    await withFixture(suite, async (f) => {
      await bound(f, { channel });
    });
  },
);

it('[AC-B1-11d#32] 单次 bind 只采样一次 Clock，所有写入共用该时刻', async () => {
  await withFixture(suite, async (f) => {
    const before = await f.row();
    const now = vi.fn(() => {
      const value = f.clock.now();
      f.clock.advanceMs(1000);
      return value;
    });
    const result = await f.bind({}, { clock: { now } });
    expect(result).toEqual({ result: 'bound', parent_id: f.parentId, bound_at: new Date(NOW) });
    expect(now).toHaveBeenCalledTimes(1);
    expect(await f.row()).toEqual({
      ...before,
      parent_id: f.parentId,
      parent_bind_source: 'backfill',
      parent_bound_at: new Date(NOW),
      self_bind_used: true,
      updated_at: new Date(NOW),
      row_version: before.row_version + 1,
    });
    expect(await f.logs()).toEqual([
      {
        app_id: f.app,
        user_id: f.userId,
        from_parent_id: null,
        to_parent_id: f.parentId,
        source: 'backfill',
        operator: `user:${f.userId}`,
        reason: null,
        at: new Date(NOW),
      },
    ]);
  });
});

it('[AC-B1-11d#33] 外层事务提交前用户和日志均不可见，回滚时一起消失', async () => {
  await withFixture(suite, async (f) => {
    const binder = await f.binder();
    const before = await f.row();
    const rollback = new Error('fixture outer rollback');
    await expect(
      f.db.transaction().execute(async (trx) => {
        expect(await binder.bind(trx, f.command)).toMatchObject({ result: 'bound' });
        expect(await logs(trx, f.app, f.userId)).toHaveLength(1);
        expect(await f.logs()).toEqual([]);
        expect(await f.row()).toEqual(before);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await f.row()).toEqual(before);
    expect(await f.logs()).toEqual([]);
  });
});

it('[AC-B1-11d#34] 日志 INSERT 失败必须抛错，由调用方回滚用户更新', async () => {
  await withFixture(suite, async (f) => {
    const binder = await f.binder();
    const before = await f.row();
    const failure = new Error('fixture audit insert unavailable');
    const failInsert = vi.fn();
    const db = f.db.withPlugin({
      transformQuery({ node, queryId }) {
        const statement = new PostgresQueryCompiler().compileQuery(node, queryId).sql;
        if (/insert\s+into\s+(?:"?app"?\.)?"?relation_change_logs\b/i.test(statement)) {
          failInsert();
          throw failure;
        }
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    await expect(db.transaction().execute((trx) => binder.bind(trx, f.command))).rejects.toBe(
      failure,
    );
    expect(failInsert).toHaveBeenCalledTimes(1);
    expect(await f.row()).toEqual(before);
    expect(await f.logs()).toEqual([]);
  });
});

it('[AC-B1-11d#35] 两个请求均读到未绑定后争抢不同码，只能一胜且只有一条日志', async () => {
  await withFixture(suite, async (f) => {
    const other = await seedUser(f.db, f.app, {
      invite: OTHER_CODE,
      phoneHmac: randomBytes(32).toString('hex'),
    });
    let release: () => void = () => {
      throw new Error('barrier not initialized');
    };
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrivals = 0;
    const binder = await f.binder({
      async readRisk(trx, subject) {
        const state = await f.deps.readRisk(trx, subject);
        arrivals++;
        if (arrivals === 2) release();
        await ready;
        return state;
      },
    });
    const before = await f.row();
    const answers = await Promise.all(
      [f.command.invite_code, OTHER_CODE].map((invite_code) =>
        f.db.transaction().execute((trx) => binder.bind(trx, { ...f.command, invite_code })),
      ),
    );
    expect(arrivals).toBe(2);
    expect(answers.filter((a) => a.result === 'bound')).toHaveLength(1);
    expect(answers.filter((a) => a.result === 'failed')).toEqual([
      { result: 'failed', code: 30402 },
    ]);
    const winner = answers.find((a) => a.result === 'bound');
    expect(winner).toMatchObject({ result: 'bound' });
    const after = await f.row();
    expect([f.parentId, other]).toContain(after.parent_id);
    expect(winner).toMatchObject({ parent_id: after.parent_id });
    expect(after.row_version).toBe(before.row_version + 1);
    expect(await f.logs()).toEqual([
      {
        app_id: f.app,
        user_id: f.userId,
        from_parent_id: null,
        to_parent_id: after.parent_id,
        source: 'backfill',
        operator: `user:${f.userId}`,
        reason: null,
        at: new Date(NOW),
      },
    ]);
  });
});

it('[AC-B1-11d#36] 已成功后再次调用不改关系、不增加日志或版本', async () => {
  await withFixture(suite, async (f) => {
    await bound(f);
    const before = await f.row();
    const audit = await f.logs();
    expect(await f.bind({ invite_code: OTHER_CODE })).toEqual({ result: 'failed', code: 30402 });
    expect(await f.row()).toEqual(before);
    expect(await f.logs()).toEqual(audit);
  });
});

it.each([1000, 1001])('[AC-B1-11d#37] 从邀请人向上共 %i 层的上限边界', async (depth) => {
  await withFixture(suite, async (f) => {
    // Includes the inviter as layer one; the last new row is the root.
    const ids = Array.from({ length: depth - 1 }, () => randomUUID());
    await f.db
      .withSchema('app')
      .insertInto('users')
      .values(
        ids.map((id, index) => ({
          id,
          app_id: f.app,
          nickname: 'fixture',
          avatar: 'fixture',
          invite_code: `ZZZ${ALPHABET[Math.floor(index / 1024)]!}${ALPHABET[Math.floor(index / 32) % 32]!}${ALPHABET[index % 32]!}`,
          attr_code: `chain-${id}`,
          level: 'L1',
          register_method: 'sms',
          status: 'normal',
          phone_hmac: `chain-${id}`,
          parent_id: ids[index + 1] ?? null,
        })),
      )
      .execute();
    await f.patch({ parent_id: ids[0]! }, f.parentId);
    const start = f.lines.length;
    if (depth === 1000) {
      await bound(f);
    } else {
      await failed(f, 30403);
      const warnings = f.lines
        .slice(start)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line['level'] === 40);
      expect(warnings.length).toBeGreaterThan(0);
      const text = JSON.stringify(warnings);
      expect(text).not.toContain((await f.row()).phone_hmac);
      expect(text).not.toContain(f.command.device_id);
      expect(text).not.toContain(f.command.invite_code);
    }
  });
});

it('[AC-B1-11d#38] 非本人参与的既有环也会触达遍历上限并告警', async () => {
  await withFixture(suite, async (f) => {
    const other = await seedUser(f.db, f.app, { phoneHmac: 'fixture-cycle' });
    await f.patch({ parent_id: other }, f.parentId);
    await f.patch({ parent_id: f.parentId }, other);
    await failed(f, 30403);
    expect(f.lines.some((line) => (JSON.parse(line) as { level: number }).level === 40)).toBe(true);
  });
});

it('[AC-B1-11d#39] identity 设备只读端口：全部保留记录、app 隔离、调用方未提交行可见', async () => {
  await withFixture(suite, async (f) => {
    const reader = (await identity()).createInviteLoginDevicesReader();
    const old = 'a'.repeat(64);
    const fresh = 'b'.repeat(64);
    await loginLog(f.db, f.app, f.userId, old);
    await loginLog(f.db, f.app, f.parentId, 'c'.repeat(64));
    const otherApp = `other_${randomUUID()}`;
    const otherUser = await seedUser(f.db, otherApp);
    await loginLog(f.db, otherApp, otherUser, 'd'.repeat(64));
    const rollback = new Error('fixture reader rollback');
    await expect(
      f.db.transaction().execute(async (trx) => {
        await loginLog(trx, f.app, f.userId, fresh, new Date(NOW));
        const hashes = await reader.read(trx, { app_id: f.app, user_id: f.userId });
        expect([...new Set(hashes)].sort()).toEqual([old, fresh]);
        expect(await reader.read(trx, { app_id: otherApp, user_id: f.userId })).toEqual([]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    const hashes = await f.db.transaction().execute((trx) =>
      reader.read(trx, {
        app_id: f.app,
        user_id: f.userId,
      }),
    );
    expect([...new Set(hashes)]).toEqual([old]);
  });
});
