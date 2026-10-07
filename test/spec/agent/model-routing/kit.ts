// 规则测试共用夹具（B3-02c）。全部是合成数据：不调用任何真实模型接口、不读任何密钥。
// 时间只走手动 Scheduler（platform/http 规则测试的 ManualScheduler）与固定 Clock；不用真实计时器。
// 期望值一律由下面的函数每次新建字面量，不由被测代码产生，也不与被测代码拿到的对象共享引用。
// 网关用真实的 createVendorGateway（B3-02a 已合并）包一层记录器，传输是进程内的脚本化假传输。
import type { BreakerPolicy, Clock } from '../../../../apps/api/src/modules/platform/index.ts';
import { createVendorGateway } from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import type {
  UsageEntry,
  UsageSink,
  VendorCall,
  VendorGateway,
  VendorId,
  VendorRequest,
  VendorResponse,
  VendorTransport,
  VendorUsage,
} from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import {
  ModelProtocolError,
  type ModelErrorKind,
  type ModelEvent,
} from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import {
  createModelRouter,
  type ModelRouter,
  type ResolvedRoute,
  type RouteEntry,
  type RouterAlert,
  type RouterChatInput,
  type RunModelClock,
} from '../../../../apps/api/src/modules/agent/model-gateway/routing/index.ts';
import { ManualScheduler } from '../../platform/http/kit.ts';

export { ManualScheduler, flush, observe } from '../../platform/http/kit.ts';

/** 带日期的千问快照（合成名，符合 B3-02b 的千问快照锁定格式）。 */
export const FLASH = 'qwen-flash-2026-09-01';
export const PLUS = 'qwen-plus-2026-09-15';
/** 同为 Flash 档的另一个已评测快照（后台切换用）。 */
export const FLASH_B = 'qwen-flash-2026-10-01';

export const fixedAt = '2026-10-07T01:02:03.000Z';
export const fixedClock: Clock = { now: () => new Date(fixedAt) };

/** 不会打开的熔断参数（非熔断用例用）。 */
export function quietBreaker(): BreakerPolicy {
  return { windowMs: 10_000, minRequests: 1000, failureRatePercent: 99, openMs: 1000 };
}

export function entry(id: string, patch: Partial<RouteEntry> = {}): RouteEntry {
  return {
    id,
    vendor: 'qwen',
    tier: id === 'plus' ? 'plus' : 'flash',
    model: id === 'plus' ? PLUS : FLASH,
    evaluation: { report: `reports/synthetic-${id}.md`, signed: true },
    ...patch,
  };
}

/** 已解析好的路由（不经 resolveRoute，避免把两个被测函数绑在一起）。 */
export function resolved(...ids: string[]): ResolvedRoute {
  return { mode: 'models', attempts: ids.map((id) => entry(id)), dropped: [] };
}

export function chatInput(): RouterChatInput {
  return {
    system: '合成系统前缀',
    tools: [],
    messages: [{ role: 'user', content: '合成：找保温杯' }],
  };
}

/** 假的本 run 累计时限：remaining = total − 已记账。 */
export class FakeRunClock implements RunModelClock {
  readonly charges: number[] = [];
  private readonly total: number;
  constructor(total: number) {
    this.total = total;
  }
  remainingMs(): number {
    return this.total - this.charges.reduce((sum, ms) => sum + ms, 0);
  }
  charge(ms: number): void {
    this.charges.push(ms);
  }
}

export type Step =
  | { readonly t: 'ok'; readonly input: number; readonly output: number; readonly delayMs?: number }
  | {
      readonly t: 'fail';
      readonly kind: ModelErrorKind;
      readonly usage?: VendorUsage;
      readonly delayMs?: number;
    }
  | { readonly t: 'hang' };

export function ok(input: number, output: number, delayMs?: number): Step {
  return delayMs === undefined ? { t: 'ok', input, output } : { t: 'ok', input, output, delayMs };
}
/** delayMs：失败前先等这么久的 Scheduler 时间（不理会 signal，由测试推进时间收尾）。 */
export function fail(kind: ModelErrorKind, usage?: VendorUsage, delayMs?: number): Step {
  return {
    t: 'fail',
    kind,
    ...(usage === undefined ? {} : { usage }),
    ...(delayMs === undefined ? {} : { delayMs }),
  };
}

/** 模型返回的 OpenAI 兼容分片：一段文本 + stop 结束片（带累计 usage）。 */
function chunksFor(model: string, input: number, output: number): unknown[] {
  return [
    { choices: [{ index: 0, delta: { content: `合成回答:${model}` } }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: input, completion_tokens: output },
    },
  ];
}

/** 上面分片拼装后的事件（按 B3-02b assembleChunks 的约定手写）。 */
export function expectedEvents(model: string, input: number, output: number): ModelEvent[] {
  return [
    { t: 'text_delta', text: `合成回答:${model}` },
    { t: 'done', reason: 'stop' },
    { t: 'usage', input, output, cached: null },
  ];
}

/**
 * 按型号排脚本的假传输：每次 send 取该型号队列的下一步。没排脚本的调用照样记录，然后以普通错误失败，
 * 由调用次数断言抓住（不让多余的调用悄悄成功）。
 */
export class ScriptedTransport implements VendorTransport {
  readonly billable = true;
  readonly calls: VendorRequest[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  private readonly steps: Map<string, Step[]>;
  private readonly scheduler: ManualScheduler;
  constructor(scheduler: ManualScheduler, steps: Readonly<Record<string, readonly Step[]>>) {
    this.scheduler = scheduler;
    this.steps = new Map(Object.entries(steps).map(([model, list]) => [model, [...list]]));
  }
  callsFor(model: string): number {
    return this.calls.filter((call) => call.model === model).length;
  }
  send(request: VendorRequest, signal?: AbortSignal): Promise<VendorResponse> {
    this.calls.push(request);
    this.signals.push(signal);
    const step = this.steps.get(request.model)?.shift();
    if (step === undefined) return Promise.reject(new Error('unscripted transport call'));
    if (step.t === 'fail') {
      const error = new ModelProtocolError(step.kind, 'synthetic failure', {
        usage: step.usage ?? null,
      });
      if (step.delayMs === undefined) return Promise.reject(error);
      return this.scheduler.sleep(step.delayMs).then(() => Promise.reject(error));
    }
    if (step.t === 'hang') {
      return new Promise<VendorResponse>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            reject(new ModelProtocolError('aborted', 'synthetic abort'));
          },
          { once: true },
        );
      });
    }
    const response: VendorResponse = {
      chunks: chunksFor(request.model, step.input, step.output),
      usage: { input_tokens: step.input, output_tokens: step.output },
    };
    if (step.delayMs === undefined) return Promise.resolve(response);
    return this.scheduler.sleep(step.delayMs).then(() => response);
  }
}

export class MemorySink implements UsageSink {
  readonly entries: UsageEntry[] = [];
  record(item: UsageEntry): void {
    this.entries.push(item);
  }
}

/** 线上计量条目的期望值（每次新建）。 */
export function onlineUsage(model: string, input: number, output: number): UsageEntry {
  return {
    vendor: 'qwen',
    purpose: 'online',
    use: null,
    model,
    input_tokens: input,
    output_tokens: output,
    recorded_at: new Date(fixedAt),
  };
}

/** 网关调用记录：去掉 body 的浅拷贝。 */
export type InvokeRecord = Omit<VendorCall, 'body'>;

export function spyGateway(inner: VendorGateway): {
  gateway: VendorGateway;
  invokes: InvokeRecord[];
} {
  const invokes: InvokeRecord[] = [];
  return {
    invokes,
    gateway: {
      invoke(call, signal) {
        const rest = Object.fromEntries(Object.entries(call).filter(([key]) => key !== 'body'));
        invokes.push(rest as InvokeRecord);
        return inner.invoke(call, signal);
      },
    },
  };
}

export interface SetupOptions {
  readonly steps?: Readonly<Record<string, readonly Step[]>>;
  readonly route?: () => ResolvedRoute;
  readonly budgetExhausted?: () => boolean;
  readonly attemptTimeoutMs?: number;
  readonly breaker?: BreakerPolicy;
  readonly offlineBudgetApproved?: readonly VendorId[];
}

export interface Rig {
  readonly scheduler: ManualScheduler;
  readonly transport: ScriptedTransport;
  readonly gateway: VendorGateway;
  readonly invokes: InvokeRecord[];
  readonly onlineMeter: MemorySink;
  readonly offlineMeter: MemorySink;
  readonly alerts: RouterAlert[];
  readonly router: () => ModelRouter;
}

/** 组装网关与路由器。router() 才调用 createModelRouter，便于网关单独使用（评测端口用例）。 */
export function setup(o: SetupOptions = {}): Rig {
  const scheduler = new ManualScheduler();
  const transport = new ScriptedTransport(scheduler, o.steps ?? {});
  const onlineMeter = new MemorySink();
  const offlineMeter = new MemorySink();
  const spy = spyGateway(
    createVendorGateway({
      transport,
      clock: fixedClock,
      onlineMeter,
      offlineMeter,
      offlineBudgetApproved: o.offlineBudgetApproved ?? [],
      rewrittenSampleGrants: [],
      ownerAggregateApprovals: [],
    }),
  );
  const alerts: RouterAlert[] = [];
  const route = o.route ?? (() => resolved('flash', 'plus'));
  return {
    scheduler,
    transport,
    gateway: spy.gateway,
    invokes: spy.invokes,
    onlineMeter,
    offlineMeter,
    alerts,
    router: () =>
      createModelRouter({
        gateway: spy.gateway,
        route,
        budgetExhausted: o.budgetExhausted ?? (() => false),
        config: {
          attemptTimeoutMs: o.attemptTimeoutMs ?? 3000,
          breaker: o.breaker ?? quietBreaker(),
        },
        scheduler,
        meter: onlineMeter,
        clock: fixedClock,
        onAlert: (alert) => {
          alerts.push(alert);
        },
      }),
  };
}

export function ctx(total = 8000, signal: AbortSignal = new AbortController().signal) {
  return { clock: new FakeRunClock(total), signal };
}
