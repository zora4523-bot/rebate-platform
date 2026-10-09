import { randomUUID } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { RELATION, suite, type WireResponse } from './kit.ts';
import { sdk, web } from './client.ts';
import { bindings, configure, scenario, snapshot, state, states } from './records.ts';
import { accepted, rejected } from './assertions.ts';

const use = suite(createTestDatabase, acquireTestRedis);

it('[AC-B1-06h#6] 换凭证端口开始调用时，state 的 used_at 已经写入注入时钟的 now', async () => {
  const f = use();
  const { c } = await scenario(f);
  const s = await state(f, c);
  const observed: (Date | null)[] = [];
  f.exchange.mockImplementation(async () => {
    const row = await f.db
      .selectFrom('union_auth_sessions')
      .select('used_at')
      .where('state', '=', s.state)
      .executeTakeFirstOrThrow();
    observed.push(row.used_at);
    return { kind: 'bound', relationId: RELATION };
  });

  await accepted(await c.post(web(s.state)));

  expect(observed).toEqual([f.clock.now()]);
  expect(f.exchange).toHaveBeenCalledOnce();
  expect(await states(f, c)).toEqual([{ ...s, used_at: f.clock.now() }]);
});

it('[AC-B1-06h#6] 换凭证未返回时，另一并发请求已因 state 被消费而回 30104', async () => {
  const f = use();
  const { c } = await scenario(f);
  const s = await state(f, c);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.exchange.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return { kind: 'bound', relationId: RELATION };
  });
  const first = c.post(web(s.state), { key: randomUUID() });
  const requests = [first];
  // The timer only bounds a deadlock; it never decides which request wins.
  // A consume-after-exchange mutant blocks both requests at the explicit gate.
  const deadline = Promise.withResolvers<null>();
  const timer = setTimeout(() => deadline.resolve(null), 5000);
  let firstArrived = false;
  let early: WireResponse | null = null;
  try {
    firstArrived = await Promise.race([
      entered.promise.then(() => true),
      first.then(() => false),
      deadline.promise.then(() => false),
    ]);
    if (firstArrived) {
      const second = c.post(web(s.state), { key: randomUUID() });
      requests.push(second);
      early = await Promise.race([second, deadline.promise]);
    }
  } finally {
    clearTimeout(timer);
    release.resolve();
    await Promise.allSettled(requests);
  }

  expect(firstArrived, '先确保第一请求已停在换凭证闸门，再提交第二请求').toBe(true);
  expect(early, '另一请求必须在换凭证闸门打开前返回').not.toBeNull();
  await rejected(early!, 30104);
  const responses = await Promise.all(requests);
  expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 422]);
  await accepted(responses.find((response) => response.statusCode === 200)!);
  expect(f.exchange).toHaveBeenCalledOnce();
  expect(await bindings(f, c)).toEqual([
    expect.objectContaining({
      user_id: c.uid,
      status: 'active',
      relation_id: RELATION,
      bound_at: f.clock.now(),
    }),
  ]);
  expect(await states(f, c)).toEqual([{ ...s, used_at: f.clock.now() }]);
}, 20_000);

it('[AC-B1-06h#5] 设备 ios 禁用 SDK，伪报允许 SDK 的 android 仍拒绝且原 state 可用 web_code', async () => {
  const f = use();
  const { c } = await scenario(f);
  await configure(f, c, ['web_code'], 'ios');
  await configure(f, c, ['sdk_token', 'web_code'], 'android');
  const s = await state(f, c, { auth_methods: ['sdk_token', 'web_code'] });
  const before = await snapshot(f, c);

  await rejected(
    await c.post(sdk(s.state), { reportedClient: 'android' }),
    30104,
    'method_not_allowed',
  );

  expect(await snapshot(f, c)).toEqual(before);
  expect(f.exchange).not.toHaveBeenCalled();
  await accepted(await c.post(web(s.state), { reportedClient: 'android' }));
  expect(f.exchange).toHaveBeenCalledOnce();
  expect(await states(f, c)).toEqual([{ ...s, used_at: f.clock.now() }]);
});
