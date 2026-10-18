import { expect, it, vi } from 'vitest';
import * as redisModule from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { createRiskStateService } from '../../../../apps/api/src/modules/risk/index.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import { setup, body, binding, rejected, gateRequest } from './kit.ts';
import { observeRedis, serviceOptions, userSessions } from './service-kit.ts';
const h = useHarness();

it('[AC-F1-07d#34] 仅风控写戳故障时 HTTP 50001，鉴权正常且状态、会话、绑定、审计全部回滚', async () => {
  const original = redisModule.createRedisHandle;
  const failing = new Set<string>();
  const failures = vi.fn();
  // Fail only the namespace discovered through the risk reader. Admin sessions and totp remain real.
  const spy = vi
    .spyOn(redisModule, 'createRedisHandle')
    .mockImplementation(
      async (...args: Parameters<typeof original>): Promise<redisModule.RedisHandle | null> => {
        const real = await original(...args);
        if (real === null) return null;
        return {
          ...real,
          namespace(name) {
            const ns = real.namespace(name);
            return {
              ...ns,
              async eval(script, options) {
                if (failing.has(name)) {
                  failures(name);
                  throw new Error('synthetic-risk-stamp-unavailable');
                }
                return ns.eval(script, options);
              },
              async set(key, value, ttl) {
                if (failing.has(name)) {
                  failures(name);
                  throw new Error('synthetic-risk-stamp-unavailable');
                }
                return ns.set(key, value, ttl);
              },
            };
          },
        };
      },
    );
  try {
    const s = await setup(h);
    await binding(s);
    await userSessions(s);
    const deps = serviceOptions(s);
    const observed = observeRedis(deps.redis!);
    await createRiskStateService({ ...deps, redis: observed.redis }).checkRequest(gateRequest(s));
    expect(observed.writes).toHaveBeenCalled();
    for (const [name] of observed.writes.mock.calls) failing.add(name);
    const before = await s.snapshot();
    await rejected(await s.put(body('ban')), 50001);
    expect(failures).toHaveBeenCalled();
    expect(await s.snapshot()).toEqual(before);
  } finally {
    spy.mockRestore();
  }
});
