import { randomUUID } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { suite } from '../bindings/kit.ts';
import { client } from '../bindings/client.ts';
import { account, binding, bindings, states } from '../bindings/records.ts';
import { validate } from '../bindings/assertions.ts';
import { outcome, TIMEOUT } from './kit.ts';

const use = suite(createTestDatabase, acquireTestRedis);

it.each(['absent', 'invalid'] as const)(
  '[AC-B1-06x#11] HTTP %s：真实模块 GET 无幂等键激活 pdd，淘宝及其他用户不变',
  async (status) => {
    const f = use();
    const c = await client(f);
    const other = await client(f, { appId: c.appId });
    const accountId = await account(f, c, 'pdd');
    const taobaoId = await account(f, c, 'taobao');
    const taobao = await binding(f, c, taobaoId, { status: 'invalid' });
    const foreign = await binding(f, other, accountId, {
      platform: 'pdd',
      status: 'blocked',
      relation_id: null,
    });
    const original =
      status === 'invalid'
        ? await binding(f, c, accountId, {
            platform: 'pdd',
            status: 'invalid',
            relation_id: null,
            row_version: 4,
          })
        : null;
    await f.db
      .insertInto('union_pids')
      .values({
        id: randomUUID(),
        app_id: c.appId,
        platform: 'pdd',
        union_account_id: accountId,
        pid: 'synthetic-http-self-buy',
        pid_scene: 'self_buy',
        status: 'active',
        hjy_ignore_confirmed_at: f.clock.now(),
        hjy_ignore_evidence_path: 'synthetic/evidence',
        created_at: f.clock.now(),
        updated_at: f.clock.now(),
      })
      .execute();
    const before = await bindings(f, c);
    const guest = await c.list({ token: null });
    expect(guest.statusCode).toBe(401);
    expect(guest.json()).toMatchObject({ code: 10001 });
    expect(await bindings(f, c)).toEqual(before);

    const response = await outcome(() => c.list());
    expect(response).toMatchObject({ statusCode: 200 });
    const http = response as Awaited<ReturnType<typeof c.list>>;
    const envelope = http.json<{ code: number; data: { items: unknown[] } }>();
    await validate(envelope, 'UnionBindingsResponse');
    expect(envelope.code).toBe(0);
    expect(envelope.data).toEqual({
      items: [
        { platform: 'taobao', status: 'invalid' },
        { platform: 'pdd', status: 'active' },
      ],
    });
    const rows = await bindings(f, c);
    expect(rows.find((r) => r.id === taobao.id)).toEqual(taobao);
    expect(rows.find((r) => r.id === foreign.id)).toEqual(foreign);
    const own = rows.filter((r) => r.user_id === c.uid && r.platform === 'pdd');
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ status: 'active', union_account_id: accountId });
    if (original !== null) {
      expect(own[0]).toMatchObject({
        id: original.id,
        row_version: 5,
        bound_at: original.bound_at,
      });
    }
    const user = await f.db
      .selectFrom('users')
      .select('attr_code')
      .where('app_id', '=', c.appId)
      .where('id', '=', c.uid)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(own[0]!.pdd_custom!)).toEqual({
      app: 'n',
      uid: user.attr_code,
      sc: 'self_buy',
    });
    expect(await states(f, c)).toEqual([]);
    expect(
      await f.db.selectFrom('link_logs').selectAll().where('app_id', '=', c.appId).execute(),
    ).toEqual([]);
    expect(f.exchange).not.toHaveBeenCalled();
  },
  TIMEOUT,
);
