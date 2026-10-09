import { randomUUID } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { suite } from './kit.ts';
import { client, loginAs, sdk, web } from './client.ts';
import { binding, bindings, configure, scenario, snapshot, state, states } from './records.ts';
import { accepted, rejected } from './assertions.ts';

// AC-B1-06h numbers refer to the orchestrator's sixteen acceptance groups.
const use = suite(createTestDatabase, acquireTestRedis);

it.each(['missing', 'expires_now', 'expired', 'used'] as const)(
  '[AC-B1-06h#4] %s state 拒绝且已有绑定完全不变',
  async (kind) => {
    const f = use();
    const { c, accountId } = await scenario(f);
    await binding(f, c, accountId, { status: 'invalid' });
    const s =
      kind === 'missing'
        ? null
        : await state(f, c, {
            ...(kind === 'expires_now' ? { expire_at: f.clock.now() } : {}),
            ...(kind === 'expired' ? { expire_at: new Date(f.clock.now().getTime() - 1) } : {}),
            ...(kind === 'used' ? { used_at: new Date(f.clock.now().getTime() - 1) } : {}),
          });
    const before = await snapshot(f, c);
    await rejected(await c.post(web(s?.state ?? 'synthetic-missing-state')), 30104);
    expect(await snapshot(f, c)).toEqual(before);
    expect(f.exchange).not.toHaveBeenCalled();
  },
);

it('[AC-B1-06h#4] uid 不符只拒绝本次，state 原持有人仍能提交', async () => {
  const f = use();
  const { c, accountId } = await scenario(f);
  const owner = await client(f, { appId: c.appId });
  await binding(f, owner, accountId, { status: 'invalid' });
  // Same physical device, different uid: only the uid check fails.
  const s = await state(f, c, { user_id: owner.uid });
  const before = await snapshot(f, c);
  await rejected(await c.post(web(s.state)), 30104);
  expect(await snapshot(f, c)).toEqual(before);
  expect(f.exchange).not.toHaveBeenCalled();
  const token = await loginAs(f, c, owner.uid);
  await accepted(await c.post(web(s.state), { token }));
  expect((await states(f, c))[0]?.used_at).toEqual(f.clock.now());
});

it('[AC-B1-06h#4] 同用户另一设备不得消费，原设备随后成功', async () => {
  const f = use();
  const { c, accountId } = await scenario(f);
  const other = await client(f, { appId: c.appId, uid: c.uid });
  await binding(f, c, accountId, { status: 'invalid' });
  const s = await state(f, c);
  const before = await snapshot(f, c);
  await rejected(await other.post(web(s.state)), 30104);
  expect(await snapshot(f, c)).toEqual(before);
  expect(f.exchange).not.toHaveBeenCalled();
  await accepted(await c.post(web(s.state)));
});

it('[AC-B1-06h#5] 设备记录端不等于 state.client 时不消费', async () => {
  const f = use();
  const { c } = await scenario(f);
  const s = await state(f, c, { client: 'android' });
  const before = await snapshot(f, c);
  await rejected(
    await c.post(web(s.state), { reportedClient: 'android' }),
    30104,
    'method_not_allowed',
  );
  expect(await snapshot(f, c)).toEqual(before);
  expect(f.exchange).not.toHaveBeenCalled();
});

it.each(['not_issued', 'disabled', 'default_web_only'] as const)(
  '[AC-B1-06h#5] %s 拒绝 SDK，原 state 的 web_code 仍可成功',
  async (kind) => {
    const f = use();
    const { c } = await scenario(f);
    if (kind !== 'default_web_only') {
      await configure(f, c, kind === 'not_issued' ? ['sdk_token', 'web_code'] : ['web_code']);
    }
    const s = await state(f, c, {
      auth_methods: kind === 'not_issued' ? ['web_code'] : ['sdk_token', 'web_code'],
    });
    const before = await snapshot(f, c);
    await rejected(await c.post(sdk(s.state)), 30104, 'method_not_allowed');
    expect(await snapshot(f, c)).toEqual(before);
    expect(f.exchange).not.toHaveBeenCalled();
    await accepted(await c.post(web(s.state)));
    expect(f.exchange).toHaveBeenCalledOnce();
  },
);

it('[AC-B1-06h#5] X-Platform 只是声明，设备记录和 state 一致即可成功', async () => {
  const f = use();
  const { c } = await scenario(f);
  const s = await state(f, c);
  await accepted(await c.post(web(s.state), { reportedClient: 'android' }));
  expect(f.exchange).toHaveBeenCalledOnce();
  expect((await states(f, c))[0]?.used_at).toEqual(f.clock.now());
});

it('[AC-B1-06h#6] 同 state 不同幂等键并发：一个成功，一个无 reason 的 30104', async () => {
  const f = use();
  const { c } = await scenario(f);
  const s = await state(f, c);
  // Both launch without awaiting either. No assumption about which request wins.
  const responses = await Promise.all([
    c.post(web(s.state), { key: randomUUID() }),
    c.post(web(s.state), { key: randomUUID() }),
  ]);
  expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 422]);
  const success = responses.find((r) => r.statusCode === 200)!;
  const failure = responses.find((r) => r.statusCode === 422)!;
  await accepted(success);
  await rejected(failure, 30104);
  expect(f.exchange).toHaveBeenCalledOnce();
  expect(await bindings(f, c)).toEqual([
    expect.objectContaining({ status: 'active', user_id: c.uid }),
  ]);
  expect((await states(f, c))[0]?.used_at).toEqual(f.clock.now());
}, 20_000);
