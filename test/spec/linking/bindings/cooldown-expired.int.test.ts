import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { RELATION, suite } from './kit.ts';
import { client, web } from './client.ts';
import { binding, bindings, scenario, state, states } from './records.ts';
import { accepted, rejected } from './assertions.ts';

const use = suite(createTestDatabase, acquireTestRedis);

it.each([0, -1])(
  '[AC-B1-06h#9] 他人 cooldown_until=now%ims：新建本人 active，他人 released 行原样',
  async (offset) => {
    const f = use();
    const { c, accountId } = await scenario(f);
    const owner = await client(f, { appId: c.appId });
    const original = await binding(f, owner, accountId, {
      status: 'released',
      cooldown_until: new Date(f.clock.now().getTime() + offset),
    });
    const s = await state(f, c);

    await accepted(await c.post(web(s.state)));

    const rows = await bindings(f, c);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === original.id)).toEqual(original);
    expect(rows.find((row) => row.id !== original.id)).toMatchObject({
      app_id: c.appId,
      user_id: c.uid,
      platform: 'taobao',
      union_account_id: accountId,
      relation_id: RELATION,
      status: 'active',
      bound_at: f.clock.now(),
      released_at: null,
      cooldown_until: null,
      blocked_reason: null,
    });
    expect(await states(f, c)).toEqual([{ ...s, used_at: f.clock.now() }]);
    expect(f.exchange).toHaveBeenCalledOnce();
  },
);

it('[AC-B1-06h#9] 本人冷却中 R1 与 active R2 并存：再次得到 R1 回 30151，两行均不变', async () => {
  const f = use();
  const { c, accountId } = await scenario(f);
  await binding(f, c, accountId, { status: 'released' });
  await binding(f, c, accountId, { relation_id: 'synthetic-other-active-relation' });
  const before = await bindings(f, c);
  const s = await state(f, c);

  await rejected(await c.post(web(s.state)), 30151);

  expect(await bindings(f, c)).toEqual(before);
  expect(await states(f, c)).toEqual([{ ...s, used_at: f.clock.now() }]);
  expect(f.exchange).toHaveBeenCalledOnce();
});
