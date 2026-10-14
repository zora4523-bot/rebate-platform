import { createTestDatabase } from '@couli/db/testing';
import type { KyselyPlugin, QueryId } from 'kysely';
import { expect, it } from 'vitest';
import { createUnionBindingsWithPddQuery } from '../../../../apps/api/src/modules/linking/application/union-bindings-pdd.ts';
import { databaseFixture } from '../open-pdd-auth/database.ts';
import { conflict, conflicts, mirrorTenant, newAccount } from '../relation-conflict/records.ts';
import { fixture, listed, outcome, snapshot, TIMEOUT } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each(['absent', 'unbound', 'pending_auth', 'invalid', 'released'] as const)(
  '[AC-B1-06x#7] %s 激活解决本人 pdd 全部未解决冲突，历史与其他范围不动',
  async (status) => {
    const f = await fixture(database(), status);
    const subject = { appId: f.appId, userId: f.a.userId, platform: 'pdd', accountId: f.accountId };
    const old = f.clock.now();
    const target = [];
    for (const kind of ['occupied', 'cooling', 'rebind']) {
      target.push(await conflict(f.db, subject, old, { kind }));
    }
    f.clock.advanceMs(1_000);
    const another = await newAccount(f.db, f.appId, 'pdd', f.clock.now());
    target.push(await conflict(f.db, { ...subject, accountId: another }, old));
    for (const resolution of ['bound_active', 'already_active']) {
      await conflict(f.db, subject, old, { resolved_at: old, resolution });
    }
    await conflict(f.db, { ...subject, userId: f.b.userId }, old);
    const taobao = await newAccount(f.db, f.appId, 'taobao', f.clock.now());
    await conflict(f.db, { ...subject, platform: 'taobao', accountId: taobao }, old);
    const mirror = await mirrorTenant(f.db, subject, f.clock.now());
    await conflict(f.db, mirror, old);
    const mirrorBefore = await conflicts(f.db, mirror.appId);
    const before = await conflicts(f.db, f.appId);
    const historicalLog = await f.db
      .insertInto('link_logs')
      .values({
        app_id: f.appId,
        user_id: f.a.userId,
        opener_user_id: f.a.userId,
        platform: 'pdd',
        event: 'open',
        result_code: 0,
        no_rebate: true,
        no_rebate_reason: 'relation_conflict',
        created_at: old,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    f.clock.advanceMs(23_456);
    await listed(await f.list(), 'active');
    const rows = await conflicts(f.db, f.appId);
    expect(rows).toHaveLength(before.length);
    for (const row of target) {
      expect(rows.find((r) => r.id === row.id)).toMatchObject({
        ...row,
        resolved_at: f.clock.now(),
        resolution: 'bound_active',
      });
    }
    const targetIds = new Set(target.map((r) => r.id));
    expect(rows.filter((r) => !targetIds.has(r.id))).toEqual(
      before.filter((r) => !targetIds.has(r.id)),
    );
    expect(await conflicts(f.db, mirror.appId)).toEqual(mirrorBefore);
    expect((await snapshot(f)).logs).toEqual([historicalLog]);
    expect(await f.sessions()).toEqual([]);
    f.clock.advanceMs(1_000);
    await listed(await f.list(), 'active');
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(await conflicts(f.db, f.appId)).toEqual(rows);
  },
  TIMEOUT,
);

it.each(['absent', 'invalid'] as const)(
  '[AC-B1-06x#8] %s 解决冲突后注入故障：外部不可见且绑定与冲突一同回滚',
  async (status) => {
    const f = await fixture(database(), status);
    await conflict(
      f.db,
      { appId: f.appId, userId: f.a.userId, platform: 'pdd', accountId: f.accountId },
      f.clock.now(),
    );
    const before = await snapshot(f);
    const updates = new Set<QueryId>();
    const observations: Awaited<ReturnType<typeof snapshot>>[] = [];
    // Observe via a separate pool connection after the real UPDATE, then fail before commit.
    const fault: KyselyPlugin = {
      transformQuery({ node, queryId }) {
        if (
          node.kind === 'UpdateQueryNode' &&
          JSON.stringify(node.table).includes('union_binding_conflicts')
        )
          updates.add(queryId);
        return node;
      },
      async transformResult({ result, queryId }) {
        if (updates.delete(queryId)) {
          observations.push(await snapshot(f));
          throw new Error('synthetic conflict resolution failure');
        }
        return result;
      },
    };
    const options = { ...f.options, db: f.db.withPlugin(fault) };
    const result = await outcome(() =>
      createUnionBindingsWithPddQuery(options).list({ traceId: f.traceId }),
    );
    expect(observations.length).toBeGreaterThan(0);
    for (const outside of observations) expect(outside).toEqual(before);
    expect(await snapshot(f)).toEqual(before);
    expect(result).not.toMatchObject({
      envelope: {
        data: {
          items: [
            { platform: 'taobao', status: 'unbound' },
            { platform: 'pdd', status: 'active' },
          ],
        },
      },
    });
  },
  TIMEOUT,
);
