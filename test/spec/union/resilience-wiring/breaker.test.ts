import { expect, it } from 'vitest';
import { expectFault, expectOpen, fastPolicy, fault, registry, rig, success, trip } from './kit.ts';

it.each(['timeout', 'rate_limited', 'server_error', 'connection_reset'] as const)(
  '[AC-B1-14d#4] QA-05a %s 达到覆盖阈值后抛可识别 circuit_open，既不发请求也不取配额',
  async (scenario) => {
    const r = rig(registry(), fault(scenario));
    await trip(r, scenario);
    expect(r.transport).toHaveBeenCalledTimes(2);
    expect(r.take.mock.calls).toEqual([['online'], ['online']]);
    await r.advance(fastPolicy.breaker.openMs - 1);
    const blocked = r.search();
    await r.advance(0);
    expectOpen(blocked);
    expect(r.transport).toHaveBeenCalledTimes(2);
    expect(r.take).toHaveBeenCalledTimes(2);
  },
);

it('[AC-B1-14d#5] 覆盖 windowMs：恰好过期的失败不计入新窗口，当前窗口达到 minRequests 才打开', async () => {
  const r = rig(registry(), fault('server_error'));
  const first = r.search();
  await r.advance(0);
  expectFault(first, 'server_error');
  await r.advance(fastPolicy.breaker.windowMs);
  const second = r.search();
  await r.advance(0);
  expectFault(second, 'server_error');
  const third = r.search();
  await r.advance(0);
  expectFault(third, 'server_error');
  const blocked = r.search();
  await r.advance(0);
  expectOpen(blocked);
  expect(r.calledAt).toEqual([0, 600, 600]);
  expect(r.take).toHaveBeenCalledTimes(3);
});

it('[AC-B1-14d#6] 整份 breaker 生效：75% 边界不打开，超过 75% 后拒绝下一次调用', async () => {
  const r = rig(registry({ breaker: { minRequests: 4, failureRatePercent: 75 } }), success());
  const ok = r.search();
  await r.advance(0);
  expect(ok.settled).toBe('resolved');
  r.upstream.reply = fault('server_error');
  for (let i = 0; i < 4; i += 1) {
    const failed = r.search();
    await r.advance(0);
    expectFault(failed, 'server_error');
  }
  const blocked = r.search();
  await r.advance(0);
  expectOpen(blocked);
  expect(r.transport).toHaveBeenCalledTimes(5);
  expect(r.take).toHaveBeenCalledTimes(5);
});
