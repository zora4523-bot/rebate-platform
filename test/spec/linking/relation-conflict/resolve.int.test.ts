import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { suite } from '../bindings/kit.ts';
import { client, web } from '../bindings/client.ts';
import { binding, bindings, scenario, state } from '../bindings/records.ts';
import { accepted } from '../bindings/assertions.ts';
import { conflict, conflicts, mirrorTenant, newAccount, TIMEOUT } from './records.ts';

const use = suite(createTestDatabase, acquireTestRedis);

it.each(['new', 'invalid', 'cooling', 'cooldown_elapsed'] as const)(
  '[AC-B1-06z#3] 淘宝 %s 成为 active：解决该用户该平台所有账号的冲突，历史与其他范围不动',
  async (path) => {
    const f = use();
    const { c, accountId } = await scenario(f);
    const now = f.clock.now();
    const old = new Date(now.getTime() - 60_000);
    const subject = { appId: c.appId, userId: c.uid, platform: 'taobao', accountId };
    const original =
      path === 'new'
        ? undefined
        : await binding(f, c, accountId, {
            status: path === 'invalid' ? 'invalid' : 'released',
            ...(path === 'cooldown_elapsed' ? { cooldown_until: old } : {}),
          });
    const target = [];
    for (const kind of ['occupied', 'cooling', 'rebind']) {
      target.push(await conflict(f.db, subject, old, { kind }));
    }
    const secondAccount = await newAccount(f.db, c.appId, 'taobao', now);
    target.push(await conflict(f.db, { ...subject, accountId: secondAccount }, old));
    const historical = await conflict(f.db, subject, old, {
      resolved_at: old,
      resolution: 'already_active',
    });
    const historicalBound = await conflict(f.db, subject, old, {
      resolved_at: old,
      resolution: 'bound_active',
    });
    const other = await client(f, { appId: c.appId });
    const otherUser = await conflict(f.db, { ...subject, userId: other.uid }, old);
    const pddAccount = await newAccount(f.db, c.appId, 'pdd', now);
    const otherPlatform = await conflict(
      f.db,
      {
        ...subject,
        platform: 'pdd',
        accountId: pddAccount,
      },
      old,
    );
    const mirror = await mirrorTenant(f.db, subject, now);
    await conflict(f.db, mirror, old);
    const mirrorBefore = await conflicts(f.db, mirror.appId);
    const before = await conflicts(f.db, c.appId);
    const pastOpen = await f.db
      .insertInto('link_logs')
      .values({
        app_id: c.appId,
        user_id: c.uid,
        opener_user_id: c.uid,
        platform: 'taobao',
        event: 'open',
        result_code: 0,
        no_rebate: true,
        no_rebate_reason: 'relation_conflict',
        created_at: old,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const unchangedIds = [historical.id, historicalBound.id, otherUser.id, otherPlatform.id];
    const s = await state(f, c);
    await accepted(await c.post(web(s.state)));
    const rows = await conflicts(f.db, c.appId);
    for (const row of target) {
      expect(rows.find((value) => value.id === row.id)).toMatchObject({
        ...row,
        resolved_at: now,
        resolution: 'bound_active',
      });
    }
    expect(rows.filter((row) => unchangedIds.includes(row.id))).toEqual(
      before.filter((row) => unchangedIds.includes(row.id)),
    );
    expect(await conflicts(f.db, mirror.appId)).toEqual(mirrorBefore);
    expect(
      await f.db.selectFrom('link_logs').selectAll().where('app_id', '=', c.appId).execute(),
    ).toEqual([pastOpen]);
    const stored = await bindings(f, c);
    const active = stored.filter((row) => row.user_id === c.uid && row.status === 'active');
    expect(active).toHaveLength(1);
    if (path === 'invalid' || path === 'cooling') {
      expect(active[0]).toMatchObject({ id: original!.id, bound_at: original!.bound_at });
    }
    if (path === 'cooldown_elapsed') {
      expect(stored.find((row) => row.id === original!.id)).toEqual(original);
      expect(active[0]!.id).not.toBe(original!.id);
    }
    // A later successful authorization must not rewrite a previously resolved timestamp.
    f.clock.advanceMs(1000);
    const next = await state(f, c);
    await accepted(await c.post(web(next.state)));
    expect(await conflicts(f.db, c.appId)).toEqual(rows);
  },
  TIMEOUT,
);
