import { expect, it } from 'vitest';
import { fixture, useHarness } from '../../admin/auth/kit.ts';
import {
  createRiskStateService,
  riskStateServiceToken,
  type RiskStateService,
} from '../../../../apps/api/src/modules/risk/index.ts';
import { setup, body, accepted, gateRequest } from './kit.ts';
import { command, service, serviceOptions, observeRedis } from './service-kit.ts';
const h = useHarness();

it('[AC-F1-07d#21] admin 与 api 独立应用共用 PG/Redis，封禁后下一次第⑤关即 10006', async () => {
  const s = await setup(h);
  const api = await fixture(h, { entry: 'api' });
  const gate = api.app.get<RiskStateService>(riskStateServiceToken());
  const request = gateRequest(s);
  await expect(gate.checkRequest(request)).resolves.toBeUndefined();
  const instant = api.clock.now().toISOString();
  await accepted(await s.put(body('ban')));
  expect(api.clock.now().toISOString()).toBe(instant);
  await expect(gate.checkRequest(request)).rejects.toMatchObject({ response: { code: 10006 } });
});

it('[AC-F1-07d#22] api Redis 读取失败时当次查库，不能按旧 normal 放行', async () => {
  const s = await setup(h);
  const api = await fixture(h, { entry: 'api' });
  const gate = api.app.get<RiskStateService>(riskStateServiceToken());
  const request = gateRequest(s);
  await gate.checkRequest(request);
  await accepted(await s.put(body('ban')));
  await api.closeRedis();
  await expect(gate.checkRequest(request)).rejects.toMatchObject({ response: { code: 10006 } });
});

it('[AC-F1-07d#23] 封禁成功后版本键丢失，已有 normal 缓存必须重新读库', async () => {
  const s = await setup(h);
  const deps = serviceOptions(s);
  const observed = observeRedis(deps.redis!);
  const reader = createRiskStateService({ ...deps, redis: observed.redis });
  await reader.checkRequest(gateRequest(s));
  expect(observed.writes).toHaveBeenCalled();
  await accepted(await s.put(body('ban')));
  for (const [name, , options] of observed.writes.mock.calls) {
    await deps.redis!.namespace(name).eval("return redis.call('DEL', unpack(KEYS))", {
      keys: options.keys,
      args: [],
      ttlSeconds: 120,
    });
  }
  await expect(reader.checkRequest(gateRequest(s))).rejects.toMatchObject({
    response: { code: 10006 },
  });
});

it('[AC-F1-07d#24] 远端 pending 水位之下的旧库值不缓存，键丢失后提交也不留旧 normal', async () => {
  const s = await setup(h);
  const deps = serviceOptions(s);
  const observed = observeRedis(deps.redis!);
  const writer = createRiskStateService({ ...deps, redis: observed.redis });
  const reader = createRiskStateService({ ...deps, redis: observed.redis });
  await h.db.transaction().execute(async (trx) => {
    await writer.setRiskState(trx, {
      app_id: s.appId,
      user_id: s.userId,
      state: 'banned',
      reason: '封禁',
      reason_category: 'other',
      frozen_until: null,
      changed_by: s.a.username,
      expected_row_version: null,
    });
    expect(observed.writes).toHaveBeenCalled();
    // Another connection still sees no committed row. The remote pending version forbids caching it.
    await expect(reader.checkRequest(gateRequest(s))).resolves.toBeUndefined();
    for (const [name, , options] of observed.writes.mock.calls) {
      await deps.redis!.namespace(name).eval("return redis.call('DEL', unpack(KEYS))", {
        keys: options.keys,
        args: [],
        ttlSeconds: 120,
      });
    }
  });
  await expect(reader.checkRequest(gateRequest(s))).rejects.toMatchObject({
    response: { code: 10006 },
  });
});

it('[AC-F1-07d#25] 写戳后提交前清空 Redis 并重建旧基线，提交后的补写恢复跨进程拒绝', async () => {
  const s = await setup(h);
  const deps = serviceOptions(s);
  const observed = observeRedis(deps.redis!);
  const reader = createRiskStateService(deps);
  await reader.checkRequest(gateRequest(s));
  let interleaved = false;
  observed.writes.mockImplementation(async (name, script, options) => {
    const result = await deps.redis!.namespace(name).eval(script, options);
    if (!interleaved) {
      interleaved = true;
      await deps.redis!.namespace(name).eval("return redis.call('DEL', unpack(KEYS))", {
        keys: options.keys,
        args: [],
        ttlSeconds: 120,
      });
      expect(await s.riskRows()).toEqual([]);
      await reader.checkRequest(gateRequest(s));
    }
    return result;
  });
  const riskState = createRiskStateService({ ...deps, redis: observed.redis });
  expect(
    await service(s, { ...deps, redis: observed.redis, riskState }).apply(command(s)),
  ).toMatchObject({ state: 'banned' });
  expect(interleaved).toBe(true);
  expect(observed.writes.mock.calls.length).toBeGreaterThanOrEqual(2);
  await expect(reader.checkRequest(gateRequest(s))).rejects.toMatchObject({
    response: { code: 10006 },
  });
});

it('[AC-F1-07d#26] 迟到的旧基线不能降低 Redis 版本，缓存基线带足够 TTL', async () => {
  const s = await setup(h);
  const deps = serviceOptions(s);
  const observed = observeRedis(deps.redis!);
  const reader = createRiskStateService({ ...deps, redis: observed.redis });
  await reader.checkRequest(gateRequest(s));
  expect(observed.writes).toHaveBeenCalled();
  const [name, script, options] = observed.writes.mock.calls[0]!;
  expect(options.ttlSeconds).toBeGreaterThanOrEqual(120);
  await accepted(await s.put(body('ban')));
  const ns = deps.redis!.namespace(name);
  const before = await Promise.all(options.keys.map((key) => ns.get(key)));
  await ns.eval(script, options);
  expect(await Promise.all(options.keys.map((key) => ns.get(key)))).toEqual(before);
  await expect(reader.checkRequest(gateRequest(s))).rejects.toMatchObject({
    response: { code: 10006 },
  });
});

it('[AC-F1-07d#27] 后台未注入 Redis 必须拒绝，不能提交局部封禁', async () => {
  const s = await setup(h);
  const { redis, ...withoutRedis } = serviceOptions(s);
  expect(redis).toBeDefined();
  const before = await s.snapshot();
  // Reconstruct options explicitly so the helper cannot silently restore its default Redis.
  const { AdminRiskState } =
    await import('../../../../apps/api/src/modules/risk/application/admin-risk-state.ts');
  const sut = new AdminRiskState(withoutRedis);
  await expect(sut.apply(command(s))).rejects.toBeInstanceOf(Error);
  expect(await s.snapshot()).toEqual(before);
});

it('[AC-F1-07d#28] 版本戳写入失败必须回滚状态和事件，不能默默降级本地缓存', async () => {
  const s = await setup(h);
  const deps = serviceOptions(s);
  const observed = observeRedis(deps.redis!);
  const abort = new Error('synthetic-redis-write-failure');
  observed.writes.mockRejectedValue(abort);
  const before = await s.snapshot();
  const sut = service(s, {
    ...deps,
    redis: observed.redis,
    riskState: createRiskStateService({ ...deps, redis: observed.redis }),
  });
  await expect(sut.apply(command(s))).rejects.toBeInstanceOf(Error);
  expect(observed.writes).toHaveBeenCalled();
  expect(await s.snapshot()).toEqual(before);
});
