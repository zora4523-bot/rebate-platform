import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { ACCOUNT_NAME, RELATION, suite } from './kit.ts';
import { client, web } from './client.ts';
import { account, binding, bindings, scenario, state, states } from './records.ts';
import { accepted, rejected } from './assertions.ts';

const use = suite(createTestDatabase, acquireTestRedis);

it.each(['active', 'invalid', 'blocked', 'released'] as const)(
  '[AC-B1-06h#9][AC-B1-06h#15] 他人 %s 占用同一 R：30151、不泄露归属、双方原状',
  async (status) => {
    const f = use();
    const { c, accountId } = await scenario(f);
    const owner = await client(f, { appId: c.appId });
    await binding(f, owner, accountId, { status });
    const before = await bindings(f, c);
    const s = await state(f, c);
    const response = await c.post(web(s.state));
    await rejected(response, 30151);
    expect(await bindings(f, c)).toEqual(before);
    expect(await states(f, c)).toEqual([{ ...s, used_at: f.clock.now() }]);
    expect(f.exchange).toHaveBeenCalledOnce();
    for (const value of [ACCOUNT_NAME, RELATION, owner.uid])
      expect(response.payload).not.toContain(value);
  },
);

it('[AC-B1-06h#9] 本人冷却中且无其他未释放绑定：恢复原行，清空释放时刻，保留 bound_at', async () => {
  const f = use();
  const { c, accountId } = await scenario(f);
  const original = await binding(f, c, accountId, { status: 'released' });
  const s = await state(f, c);
  await accepted(await c.post(web(s.state)));
  expect(await bindings(f, c)).toEqual([
    expect.objectContaining({
      id: original.id,
      app_id: c.appId,
      user_id: c.uid,
      union_account_id: accountId,
      relation_id: RELATION,
      status: 'active',
      bound_at: original.bound_at,
      released_at: null,
      cooldown_until: null,
      blocked_reason: null,
    }),
  ]);
  expect(await states(f, c)).toEqual([{ ...s, used_at: f.clock.now() }]);
});

it.each([0, -1])(
  '[AC-B1-06h#9] 本人 cooldown_until=now%ims，旧行原样且新建 active',
  async (offset) => {
    const f = use();
    const { c, accountId } = await scenario(f);
    const original = await binding(f, c, accountId, {
      status: 'released',
      cooldown_until: new Date(f.clock.now().getTime() + offset),
    });
    const s = await state(f, c);
    await accepted(await c.post(web(s.state)));
    const rows = await bindings(f, c);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === original.id)).toEqual(original);
    expect(rows.find((row) => row.id !== original.id)).toMatchObject({
      status: 'active',
      user_id: c.uid,
      union_account_id: accountId,
      relation_id: RELATION,
      bound_at: f.clock.now(),
      released_at: null,
      cooldown_until: null,
    });
    expect(await states(f, c)).toEqual([{ ...s, used_at: f.clock.now() }]);
  },
);

it.each(['active', 'invalid'] as const)(
  '[AC-B1-06h#9] 本人 %s 换得不同 R：30151，不替换、不增行',
  async (status) => {
    const f = use();
    const { c, accountId } = await scenario(f);
    const original = await binding(f, c, accountId, {
      status,
      relation_id: 'synthetic-original-R',
    });
    const s = await state(f, c);
    await rejected(await c.post(web(s.state)), 30151);
    expect(await bindings(f, c)).toEqual([original]);
    expect(await states(f, c)).toEqual([{ ...s, used_at: f.clock.now() }]);
    expect(f.exchange).toHaveBeenCalledOnce();
  },
);

it('[AC-B1-06h#9] 本人 active 同 R：任何列都不更新，包括 updated_at 和 row_version', async () => {
  const f = use();
  const { c, accountId } = await scenario(f);
  const original = await binding(f, c, accountId, {
    updated_at: new Date(f.clock.now().getTime() - 30_000),
    row_version: 7,
  });
  const s = await state(f, c);
  await accepted(await c.post(web(s.state)));
  expect(await bindings(f, c)).toEqual([original]);
  expect(await states(f, c)).toEqual([{ ...s, used_at: f.clock.now() }]);
  expect(f.exchange).toHaveBeenCalledOnce();
});

it('[AC-B1-06h#9] 本人 invalid 同 R：恢复原行 active，bound_at 不变', async () => {
  const f = use();
  const { c, accountId } = await scenario(f);
  const original = await binding(f, c, accountId, { status: 'invalid' });
  const s = await state(f, c);
  await accepted(await c.post(web(s.state)));
  expect(await bindings(f, c)).toEqual([
    expect.objectContaining({
      id: original.id,
      status: 'active',
      relation_id: RELATION,
      union_account_id: accountId,
      bound_at: original.bound_at,
    }),
  ]);
  expect(await states(f, c)).toEqual([{ ...s, used_at: f.clock.now() }]);
});

it('[AC-B1-06h#9] 另一 app 的同 R 不构成冲突，另一 app 的行原样', async () => {
  const f = use();
  const { c, accountId } = await scenario(f);
  const other = await client(f);
  const otherAccount = await account(f, other);
  const original = await binding(f, other, otherAccount);
  const s = await state(f, c);
  await accepted(await c.post(web(s.state)));
  expect(await bindings(f, c)).toEqual([
    expect.objectContaining({
      user_id: c.uid,
      status: 'active',
      relation_id: RELATION,
      union_account_id: accountId,
    }),
  ]);
  expect(await bindings(f, other)).toEqual([original]);
  expect(await states(f, c)).toEqual([{ ...s, used_at: f.clock.now() }]);
});
