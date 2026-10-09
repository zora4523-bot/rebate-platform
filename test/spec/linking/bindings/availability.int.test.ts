import { randomUUID } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { suite } from './kit.ts';
import { client, web } from './client.ts';
import { account, binding, bindings, scenario, snapshot, state, states } from './records.ts';
import { accepted, rejected } from './assertions.ts';

const use = suite(createTestDatabase, acquireTestRedis);

it('[AC-B1-06h#10] 正常用户的 blocked 绑定返回 30153，不消费 state 或改绑定', async () => {
  const f = use();
  const { c, accountId } = await scenario(f);
  const s = await state(f, c);
  await binding(f, c, accountId, { status: 'blocked' });
  const before = await snapshot(f, c);
  await rejected(await c.post(web(s.state)), 30153);
  expect(await snapshot(f, c)).toEqual(before);
  expect(f.exchange).not.toHaveBeenCalled();
});

it.each(['unbound', 'released', 'invalid'] as const)(
  '[AC-B1-06h#11] %s 用户所用站长账号 expired，返回 auth_unavailable',
  async (status) => {
    const f = use();
    const c = await client(f);
    const accountId = await account(f, c, 'taobao', 'expired');
    if (status !== 'unbound') await binding(f, c, accountId, { status });
    const s = await state(f, c);
    const before = await snapshot(f, c);
    const response = await c.post(web(s.state));
    await rejected(response, status === 'invalid' ? 30102 : 30101, 'auth_unavailable');
    expect(response.json<{ data: object }>().data).not.toHaveProperty('auth_url');
    expect(await snapshot(f, c)).toEqual(before);
    expect(f.exchange).not.toHaveBeenCalled();
  },
);

it.each(['expired', 'active'] as const)(
  '[AC-B1-06h#11] invalid 绑定账号 A=%s，另一账号 B 的相反状态不能替代 A',
  async (authStatus) => {
    const f = use();
    const c = await client(f);
    // B is older, so mistakenly falling back to the first platform account selects B.
    const earlier = f.clock.now();
    f.clock.set(new Date(earlier.getTime() - 1000));
    await account(f, c, 'taobao', authStatus === 'expired' ? 'active' : 'expired');
    f.clock.set(earlier);
    const accountId = await account(f, c, 'taobao', authStatus);
    const original = await binding(f, c, accountId, { status: 'invalid' });
    const s = await state(f, c);
    const before = await snapshot(f, c);
    const response = await c.post(web(s.state));
    if (authStatus === 'expired') {
      await rejected(response, 30102, 'auth_unavailable');
      expect(await snapshot(f, c)).toEqual(before);
      expect(f.exchange).not.toHaveBeenCalled();
    } else {
      await accepted(response);
      expect(await bindings(f, c)).toEqual([
        expect.objectContaining({
          id: original.id,
          union_account_id: accountId,
          status: 'active',
          bound_at: original.bound_at,
        }),
      ]);
      expect(await states(f, c)).toEqual([{ ...s, used_at: f.clock.now() }]);
      expect(f.exchange).toHaveBeenCalledOnce();
    }
  },
);

it('[AC-B1-06h#1][AC-B1-06h#11] 未绑定时选有效 self_buy 推广位的账号，非最早账号', async () => {
  const f = use();
  const c = await client(f);
  const now = f.clock.now();
  f.clock.set(new Date(now.getTime() - 1000));
  await account(f, c, 'taobao', 'expired');
  f.clock.set(now);
  const selected = await account(f, c);
  await f.db
    .insertInto('union_pids')
    .values({
      id: randomUUID(),
      app_id: c.appId,
      platform: 'taobao',
      union_account_id: selected,
      site_id: 'synthetic-site',
      pid: 'synthetic-self-buy-pid',
      pid_scene: 'self_buy',
      status: 'active',
      hjy_ignore_confirmed_at: now,
      hjy_ignore_evidence_path: 'synthetic/evidence',
      created_at: now,
      updated_at: now,
    })
    .execute();
  const s = await state(f, c);
  await accepted(await c.post(web(s.state)));
  expect(await bindings(f, c)).toEqual([expect.objectContaining({ union_account_id: selected })]);
  expect(f.exchange).toHaveBeenCalledOnce();
});
