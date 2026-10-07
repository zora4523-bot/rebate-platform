// 按条目熔断：02 §14 千问行（备用 → 无模型）、02 §6.2 治理层（熔断复用 platform 的 Governor 语义：
// 窗口内至少 minRequests 次且失败率高于 failureRatePercent 即打开 openMs）。熔断参数为代理自定的实现值，
// 这里注入两组不同取值；时间只走手动 Scheduler。
import { expect, it } from 'vitest';
import type { BreakerPolicy } from '../../../../apps/api/src/modules/platform/index.ts';
import { chatInput, ctx, fail, FLASH, ok, PLUS, setup, type Step } from './kit.ts';

const policies: BreakerPolicy[] = [
  { windowMs: 60_000, minRequests: 1, failureRatePercent: 0, openMs: 5000 },
  { windowMs: 60_000, minRequests: 3, failureRatePercent: 0, openMs: 9000 },
];

it.each(policies)(
  '[02 §14 千问行 熔断] minRequests=$minRequests openMs=$openMs：主条目失败到阈值后打开，之后记 circuit_open 直接走备用；过 openMs 后恢复尝试主条目',
  async (breaker) => {
    const n = breaker.minRequests;
    const flashSteps: Step[] = [...Array.from({ length: n }, () => fail('server')), ok(4, 4)];
    const plusSteps: Step[] = Array.from({ length: n + 2 }, () => ok(5, 5));
    const rig = setup({ breaker, steps: { [FLASH]: flashSteps, [PLUS]: plusSteps } });
    const router = rig.router();

    for (let i = 1; i <= n; i += 1) {
      expect(router.breakerState('flash')).toBe('closed');
      const outcome = await router.complete(chatInput(), ctx());
      expect(outcome.kind === 'model' && outcome.entryId).toBe('plus');
    }
    expect(rig.transport.callsFor(FLASH)).toBe(n);
    expect(router.breakerState('flash')).toBe('open');
    expect(router.breakerState('plus')).toBe('closed');

    const blocked = await router.complete(chatInput(), ctx());
    expect(blocked).toMatchObject({
      kind: 'model',
      entryId: 'plus',
      attempts: [
        { entryId: 'flash', result: 'circuit_open', elapsedMs: 0 },
        { entryId: 'plus', result: 'ok', elapsedMs: 0 },
      ],
    });
    expect(rig.transport.callsFor(FLASH)).toBe(n);

    await rig.scheduler.advance(breaker.openMs - 1);
    expect(router.breakerState('flash')).toBe('open');
    await rig.scheduler.advance(1);
    expect(router.breakerState('flash')).toBe('closed');
    const recovered = await router.complete(chatInput(), ctx());
    expect(recovered.kind === 'model' && recovered.entryId).toBe('flash');
    expect(rig.transport.callsFor(FLASH)).toBe(n + 1);
  },
);

it('[02 §14 千问行 熔断] 主、备都熔断打开：不调用任何传输，degraded(models_failed)，两条都记 circuit_open', async () => {
  const breaker: BreakerPolicy = {
    windowMs: 60_000,
    minRequests: 1,
    failureRatePercent: 0,
    openMs: 5000,
  };
  const rig = setup({
    breaker,
    steps: { [FLASH]: [fail('server')], [PLUS]: [fail('rate_limited')] },
  });
  const router = rig.router();
  expect((await router.complete(chatInput(), ctx())).kind).toBe('degraded');
  expect(router.breakerState('flash')).toBe('open');
  expect(router.breakerState('plus')).toBe('open');
  const outcome = await router.complete(chatInput(), ctx());
  expect(outcome).toEqual({
    kind: 'degraded',
    reason: 'models_failed',
    attempts: [
      { entryId: 'flash', result: 'circuit_open', elapsedMs: 0 },
      { entryId: 'plus', result: 'circuit_open', elapsedMs: 0 },
    ],
  });
  expect(rig.transport.calls).toHaveLength(2);
});
