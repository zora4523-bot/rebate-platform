// 非计费内层的失败用量经计费转调传出时不记账：BR-AI-14 细则「多厂商接入」（费用按厂商独立计量；
// 录制回放不产生费用，见「定之前……只做适配器开发、录制回放」）。口径（B3-02f，承接 B3-02e Claude r1 S2）：
// 同一个带合法 usage 的 Error 对象由 billable=false 的传输（录制回放）抛给内层 createVendorGateway，
// 再经 billable=true 的转调传输原样传到外层（或更外层）网关时，内层先认领这次失败（不记），
// 外层不能再把它当成真实付费调用记账：所有计量去处合计零条；错误对象原样抛出，usage 不被改写。
// 全部是合成数据与进程内假传输，Clock 固定；期望值一律新建字面量，不由被测代码推出。
import { expect, it } from 'vitest';
import { createVendorGateway } from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import type {
  VendorCall,
  VendorGateway,
  VendorRequest,
  VendorTransport,
} from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import { ModelProtocolError } from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import { createModelRouter } from '../../../../apps/api/src/modules/agent/model-gateway/routing/index.ts';
import {
  chatInput,
  ctx,
  gatewayClock,
  ManualScheduler,
  MemorySink,
  PlanTransport,
  quietBreaker,
  rejection,
  resolved,
  routerClock,
} from '../model-metering/kit.ts';

interface Meters {
  readonly online: MemorySink;
  readonly offline: MemorySink;
}

function sinks(): Meters {
  return { online: new MemorySink(), offline: new MemorySink() };
}

function all(...meters: (Meters | MemorySink)[]) {
  return meters.flatMap((m) =>
    m instanceof MemorySink ? m.entries : [...m.online.entries, ...m.offline.entries],
  );
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

/** 录制回放类失败：带合法已知用量的协议错误（每次新建）。 */
function replayError(input: number, output: number) {
  return new ModelProtocolError('malformed', 'synthetic replay failure', {
    usage: { input_tokens: input, output_tokens: output },
  });
}

type Mode = 'online' | 'offline';

/** 把转调收到的 VendorRequest 补成对下一层网关的调用（用途与上层一致）。 */
function forward(mode: Mode, request: VendorRequest): VendorCall {
  if (mode === 'online') {
    return { ...request, purpose: 'online', vendor: 'qwen', dataClass: 'user_input' };
  }
  return {
    ...request,
    purpose: 'offline',
    vendor: 'qwen',
    use: 'eval_compare',
    accessPath: 'bailian',
    workspace: 'ws-synthetic-eval',
    dataClass: 'synthetic',
  };
}

/** billable=true 的转调传输：把请求转给下一层网关，拒绝原因原样透传。 */
function relay(mode: Mode, next: VendorGateway): VendorTransport {
  return {
    billable: true,
    send: (request, signal) => next.invoke(forward(mode, request), signal),
  };
}

function topCall(mode: Mode): VendorCall {
  const body = { messages: [{ role: 'user', content: '合成：找保温杯' }], stream: true };
  if (mode === 'online') {
    return {
      purpose: 'online',
      vendor: 'qwen',
      model: 'qwen-synthetic-m1',
      dataClass: 'user_input',
      body,
    };
  }
  return {
    purpose: 'offline',
    vendor: 'qwen',
    model: 'qwen-synthetic-m1',
    use: 'eval_compare',
    accessPath: 'bailian',
    workspace: 'ws-synthetic-eval',
    dataClass: 'synthetic',
    body,
  };
}

it('[AC-B3-02f#1] 线上：回放内层（billable=false）带 usage 失败，经计费转调传到外层网关——内外层计量合计零条，错误对象原样抛出、usage 不变', async () => {
  const inner = sinks();
  const outer = sinks();
  const error = replayError(200, 15);
  const replay = new PlanTransport(false, [{ t: 'fail', error }]);
  const outerGateway = gatewayOver(relay('online', gatewayOver(replay, inner)), outer);
  expect(await rejection(() => outerGateway.invoke(topCall('online')))).toBe(error);
  expect(error.usage).toEqual({ input_tokens: 200, output_tokens: 15 });
  expect(replay.calls).toHaveLength(1);
  expect(all(inner, outer)).toEqual([]);
});

it('[AC-B3-02f#2] 离线评测：回放内层（billable=false）带 usage 失败，经计费转调传到外层网关——离线、线上计量都零条，错误对象原样抛出、usage 不变', async () => {
  const inner = sinks();
  const outer = sinks();
  const error = replayError(64, 9);
  const replay = new PlanTransport(false, [{ t: 'fail', error }]);
  const outerGateway = gatewayOver(relay('offline', gatewayOver(replay, inner)), outer);
  expect(await rejection(() => outerGateway.invoke(topCall('offline')))).toBe(error);
  expect(error.usage).toEqual({ input_tokens: 64, output_tokens: 9 });
  expect(replay.calls).toHaveLength(1);
  expect(all(inner, outer)).toEqual([]);
});

it('[AC-B3-02f#3] 线上三层转调（回放内层 → 计费转调 → 中层网关 → 计费转调 → 外层网关），三层共用同一组计量去处：合计零条，错误原样抛出', async () => {
  const meters = sinks();
  const error = replayError(33, 4);
  const replay = new PlanTransport(false, [{ t: 'fail', error }]);
  const innerGateway = gatewayOver(replay, meters);
  const middleGateway = gatewayOver(relay('online', innerGateway), meters);
  const outerGateway = gatewayOver(relay('online', middleGateway), meters);
  expect(await rejection(() => outerGateway.invoke(topCall('online')))).toBe(error);
  expect(error.usage).toEqual({ input_tokens: 33, output_tokens: 4 });
  expect(replay.calls).toHaveLength(1);
  expect(all(meters)).toEqual([]);
});

it('[AC-B3-02f#4] 离线三层转调，各层计量去处互相独立：中层与外层都不把回放失败记成付费调用，所有去处合计零条，错误原样抛出', async () => {
  const inner = sinks();
  const middle = sinks();
  const outer = sinks();
  const error = replayError(7, 1);
  const replay = new PlanTransport(false, [{ t: 'fail', error }]);
  const middleGateway = gatewayOver(relay('offline', gatewayOver(replay, inner)), middle);
  const outerGateway = gatewayOver(relay('offline', middleGateway), outer);
  expect(await rejection(() => outerGateway.invoke(topCall('offline')))).toBe(error);
  expect(error.usage).toEqual({ input_tokens: 7, output_tokens: 1 });
  expect(replay.calls).toHaveLength(1);
  expect(all(inner, middle, outer)).toEqual([]);
});

it('[AC-B3-02f#5] 线上经路由器：路由器 → 外层网关 → 计费转调 → 回放内层，回放带 usage 失败后降级；网关与路由器计量合计零条', async () => {
  const inner = sinks();
  const outer = sinks();
  const routerMeter = new MemorySink();
  const error = replayError(120, 30);
  const replay = new PlanTransport(false, [{ t: 'fail', error }]);
  const outerGateway = gatewayOver(relay('online', gatewayOver(replay, inner)), outer);
  const router = createModelRouter({
    gateway: outerGateway,
    route: () => resolved('flash'),
    budgetExhausted: () => false,
    config: { attemptTimeoutMs: 3000, breaker: quietBreaker() },
    scheduler: new ManualScheduler(),
    meter: routerMeter,
    clock: routerClock,
  });
  const outcome = await router.complete(chatInput(), ctx());
  expect(outcome.kind === 'degraded' && outcome.reason).toBe('models_failed');
  expect(error.usage).toEqual({ input_tokens: 120, output_tokens: 30 });
  expect(replay.calls).toHaveLength(1);
  expect(all(inner, outer, routerMeter)).toEqual([]);
});
