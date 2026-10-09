import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from '../open-requote/kit.ts';
import { compose, setup } from '../open-taobao/kit.ts';
import { conflict, TIMEOUT } from './records.ts';

const database = databaseFixture(createTestDatabase);

it.each(
  (['taobao', 'pdd'] as const).flatMap((platform) =>
    (['absent', 'blocked', 'active'] as const).flatMap((status) =>
      (['auth_declined', 'auth_failed', undefined] as const).map((reason) => ({
        platform,
        status,
        reason,
      })),
    ),
  ),
)(
  '[AC-B1-06z#7] $platform / $status / $reason：未解决冲突优先，原请求不变且同键可重放',
  async ({ platform, status, reason }) => {
    const f = await setup(database(), 'detail', platform);
    await f.bind(status);
    const now = f.f.clock.now();
    const row = await conflict(
      f.db,
      {
        appId: f.appId,
        userId: f.a,
        platform,
        accountId: f.account,
      },
      now,
    );
    const open = compose(f);
    const request = f.request({
      noRebate: true,
      client: 'ios',
      ...(reason === undefined ? {} : { noRebateReason: reason }),
    });
    const originalRequest = { ...request };
    const result = await open(request);
    expect(result.envelope.code).toBe(0);
    expect(request).toEqual(originalRequest);
    const logs = await f.logs();
    expect(logs).toEqual([
      expect.objectContaining({
        app_id: f.appId,
        opener_user_id: f.a,
        platform,
        no_rebate: true,
        no_rebate_reason: 'relation_conflict',
        result_code: 0,
      }),
    ]);
    const keys = await f.db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('app_id', '=', f.appId)
      .where('key', '=', request.idempotencyKey!)
      .execute();
    expect(keys).toHaveLength(1);
    const attempts = await f.attempts();
    expect(attempts).toHaveLength(1);
    expect(await open({ ...originalRequest })).toEqual(result);
    f.f.clock.advanceMs(3001);
    await f.db
      .updateTable('union_binding_conflicts')
      .set({ resolved_at: f.f.clock.now(), resolution: 'bound_active' })
      .where('id', '=', row.id)
      .execute();
    // Even after server state changes, replay hashes the original client body.
    expect(await open({ ...originalRequest })).toEqual(result);
    expect(await f.logs()).toEqual(logs);
    expect(await f.attempts()).toEqual(attempts);
    expect(
      await f.db
        .selectFrom('idempotency_keys')
        .selectAll()
        .where('app_id', '=', f.appId)
        .where('key', '=', request.idempotencyKey!)
        .execute(),
    ).toEqual(keys);
    const next = await open(
      f.request({
        noRebate: true,
        client: 'ios',
        ...(reason === undefined ? {} : { noRebateReason: reason }),
      }),
    );
    expect(next.envelope.code).toBe(0);
    const after = await f.logs();
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(logs[0]);
    expect(after[1]).toMatchObject({
      no_rebate: true,
      no_rebate_reason: status === 'blocked' ? 'binding_blocked' : (reason ?? 'auth_declined'),
    });
  },
  TIMEOUT,
);
