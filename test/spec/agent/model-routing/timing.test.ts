// 时限与取消：BR-AI-14 细则「无模型降级」触发条件——本 run 内等待模型累计超过 agent.model_timeout_ms 即降级
// （取值见 08，这里只用注入的总量）；单次尝试时限 attemptTimeoutMs 为代理自定的实现值（02 §14 千问行：超时切备用）；
// 02 §9.2 取消与断线：服务端中止模型调用。时间只走手动 Scheduler；先断言调用与 signal，再推进时间。
import { expect, it } from 'vitest';
import { createRunModelClock } from '../../../../apps/api/src/modules/agent/model-gateway/routing/index.ts';
import {
  chatInput,
  ctx,
  FakeRunClock,
  fail,
  flush,
  FLASH,
  observe,
  ok,
  PLUS,
  resolved,
  setup,
} from './kit.ts';

it.each([3000, 1200])(
  '[02 §14 千问行 超时切备用] attemptTimeoutMs=%i：主模型挂起，到时限时传输收到的 signal 已中止，随即调备用并返回备用结果',
  async (limit) => {
    const rig = setup({
      attemptTimeoutMs: limit,
      steps: { [FLASH]: [{ t: 'hang' }], [PLUS]: [ok(7, 8)] },
    });
    const run = observe(rig.router().complete(chatInput(), ctx(60_000)));
    await flush();
    expect(rig.transport.calls.map((c) => c.model)).toEqual([FLASH]);
    expect(rig.transport.signals[0]?.aborted).toBe(false);
    await rig.scheduler.advance(limit - 1);
    expect(rig.transport.signals[0]?.aborted).toBe(false);
    expect(rig.transport.calls).toHaveLength(1);
    await rig.scheduler.advance(1);
    expect(rig.transport.signals[0]?.aborted).toBe(true);
    expect(rig.transport.calls.map((c) => c.model)).toEqual([FLASH, PLUS]);
    expect(run.settled).toBe('resolved');
    expect(run.value).toMatchObject({
      kind: 'model',
      entryId: 'plus',
      attempts: [
        { entryId: 'flash', result: 'timeout', elapsedMs: limit },
        { entryId: 'plus', result: 'ok', elapsedMs: 0 },
      ],
    });
  },
);

it.each([
  { total: 8000, used: 7000, limit: 3000 },
  { total: 5000, used: 4500, limit: 1000 },
])(
  '[BR-AI-14 累计时限] 总量 $total 已用 $used：单次时限取 min($limit, 剩余)；剩余耗尽后不再调备用，degraded(model_timeout)',
  async ({ total, used, limit }) => {
    const rig = setup({
      attemptTimeoutMs: limit,
      steps: { [FLASH]: [{ t: 'hang' }], [PLUS]: [ok(1, 1)] },
    });
    const clock = new FakeRunClock(total);
    clock.charge(used);
    const remaining = total - used;
    const run = observe(
      rig.router().complete(chatInput(), { clock, signal: new AbortController().signal }),
    );
    await flush();
    expect(rig.transport.calls).toHaveLength(1);
    await rig.scheduler.advance(remaining - 1);
    expect(rig.transport.signals[0]?.aborted).toBe(false);
    await rig.scheduler.advance(1);
    expect(rig.transport.signals[0]?.aborted).toBe(true);
    expect(run.settled).toBe('resolved');
    expect(run.value).toMatchObject({ kind: 'degraded', reason: 'model_timeout' });
    expect(rig.transport.callsFor(PLUS)).toBe(0);
    expect(clock.remainingMs()).toBe(0);
  },
);

it('[BR-AI-14 累计时限] 主备共享同一个 RunModelClock：总量 5000、单次 3000，Flash 在 3000ms 中止，Plus 在累计 5000ms 中止并返回 model_timeout，余额为零；耗尽后再 complete 不发起调用', async () => {
  const rig = setup({
    attemptTimeoutMs: 3000,
    steps: { [FLASH]: [{ t: 'hang' }], [PLUS]: [{ t: 'hang' }] },
  });
  const router = rig.router();
  const clock = new FakeRunClock(5000);
  const signal = new AbortController().signal;
  const run = observe(router.complete(chatInput(), { clock, signal }));
  await flush();
  expect(rig.transport.calls.map((c) => c.model)).toEqual([FLASH]);
  expect(rig.transport.signals[0]?.aborted).toBe(false);
  await rig.scheduler.advance(2999);
  expect(rig.transport.signals[0]?.aborted).toBe(false);
  await rig.scheduler.advance(1);
  expect(rig.transport.signals[0]?.aborted).toBe(true);
  expect(rig.transport.calls.map((c) => c.model)).toEqual([FLASH, PLUS]);
  expect(rig.transport.signals[1]?.aborted).toBe(false);
  await rig.scheduler.advance(1999);
  expect(rig.transport.signals[1]?.aborted).toBe(false);
  expect(run.settled).toBe('pending');
  await rig.scheduler.advance(1);
  expect(rig.transport.signals[1]?.aborted).toBe(true);
  expect(run.settled).toBe('resolved');
  expect(run.value).toMatchObject({ kind: 'degraded', reason: 'model_timeout' });
  expect(clock.remainingMs()).toBe(0);
  const again = observe(router.complete(chatInput(), { clock, signal }));
  await flush();
  expect(rig.transport.calls).toHaveLength(2);
  expect(again.settled).toBe('resolved');
  expect(again.value).toEqual({ kind: 'degraded', reason: 'model_timeout', attempts: [] });
});

it.each(['server', 'rate_limited', 'network'] as const)(
  '[BR-AI-14 累计时限] 主模型等 2000ms 后 %s 失败：失败耗时也记账，备用只得到剩余 2000ms（总量 8000、已用 4000、单次 3000），到点 model_timeout、余额 0',
  async (kind) => {
    const rig = setup({
      attemptTimeoutMs: 3000,
      steps: { [FLASH]: [fail(kind, undefined, 2000)], [PLUS]: [{ t: 'hang' }] },
    });
    const clock = new FakeRunClock(8000);
    clock.charge(4000);
    const run = observe(
      rig.router().complete(chatInput(), { clock, signal: new AbortController().signal }),
    );
    await flush();
    expect(rig.transport.calls.map((c) => c.model)).toEqual([FLASH]);
    await rig.scheduler.advance(1999);
    expect(rig.transport.calls).toHaveLength(1);
    await rig.scheduler.advance(1);
    expect(rig.transport.calls.map((c) => c.model)).toEqual([FLASH, PLUS]);
    expect(rig.transport.signals[1]?.aborted).toBe(false);
    await rig.scheduler.advance(1999);
    expect(rig.transport.signals[1]?.aborted).toBe(false);
    expect(run.settled).toBe('pending');
    await rig.scheduler.advance(1);
    expect(rig.transport.signals[1]?.aborted).toBe(true);
    expect(run.settled).toBe('resolved');
    expect(run.value).toMatchObject({
      kind: 'degraded',
      reason: 'model_timeout',
      attempts: [
        { entryId: 'flash', result: kind, elapsedMs: 2000 },
        { entryId: 'plus', result: 'timeout', elapsedMs: 2000 },
      ],
    });
    expect(clock.remainingMs()).toBe(0);
  },
);

it.each(['server', 'rate_limited', 'network'] as const)(
  '[BR-AI-14 累计时限] 主备都等 1000ms 后 %s 失败：两次失败耗时都记到本 run 的累计时限上，degraded(models_failed)',
  async (kind) => {
    const rig = setup({
      steps: { [FLASH]: [fail(kind, undefined, 1000)], [PLUS]: [fail(kind, undefined, 1000)] },
    });
    const clock = new FakeRunClock(8000);
    const run = observe(
      rig.router().complete(chatInput(), { clock, signal: new AbortController().signal }),
    );
    await flush();
    expect(rig.transport.calls).toHaveLength(1);
    await rig.scheduler.advance(1000);
    expect(rig.transport.calls).toHaveLength(2);
    await rig.scheduler.advance(1000);
    expect(run.settled).toBe('resolved');
    expect(run.value).toEqual({
      kind: 'degraded',
      reason: 'models_failed',
      attempts: [
        { entryId: 'flash', result: kind, elapsedMs: 1000 },
        { entryId: 'plus', result: kind, elapsedMs: 1000 },
      ],
    });
    expect(clock.remainingMs()).toBe(6000);
  },
);

it.each([0, -250])(
  '[BR-AI-14 累计时限] 剩余为 %i：直接 degraded(model_timeout)，网关与传输都不被调用',
  async (remaining) => {
    const rig = setup({ steps: { [FLASH]: [ok(1, 1)] } });
    const clock = new FakeRunClock(8000);
    clock.charge(8000 - remaining);
    const outcome = await rig
      .router()
      .complete(chatInput(), { clock, signal: new AbortController().signal });
    expect(outcome).toEqual({ kind: 'degraded', reason: 'model_timeout', attempts: [] });
    expect(rig.invokes).toEqual([]);
    expect(rig.transport.calls).toEqual([]);
  },
);

it('[BR-AI-14 累计时限] 成功尝试的等待时间（1500ms）记到本 run 的累计时限上（按 Scheduler 计）', async () => {
  const rig = setup({ steps: { [FLASH]: [ok(2, 3, 1500)] } });
  const clock = new FakeRunClock(8000);
  const run = observe(
    rig.router().complete(chatInput(), { clock, signal: new AbortController().signal }),
  );
  await flush();
  expect(rig.transport.calls).toHaveLength(1);
  await rig.scheduler.advance(1500);
  expect(run.settled).toBe('resolved');
  expect(run.value).toMatchObject({
    kind: 'model',
    attempts: [{ entryId: 'flash', result: 'ok', elapsedMs: 1500 }],
  });
  expect(clock.remainingMs()).toBe(6500);
});

it('[02 §9.2 取消与断线] 调用方 signal 在尝试中途中止：传输的 signal 随之中止，返回 aborted，不再尝试备用', async () => {
  const rig = setup({ steps: { [FLASH]: [{ t: 'hang' }], [PLUS]: [ok(1, 1)] } });
  const caller = new AbortController();
  const run = observe(rig.router().complete(chatInput(), ctx(8000, caller.signal)));
  await flush();
  expect(rig.transport.calls).toHaveLength(1);
  expect(rig.transport.signals[0]?.aborted).toBe(false);
  caller.abort();
  await flush();
  expect(rig.transport.signals[0]?.aborted).toBe(true);
  await rig.scheduler.advance(10_000);
  expect(run.settled).toBe('resolved');
  expect(run.value).toMatchObject({ kind: 'aborted' });
  expect(rig.transport.callsFor(PLUS)).toBe(0);
});

it('[02 §9.2 取消与断线] 调用前 signal 已中止：返回 aborted，不发起任何调用', async () => {
  const rig = setup({ route: () => resolved('flash', 'plus'), steps: { [FLASH]: [ok(1, 1)] } });
  const caller = new AbortController();
  caller.abort();
  const outcome = await rig.router().complete(chatInput(), ctx(8000, caller.signal));
  expect(outcome).toEqual({ kind: 'aborted', attempts: [] });
  expect(rig.transport.calls).toEqual([]);
});

it.each([8000, 5000])(
  '[BR-AI-14 累计时限] createRunModelClock(%i)：剩余 = 总量 − 已记账，可累加，耗尽后 ≤0',
  (total) => {
    const clock = createRunModelClock(total);
    expect(clock.remainingMs()).toBe(total);
    clock.charge(1200);
    clock.charge(300);
    expect(clock.remainingMs()).toBe(total - 1500);
    clock.charge(total);
    expect(clock.remainingMs()).toBeLessThanOrEqual(0);
  },
);
