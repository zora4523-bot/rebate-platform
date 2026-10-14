import { randomUUID } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { afterAll, expect, it, vi } from 'vitest';
import { DemoUnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { suite, type WireResponse } from '../bindings/kit.ts';
import { client } from '../bindings/client.ts';
import { account, binding, snapshot } from '../bindings/records.ts';
import { validate } from '../bindings/assertions.ts';
import { outcome } from '../open-pdd-auth/kit.ts';
import { occupyQueries } from './query-kit.ts';

// Governance captures the method during module assembly, so observe it before suite setup.
const query = vi.spyOn(DemoUnionAdapter.prototype, 'queryPddAuthority');
const use = suite(createTestDatabase, acquireTestRedis);
afterAll(() => {
  query.mockRestore();
});

it.each(['absent', 'invalid', 'pending_auth'] as const)(
  '[AC-B1-06za#8] GET bindings 查询满额时按 %s 库内投影返回 200，不调用适配器或写库',
  async (status) => {
    const f = use();
    const c = await client(f);
    const accountId = await account(f, c, 'pdd');
    if (status !== 'absent') {
      await binding(f, c, accountId, { platform: 'pdd', status, relation_id: null });
    }
    await f.db
      .insertInto('union_pids')
      .values({
        id: randomUUID(),
        app_id: c.appId,
        platform: 'pdd',
        union_account_id: accountId,
        pid: 'synthetic-limit-self-buy',
        pid_scene: 'self_buy',
        status: 'active',
        hjy_ignore_confirmed_at: f.clock.now(),
        hjy_ignore_evidence_path: 'synthetic/evidence',
        created_at: f.clock.now(),
        updated_at: f.clock.now(),
      })
      .execute();
    const before = await snapshot(f, c);
    const load = await occupyQueries(8);
    query.mockClear();
    try {
      expect(load.client.query).toHaveBeenCalledTimes(8);
      const value = await outcome(() => c.list());
      expect(value).toMatchObject({ statusCode: 200 });
      const envelope = (value as WireResponse).json<{ code: number; data: unknown }>();
      await validate(envelope, 'UnionBindingsResponse');
      expect(envelope).toMatchObject({
        code: 0,
        data: {
          items: [
            { platform: 'taobao', status: 'unbound' },
            { platform: 'pdd', status: status === 'absent' ? 'unbound' : status },
          ],
        },
      });
      expect(query).not.toHaveBeenCalled();
      expect(await snapshot(f, c)).toEqual(before);
      expect(
        await f.db.selectFrom('link_logs').selectAll().where('app_id', '=', c.appId).execute(),
      ).toEqual([]);
      expect(f.exchange).not.toHaveBeenCalled();
      await load.close();
      const next = await c.list();
      expect(next.statusCode).toBe(200);
      expect(next.json()).toMatchObject({
        code: 0,
        data: {
          items: [
            { platform: 'taobao', status: 'unbound' },
            { platform: 'pdd', status: 'active' },
          ],
        },
      });
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      await load.close();
    }
  },
  60_000,
);
