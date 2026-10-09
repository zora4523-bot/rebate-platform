import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { IDEMPOTENCY, type Idempotency } from '../../../../apps/api/src/modules/platform/index.ts';
import { suite } from '../bindings/kit.ts';
import { client, web } from '../bindings/client.ts';
import { binding, bindings, scenario, state } from '../bindings/records.ts';
import { conflict, conflicts, TIMEOUT } from './records.ts';

const use = suite(createTestDatabase, acquireTestRedis);

it.each(['occupied', 'already_active', 'new', 'invalid', 'cooling'] as const)(
  '[AC-B1-06z#4] %s：冲突写入或解决只在业务事务内可见，响应提交失败时一起回滚',
  async (path) => {
    const f = use();
    const { c, accountId } = await scenario(f);
    const writesConflict = path === 'occupied' || path === 'already_active';
    if (path === 'occupied') {
      const owner = await client(f, { appId: c.appId });
      await binding(f, owner, accountId);
    } else if (path !== 'new') {
      await binding(f, c, accountId, {
        status: path === 'already_active' ? 'active' : path === 'invalid' ? 'invalid' : 'released',
        ...(path === 'already_active' ? { relation_id: 'synthetic-original-relation' } : {}),
      });
    }
    if (!writesConflict) {
      await conflict(
        f.db,
        { appId: c.appId, userId: c.uid, platform: 'taobao', accountId },
        new Date(f.clock.now().getTime() - 1000),
      );
    }
    const before = await conflicts(f.db, c.appId);
    const beforeBindings = await bindings(f, c);
    const idempotency = f.app.get<Idempotency>(IDEMPOTENCY);
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
      .mockImplementation((request, handler) =>
        execute(request, async (trx) => {
          const response = await handler(trx);
          const active = await trx
            .selectFrom('union_bindings')
            .select('id')
            .where('app_id', '=', c.appId)
            .where('user_id', '=', c.uid)
            .where('status', '=', 'active')
            .execute();
          observed = {
            code: response.envelope.code,
            inside: await conflicts(trx, c.appId),
            outside: await conflicts(f.db, c.appId),
            active: active.length,
          };
          // Inject failure after business writes, before the response and its key can commit.
          throw new Error('synthetic response commit failure');
        }),
      );
    const s = await state(f, c);
    try {
      const response = await c.post(web(s.state));
      expect(response.statusCode).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(observed).toMatchObject({ code: writesConflict ? 30151 : 0 });
    expect(observed!.inside).toEqual([
      expect.objectContaining({
        app_id: c.appId,
        user_id: c.uid,
        platform: 'taobao',
        union_account_id: accountId,
        resolved_at: path === 'occupied' ? null : f.clock.now(),
        resolution:
          path === 'occupied'
            ? null
            : path === 'already_active'
              ? 'already_active'
              : 'bound_active',
      }),
    ]);
    expect(observed!.outside).toEqual(before);
    expect(observed!.active).toBe(path === 'occupied' ? 0 : 1);
    expect(await conflicts(f.db, c.appId)).toEqual(before);
    expect(await bindings(f, c)).toEqual(beforeBindings);
  },
  TIMEOUT,
);
