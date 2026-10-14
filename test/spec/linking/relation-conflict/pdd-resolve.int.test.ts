import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { databaseFixture } from '../open-pdd-auth/database.ts';
import { fixture, outcome, service } from '../open-pdd-auth/kit.ts';
import { response, success } from '../open-pdd-auth/assertions.ts';
import { conflict, conflicts, mirrorTenant, newAccount } from './records.ts';

const database = databaseFixture(createTestDatabase);

it.each(['absent', 'invalid'] as const)(
  '[AC-B1-06z#13] 拼多多 %s：未授权不解决，授权置 active 同事务解决全部冲突，失败回滚且隔离其他范围',
  async (binding) => {
    const db = database();
    const f = await fixture(db, { binding, query: true });
    f.opener('a');
    const now = f.clock.now();
    const old = new Date(now.getTime() - 60_000);
    const subject = {
      appId: f.appId,
      userId: f.a.userId,
      platform: 'pdd',
      accountId: f.accountId,
    };
    const targets = [];
    for (const kind of ['occupied', 'cooling', 'rebind']) {
      targets.push(await conflict(db, subject, old, { kind }));
    }
    const otherAccount = await newAccount(db, f.appId, 'pdd', now);
    targets.push(await conflict(db, { ...subject, accountId: otherAccount }, old));
    const alreadyActive = await conflict(db, subject, old, {
      resolved_at: old,
      resolution: 'already_active',
    });
    const previouslyBound = await conflict(db, subject, old, {
      resolved_at: old,
      resolution: 'bound_active',
    });
    const otherUser = await conflict(db, { ...subject, userId: f.b.userId }, old);
    const taobaoAccount = await newAccount(db, f.appId, 'taobao', now);
    const otherPlatform = await conflict(
      db,
      { ...subject, platform: 'taobao', accountId: taobaoAccount },
      old,
    );
    const mirror = await mirrorTenant(db, subject, now);
    await conflict(db, mirror, old);
    const mirrorBefore = await conflicts(db, mirror.appId);
    const before = await conflicts(db, f.appId);
    const bindingsBefore = await f.bindings();
    const unchangedIds = [alreadyActive.id, previouslyBound.id, otherUser.id, otherPlatform.id];
    const open = service(f);
    const request = () => f.request({ client: 'ios', noRebate: false });

    // Negative control in each activation case: a 30111 must leave every conflict untouched.
    f.query.mockResolvedValueOnce({ authorized: false });
    const refused = await outcome(() => open.open(request()));
    await response(refused, 30111, 422);
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.bindings()).toEqual(bindingsBefore);
    expect(await conflicts(db, f.appId)).toEqual(before);
    expect(await conflicts(db, mirror.appId)).toEqual(mirrorBefore);

    // Price recheck fails after authorization writes, causing the real open transaction to roll back.
    // Observe through its executor and a separate reader before that rollback, without timing races.
    f.query.mockResolvedValue({ authorized: true });
    f.fetch.mockRejectedValueOnce(new Error('synthetic price recheck failure'));
    const idempotency = f.options.idempotency;
    const execute = idempotency.executeInTransaction.bind(idempotency);
    let observed:
      | {
          code: number;
          inside: Awaited<ReturnType<typeof conflicts>>;
          outside: Awaited<ReturnType<typeof conflicts>>;
          active: number;
        }
      | undefined;
    const spy = vi
      .spyOn(idempotency, 'executeInTransaction')
      .mockImplementationOnce((input, handler) =>
        execute(input, async (trx) => {
          const result = await handler(trx);
          const active = await trx
            .selectFrom('union_bindings')
            .select('id')
            .where('app_id', '=', f.appId)
            .where('user_id', '=', f.a.userId)
            .where('platform', '=', 'pdd')
            .where('status', '=', 'active')
            .execute();
          observed = {
            code: result.envelope.code,
            inside: await conflicts(trx, f.appId),
            outside: await conflicts(db, f.appId),
            active: active.length,
          };
          return result;
        }),
      );
    try {
      const failed = await outcome(() => open.open(request()));
      await response(failed, 50303, 503);
    } finally {
      spy.mockRestore();
    }
    expect(observed).toMatchObject({ code: 50303, active: 1, outside: before });
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.convert).not.toHaveBeenCalled();
    expect(await f.bindings()).toEqual(bindingsBefore);
    expect(await conflicts(db, f.appId)).toEqual(before);
    expect(await conflicts(db, mirror.appId)).toEqual(mirrorBefore);

    // Advance the injected clock beyond the failed price conclusion's single-flight window.
    f.clock.advanceMs(4_000);
    const resolvedAt = f.clock.now();
    const opened = await outcome(() => open.open(request()));
    await success(opened);
    expect(f.query).toHaveBeenCalledTimes(3);
    expect(f.convert).toHaveBeenCalledTimes(1);
    const bindings = await f.bindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      app_id: f.appId,
      user_id: f.a.userId,
      platform: 'pdd',
      union_account_id: f.accountId,
      status: 'active',
      updated_at: resolvedAt,
    });
    if (binding === 'invalid') {
      expect(bindings[0]).toMatchObject({
        id: f.bindingId,
        row_version: bindingsBefore[0]!.row_version + 1,
      });
    } else {
      expect(bindingsBefore).toEqual([]);
    }

    const rows = await conflicts(db, f.appId);
    expect(rows).toHaveLength(before.length);
    for (const target of targets) {
      // Existing code reaches these value assertions but leaves the target rows unresolved.
      expect(rows.find((row) => row.id === target.id)).toMatchObject({
        ...target,
        resolved_at: resolvedAt,
        resolution: 'bound_active',
      });
      expect(observed!.inside.find((row) => row.id === target.id)).toMatchObject({
        ...target,
        resolved_at: now,
        resolution: 'bound_active',
      });
    }
    const unchanged = before.filter((row) => unchangedIds.includes(row.id));
    expect(rows.filter((row) => unchangedIds.includes(row.id))).toEqual(unchanged);
    expect(observed!.inside.filter((row) => unchangedIds.includes(row.id))).toEqual(unchanged);
    expect(await conflicts(db, mirror.appId)).toEqual(mirrorBefore);
  },
  60_000,
);
