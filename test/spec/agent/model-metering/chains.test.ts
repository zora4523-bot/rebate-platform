// 协议错误用量经上层层层传回时只记一次：BR-AI-14 细则「多厂商接入」（离线调用费用按厂商独立计量，线上 / 离线不混）、
// BR-AI-16（成本在调用完成时计入，只记一次）。口径见 tests-claude.md：计量只由直接持有计费传输的 VendorGateway 做，
// 时刻取网关的 Clock；路由器（createModelRouter）与评测端口（createEvalModelPort）不再补记，
// 同一个错误对象经路由器、评测端口、createPortTransport、外层网关传回时合计只记一条。
// 线上链路：路由器 → 网关 → 计费传输。B 模式评测链路：路由器 → 外层网关 → createPortTransport（billable=false）
// → 评测端口（不传 metering）→ 普通 createVendorGateway（未登记）→ 计费传输。
// 网关与路由器注入不同的 Clock 与计量去处，条目的位置与时刻能看出是谁记的。时间只走手动 Scheduler；先断言再推进。
import { expect, it } from 'vitest';
import { createVendorGateway } from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import type {
  VendorGateway,
  VendorGatewayOptions,
  VendorTransport,
} from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import {
  createPortTransport,
  ModelProtocolError,
} from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import { createModelRouter } from '../../../../apps/api/src/modules/agent/model-gateway/routing/index.ts';
import {
  createEvalModelPort,
  createMeteredVendorGateway,
  type EvalFailureMetering,
} from '../../../../apps/api/src/modules/agent/model-gateway/index.ts';
import type { Clock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  chatInput,
  ctx,
  flush,
  FLASH,
  GATEWAY_AT,
  gatewayClock,
  ManualScheduler,
  MemorySink,
  observe,
  PLUS,
  PlanTransport,
  quietBreaker,
  rejection,
  resolved,
  routerClock,
  usageEntry,
  type Plan,
} from './kit.ts';

interface Meters {
  readonly online: MemorySink;
  readonly offline: MemorySink;
}

function gatewayOver(transport: VendorTransport, meters: Meters): VendorGateway {
  return createVendorGateway({
    transport,
    clock: gatewayClock,
    onlineMeter: meters.online,
    offlineMeter: meters.offline,
    offlineBudgetApproved: [],
    rewrittenSampleGrants: [],
    ownerAggregateApprovals: [],
  });
}

function routerOver(
  gateway: VendorGateway,
  meter: MemorySink,
  scheduler: ManualScheduler,
  ids: string[] = ['flash', 'plus'],
  attemptTimeoutMs = 3000,
) {
  return createModelRouter({
    gateway,
    route: () => resolved(...ids),
    budgetExhausted: () => false,
    config: { attemptTimeoutMs, breaker: quietBreaker() },
    scheduler,
    meter,
    clock: routerClock,
  });
}

function sinks(): Meters {
  return { online: new MemorySink(), offline: new MemorySink() };
}

function all(...meters: (Meters | MemorySink)[]) {
  return meters.flatMap((m) =>
    m instanceof MemorySink ? m.entries : [...m.online.entries, ...m.offline.entries],
  );
}

function usageError(
  kind: 'server' | 'malformed' | 'aborted' | 'timeout',
  input: number,
  output: number,
) {
  return new ModelProtocolError(kind, 'synthetic failure', {
    usage: { input_tokens: input, output_tokens: output },
  });
}

it.each(['路由器与网关共用线上计量去处', '路由器另有计量去处'] as const)(
  '[BR-AI-16][BR-AI-14 计量] 线上链路（%s）：主模型带 usage 失败、备用成功——两条都由网关按网关时刻记一次，路由器不补记',
  async (wiring) => {
    const meters = sinks();
    const routerMeter = wiring === '路由器另有计量去处' ? new MemorySink() : meters.online;
    const transport = new PlanTransport(true, [
      { t: 'fail', error: usageError('server', 200, 15) },
      { t: 'ok', input: 120, output: 30 },
    ]);
    const router = routerOver(gatewayOver(transport, meters), routerMeter, new ManualScheduler());
    const outcome = await router.complete(chatInput(), ctx());
    expect(outcome.kind === 'model' && outcome.entryId).toBe('plus');
    expect(meters.online.entries).toEqual([
      usageEntry('online', 'qwen', null, FLASH, 200, 15, GATEWAY_AT),
      usageEntry('online', 'qwen', null, PLUS, 120, 30, GATEWAY_AT),
    ]);
    expect(routerMeter === meters.online ? [] : routerMeter.entries).toEqual([]);
    expect(meters.offline.entries).toEqual([]);
  },
);

it('[BR-AI-14 计量] 路由器下的网关是 billable=false 传输（未声明 billable、未登记）：带 usage 的失败一条也不记', async () => {
  const meters = sinks();
  const routerMeter = new MemorySink();
  const transport = new PlanTransport(false, [
    { t: 'fail', error: usageError('malformed', 64, 9) },
    { t: 'fail', error: usageError('server', 70, 1) },
  ]);
  const router = routerOver(gatewayOver(transport, meters), routerMeter, new ManualScheduler());
  const outcome = await router.complete(chatInput(), ctx());
  expect(outcome.kind === 'degraded' && outcome.reason).toBe('models_failed');
  expect(transport.calls).toHaveLength(2);
  expect(all(meters, routerMeter)).toEqual([]);
});

it('[BR-AI-16 只记一次] 同一个错误对象穿过两层计费网关（外层传输转调内层网关）再到路由器：合计只记一条，记在直接持有传输的内层网关', async () => {
  const inner = sinks();
  const outer = sinks();
  const routerMeter = new MemorySink();
  const error = usageError('malformed', 33, 4);
  const innerGateway = gatewayOver(new PlanTransport(true, [{ t: 'fail', error }]), inner);
  const relay: VendorTransport = {
    billable: true,
    send: (request, signal) =>
      innerGateway.invoke(
        { ...request, purpose: 'online', vendor: 'qwen', dataClass: 'user_input' },
        signal,
      ),
  };
  const outerGateway = gatewayOver(relay, outer);
  const outcome = await routerOver(outerGateway, routerMeter, new ManualScheduler(), [
    'flash',
  ]).complete(chatInput(), ctx());
  expect(outcome.kind === 'degraded' && outcome.reason).toBe('models_failed');
  expect(inner.online.entries).toEqual([
    usageEntry('online', 'qwen', null, FLASH, 33, 4, GATEWAY_AT),
  ]);
  expect(all(inner.offline, outer, routerMeter)).toEqual([]);
});

/** B 模式评测链路：内层普通网关 + 评测端口（不传 metering）+ createPortTransport + 外层普通网关 + 路由器。 */
function evalChain(plans: readonly Plan[]) {
  const inner = sinks();
  const outer = sinks();
  const routerMeter = new MemorySink();
  const transport = new PlanTransport(true, plans);
  const port = createEvalModelPort({
    gateway: gatewayOver(transport, inner),
    vendor: 'qwen',
    model: FLASH,
    use: 'eval_compare',
    accessPath: 'bailian',
    workspace: 'ws-synthetic-eval',
  });
  const scheduler = new ManualScheduler();
  const router = routerOver(gatewayOver(createPortTransport(port), outer), routerMeter, scheduler, [
    'flash',
  ]);
  return { inner, outer, routerMeter, transport, port, router, scheduler };
}

it.each(['经路由器', '直接调评测端口'] as const)(
  '[BR-AI-14 多厂商接入 计量] B 模式评测（普通 createVendorGateway、评测端口不传 metering，%s）：付费失败的用量按离线记一条，线上一条不记',
  async (via) => {
    const chain = evalChain([{ t: 'fail', error: usageError('malformed', 64, 9) }]);
    if (via === '经路由器') {
      const outcome = await chain.router.complete(chatInput(), ctx());
      expect(outcome.kind === 'degraded' && outcome.reason).toBe('models_failed');
    } else {
      const request = {
        vendor: 'qwen',
        model: FLASH,
        messages: [{ role: 'user', content: '合成评测题' }],
        tools: [],
        params: { stream: true },
      };
      expect(await rejection(() => chain.port(request))).toBeInstanceOf(ModelProtocolError);
    }
    expect(chain.transport.calls).toHaveLength(1);
    expect(chain.inner.offline.entries).toEqual([
      usageEntry('offline', 'qwen', 'eval_compare', FLASH, 64, 9, GATEWAY_AT),
    ]);
    expect(all(chain.inner.online, chain.outer, chain.routerMeter)).toEqual([]);
  },
);

it.each(['经路由器', '直接调评测端口'] as const)(
  '[BR-AI-16 只记一次] 同一网关上两次独立的付费评测（%s），各抛出内容完全相同（厂商、型号、kind、usage）但引用不同的错误：离线恰记两条',
  async (via) => {
    const first = usageError('malformed', 64, 9);
    const second = usageError('malformed', 64, 9);
    expect(first).not.toBe(second);
    const chain = evalChain([
      { t: 'fail', error: first },
      { t: 'fail', error: second },
    ]);
    for (const expected of [first, second]) {
      if (via === '经路由器') {
        const outcome = await chain.router.complete(chatInput(), ctx());
        expect(outcome.kind === 'degraded' && outcome.reason).toBe('models_failed');
      } else {
        const request = {
          vendor: 'qwen',
          model: FLASH,
          messages: [{ role: 'user', content: '合成评测题' }],
          tools: [],
          params: { stream: true },
        };
        expect(await rejection(() => chain.port(request))).toBe(expected);
      }
    }
    expect(chain.transport.calls).toHaveLength(2);
    expect(chain.inner.offline.entries).toEqual([
      usageEntry('offline', 'qwen', 'eval_compare', FLASH, 64, 9, GATEWAY_AT),
      usageEntry('offline', 'qwen', 'eval_compare', FLASH, 64, 9, GATEWAY_AT),
    ]);
    expect(all(chain.inner.online, chain.outer, chain.routerMeter)).toEqual([]);
  },
);

it('[BR-AI-14 多厂商接入 计量][回归] B 模式评测先成功后失败：两条都只记在内层离线计量，外层非计费网关与路由器不记', async () => {
  const chain = evalChain([
    { t: 'ok', input: 40, output: 6 },
    { t: 'fail', error: usageError('server', 22, 2) },
  ]);
  const first = await chain.router.complete(chatInput(), ctx());
  expect(first.kind === 'model' && first.usage).toEqual({ input_tokens: 40, output_tokens: 6 });
  const second = await chain.router.complete(chatInput(), ctx());
  expect(second.kind === 'degraded' && second.reason).toBe('models_failed');
  expect(chain.inner.offline.entries).toEqual([
    usageEntry('offline', 'qwen', 'eval_compare', FLASH, 40, 6, GATEWAY_AT),
    usageEntry('offline', 'qwen', 'eval_compare', FLASH, 22, 2, GATEWAY_AT),
  ]);
  expect(all(chain.inner.online, chain.outer, chain.routerMeter)).toEqual([]);
});

it.each(['调用方取消', '单次时限到'] as const)(
  '[BR-AI-16][02 §9.2 取消] 线上链路%s：路由器新建的中断错误不带用量、不记；传输中断后才报出的已收用量由网关记一次',
  async (how) => {
    const meters = sinks();
    const routerMeter = new MemorySink();
    const late = usageError(how === '调用方取消' ? 'aborted' : 'timeout', 18, 3);
    const transport = new PlanTransport(true, [{ t: 'onAbort', error: late }]);
    const scheduler = new ManualScheduler();
    const router = routerOver(
      gatewayOver(transport, meters),
      routerMeter,
      scheduler,
      ['flash'],
      1000,
    );
    const controller = new AbortController();
    const run = observe(router.complete(chatInput(), ctx(8000, controller.signal)));
    await flush();
    expect(transport.calls).toHaveLength(1);
    expect(transport.signals[0]?.aborted).toBe(false);
    expect(all(meters, routerMeter)).toEqual([]);
    if (how === '调用方取消') controller.abort();
    else await scheduler.advance(1000);
    await flush();
    expect(transport.signals[0]?.aborted).toBe(true);
    expect(run.settled).toBe('resolved');
    expect(run.value?.kind).toBe(how === '调用方取消' ? 'aborted' : 'degraded');
    expect(meters.online.entries).toEqual([
      usageEntry('online', 'qwen', null, FLASH, 18, 3, GATEWAY_AT),
    ]);
    expect(all(meters.offline, routerMeter)).toEqual([]);
  },
);

it('[BR-AI-16][02 §9.2 取消] B 模式评测中途取消：取消新建的错误不带用量、不记；内层上游随后带用量失败，只按离线记一次', async () => {
  const chain = evalChain([{ t: 'manual' }]);
  const controller = new AbortController();
  const run = observe(chain.router.complete(chatInput(), ctx(8000, controller.signal)));
  await flush();
  expect(chain.transport.calls).toHaveLength(1);
  expect(chain.transport.manual).toHaveLength(1);
  controller.abort();
  await flush();
  expect(run.settled).toBe('resolved');
  expect(run.value?.kind).toBe('aborted');
  expect(all(chain.inner, chain.outer, chain.routerMeter)).toEqual([]);
  chain.transport.manual[0]?.(usageError('server', 50, 6));
  await flush();
  expect(chain.inner.offline.entries).toEqual([
    usageEntry('offline', 'qwen', 'eval_compare', FLASH, 50, 6, GATEWAY_AT),
  ]);
  expect(all(chain.inner.online, chain.outer, chain.routerMeter)).toEqual([]);
});

// —— 第 3 次修改（Codex spec-test 第 2 轮 S1）：评测端口的失败计量入口打开时也只记一次 ——
// 上面的评测链路都用未登记网关且不传 metering，评测端口的 metering.billable 补记分支从未打开。
// 下面三种接口支持的付费评测接线都把它打开：a 普通付费网关 + 端口显式 metering（与网关同一离线去处、同一 Clock）；
// b 以 createMeteredVendorGateway 登记（端口不传 metering 取登记值，或显式传同值）。
// 一次 64/9 失败经端口（直调或经路由器）传回后，所有计量去处合计恰好一条；随后在同一网关上直接发一次付费评测
// 并以 11/2 失败，网关自己记第二条。网关记失败、端口仍按自己的入口补记时，第一步就会多出一条。

type EvalWiring =
  'a 普通网关+端口 metering' | 'b 登记网关、端口不传 metering' | 'b 登记网关+端口 metering';

function evalOptions(transport: VendorTransport, meters: Meters): VendorGatewayOptions {
  return {
    transport,
    clock: gatewayClock,
    onlineMeter: meters.online,
    offlineMeter: meters.offline,
    offlineBudgetApproved: [],
    rewrittenSampleGrants: [],
    ownerAggregateApprovals: [],
  };
}

function meteredEvalChain(wiring: EvalWiring, plans: readonly Plan[]) {
  const inner = sinks();
  const outer = sinks();
  const routerMeter = new MemorySink();
  const transport = new PlanTransport(true, plans);
  const registered = wiring !== 'a 普通网关+端口 metering';
  const gateway = registered
    ? createMeteredVendorGateway(evalOptions(transport, inner))
    : createVendorGateway(evalOptions(transport, inner));
  const metering: EvalFailureMetering | undefined =
    wiring === 'b 登记网关、端口不传 metering'
      ? undefined
      : { billable: true, offlineMeter: inner.offline, clock: gatewayClock };
  const port = createEvalModelPort({
    gateway,
    vendor: 'qwen',
    model: FLASH,
    use: 'eval_compare',
    accessPath: 'bailian',
    workspace: 'ws-synthetic-eval',
    ...(metering === undefined ? {} : { metering }),
  });
  const portTransport = createPortTransport(port);
  const outerGateway = registered
    ? createMeteredVendorGateway(evalOptions(portTransport, outer))
    : createVendorGateway(evalOptions(portTransport, outer));
  const router = routerOver(outerGateway, routerMeter, new ManualScheduler(), ['flash']);
  return { inner, outer, routerMeter, transport, gateway, port, router };
}

const EVAL_WIRINGS: readonly EvalWiring[] = [
  'a 普通网关+端口 metering',
  'b 登记网关、端口不传 metering',
  'b 登记网关+端口 metering',
];

it.each(
  EVAL_WIRINGS.flatMap((wiring) =>
    (['经路由器', '直接调评测端口'] as const).map((via) => [wiring, via] as const),
  ),
)(
  '[BR-AI-14 多厂商接入 计量][BR-AI-16 只记一次] 付费评测（%s，%s）：64/9 失败经端口传回，所有计量去处合计恰好一条；同一网关直调失败由网关再记一条',
  async (wiring, via) => {
    const viaPort = usageError('malformed', 64, 9);
    const direct = usageError('malformed', 11, 2);
    const chain = meteredEvalChain(wiring, [
      { t: 'fail', error: viaPort },
      { t: 'fail', error: direct },
    ]);
    if (via === '经路由器') {
      const outcome = await chain.router.complete(chatInput(), ctx());
      expect(outcome.kind === 'degraded' && outcome.reason).toBe('models_failed');
    } else {
      const request = {
        vendor: 'qwen',
        model: FLASH,
        messages: [{ role: 'user', content: '合成评测题' }],
        tools: [],
        params: { stream: true },
      };
      expect(await rejection(() => chain.port(request))).toBe(viaPort);
    }
    expect(chain.transport.calls).toHaveLength(1);
    expect(all(chain.inner, chain.outer, chain.routerMeter)).toEqual([
      {
        vendor: 'qwen',
        purpose: 'offline',
        use: 'eval_compare',
        model: 'qwen-flash-2026-09-01',
        input_tokens: 64,
        output_tokens: 9,
        recorded_at: new Date('2026-10-07T03:04:05.000Z'),
      },
    ]);
    const offlineCall = {
      purpose: 'offline',
      vendor: 'qwen',
      model: FLASH,
      use: 'eval_compare',
      accessPath: 'bailian',
      workspace: 'ws-synthetic-eval',
      dataClass: 'synthetic',
      body: { messages: [{ role: 'user', content: '合成评测题' }], stream: true },
    } as const;
    expect(await rejection(() => chain.gateway.invoke(offlineCall))).toBe(direct);
    expect(chain.transport.calls).toHaveLength(2);
    expect(chain.inner.offline.entries).toEqual([
      usageEntry('offline', 'qwen', 'eval_compare', 'qwen-flash-2026-09-01', 64, 9, GATEWAY_AT),
      usageEntry('offline', 'qwen', 'eval_compare', 'qwen-flash-2026-09-01', 11, 2, GATEWAY_AT),
    ]);
    expect(all(chain.inner.online, chain.outer, chain.routerMeter)).toEqual([]);
  },
);

// —— BR-AI-16 计量时刻取完成时刻（Codex 第 2 轮范围外 S1，顺手补）——
// 网关的 Clock 可推进：调用发出时是上海时间 2026-10-07 23:59:58，传输挂起；推进到次日 00:00:03 后才以带用量的协议错误结束。
// 条目的 recorded_at 必须是完成时刻（次日），不能是发出时刻；路由器的 Clock 固定在 ROUTER_AT，不能用它。

it.each(['直接调网关', '经路由器'] as const)(
  '[BR-AI-16 完成时刻] 线上调用（%s）跨过上海时间午夜后才以带用量的协议错误结束：网关按完成时刻记一条',
  async (via) => {
    let now = '2026-10-07T15:59:58.000Z';
    const movingClock: Clock = { now: () => new Date(now) };
    const meters = sinks();
    const routerMeter = new MemorySink();
    const transport = new PlanTransport(true, [{ t: 'manual' }]);
    const gateway = createVendorGateway({ ...evalOptions(transport, meters), clock: movingClock });
    const run = observe<unknown>(
      via === '直接调网关'
        ? gateway.invoke({
            purpose: 'online',
            vendor: 'qwen',
            model: FLASH,
            dataClass: 'user_input',
            body: { messages: [{ role: 'user', content: '合成：找保温杯' }], stream: true },
          })
        : routerOver(gateway, routerMeter, new ManualScheduler(), ['flash']).complete(
            chatInput(),
            ctx(),
          ),
    );
    await flush();
    expect(transport.manual).toHaveLength(1);
    expect(all(meters, routerMeter)).toEqual([]);
    now = '2026-10-07T16:00:03.000Z';
    transport.manual[0]?.(usageError('malformed', 64, 9));
    await flush();
    expect(run.settled).toBe(via === '直接调网关' ? 'rejected' : 'resolved');
    expect(meters.online.entries).toEqual([
      {
        vendor: 'qwen',
        purpose: 'online',
        use: null,
        model: 'qwen-flash-2026-09-01',
        input_tokens: 64,
        output_tokens: 9,
        recorded_at: new Date('2026-10-07T16:00:03.000Z'),
      },
    ]);
    expect(all(meters.offline, routerMeter)).toEqual([]);
  },
);
