// 共用夹具（B1-14b）：降级登记表的公共出口与百炼进程内组合验收。全部输入合成：
// - 登记表工厂只经 platform 公共出口（apps/api/src/modules/platform/index.ts）的命名空间取得，
//   不从 platform/resilience 内部路径导入值；缺出口时由 expect 断言失败（自然红），不抛人为错误。
//   类型只作 `import type`，不进运行时。
// - 百炼故障表现取自 QA-05a 的 buildMappings('bailian')（infra/fault/fault.ts），注入的 fetch 只消费
//   其中的 status 与 fixedDelayMilliseconds；QA-05a 的 normal 是非流式 JSON，成功与恢复改用下面
//   明确标注的独立合成 SSE 应答，不冒称 QA-05a 支持流式。
// - 组合链是已实现的真实代码：createHttpTransport → createMeteredVendorGateway → createModelRouter，
//   路由经真实 resolveRoute（主位 Flash、备位 Plus）。地址为 https://….invalid，只交给注入的 fetch，
//   从不联网；不 listen、不起 WireMock、不读密钥（apiKey 是合成串）。
// - 时间只走手动 Scheduler（platform/http 规则测试的 ManualScheduler）与 FixedClock。
// 这是进程内组合验收，不是生产装配，也不是真实 WireMock 演练。
import { expect } from 'vitest';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { GovernancePolicy } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  ResilienceOverrides,
  ResilienceRegistry,
} from '../../../../apps/api/src/modules/platform/resilience/index.ts';
import {
  createHttpTransport,
  createMeteredVendorGateway,
  createModelRouter,
  createRunModelClock,
  quirksFor,
  resolveRoute,
} from '../../../../apps/api/src/modules/agent/model-gateway/index.ts';
import type {
  FetchInit,
  FetchResponseLike,
  ModelOutcome,
  ModelRouter,
  RouterAlert,
  RouterChatInput,
  RouteTable,
  UsageEntry,
  UsageSink,
} from '../../../../apps/api/src/modules/agent/model-gateway/index.ts';
import { buildMappings } from '../../../../infra/fault/fault.ts';
import type { StubMapping, StubResponse } from '../../../../infra/fault/fault.ts';
import { ManualScheduler, observe } from '../http/kit.ts';
import type { Observed } from '../http/kit.ts';

export { ManualScheduler, observe };
export type { Observed };

/** 公共出口应提供的工厂签名（与 platform/resilience 头注释的契约一致）。 */
export type RegistryFactory = (overrides?: ResilienceOverrides) => ResilienceRegistry;

/**
 * 从 platform 公共出口的命名空间取登记表工厂。缺出口时 expect 失败（AssertionError，自然红）；
 * 每个顶层用例都先经这里取得工厂。
 */
export function publicRegistryFactory(): RegistryFactory {
  const candidate: unknown = Reflect.get(platform, 'createResilienceRegistry');
  expect(
    typeof candidate,
    'apps/api/src/modules/platform/index.ts 应导出 createResilienceRegistry（B1-14b）',
  ).toBe('function');
  return candidate as RegistryFactory;
}

/** 经公共出口取得 model.qwen 的治理策略（可带登记表允许的覆盖）。 */
export function publicQwenPolicy(overrides?: ResilienceOverrides): GovernancePolicy {
  const factory = publicRegistryFactory();
  const registry = overrides === undefined ? factory() : factory(overrides);
  return registry.entry('model.qwen').policy;
}

/**
 * 本验收用的覆盖：单次时限 2500 ms（低于默认上限，证明覆盖确实生效）；熔断窗口内 2 次、失败率高于
 * 50 % 即打开 12000 ms（默认 minRequests 20 / openMs 30000 在进程内太大，覆盖后可确定地触发与恢复）。
 */
export function fastQwenOverrides(): ResilienceOverrides {
  return {
    'model.qwen': {
      timeoutMs: 2500,
      breaker: { windowMs: 10_000, minRequests: 2, failureRatePercent: 50, openMs: 12_000 },
    },
  };
}

// ---------- QA-05a 百炼故障定义 ----------

export type BailianFault = 'timeout' | 'rate_limited' | 'server_error' | 'normal';

/** buildMappings('bailian') 里按请求头选场景的那条映射（WireMock 优先级 1）。 */
export function bailianMapping(scenario: BailianFault): StubMapping {
  const found = buildMappings('bailian').find((m) => m.name === `bailian.${scenario}.header`);
  expect(found, `QA-05a buildMappings('bailian') 缺 ${scenario} 映射`).toBeDefined();
  return found as StubMapping;
}

// ---------- 合成 SSE 成功应答（独立夹具，非 QA-05a） ----------

/**
 * 【合成 SSE】OpenAI 兼容流式应答：一段文本 + stop 结束片（带累计 usage）+ [DONE]。
 * 只用于成功与恢复；QA-05a 的 normal 场景是非流式 chat.completion JSON，不能当流式用。
 */
export function syntheticSse(text: string, input: number, output: number): string {
  const first = { choices: [{ index: 0, delta: { content: text } }] };
  const last = {
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: input, completion_tokens: output },
  };
  return `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`;
}

export type Reply =
  | { readonly t: 'fault'; readonly mapping: StubMapping }
  | { readonly t: 'sse'; readonly text: string };

export function fault(scenario: Exclude<BailianFault, 'normal'>): Reply {
  return { t: 'fault', mapping: bailianMapping(scenario) };
}

export function sse(text: string, input: number, output: number): Reply {
  return { t: 'sse', text: syntheticSse(text, input, output) };
}

async function* bytes(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
}

function faultAnswer(response: StubResponse): FetchResponseLike {
  const text =
    response.jsonBody !== undefined ? JSON.stringify(response.jsonBody) : (response.body ?? '');
  return {
    status: response.status ?? 200,
    body: bytes(text),
    text: () => Promise.resolve(text),
  };
}

export interface FetchCall {
  readonly at: number;
  readonly method: string;
  readonly pathname: string;
  readonly host: string;
  readonly accept: string | undefined;
  readonly model: unknown;
  readonly signal: AbortSignal;
}

/**
 * 注入给真实 HttpTransport 的 fetch：按请求体里的 model 取该型号脚本的下一条应答。
 * fault 应答只消费 QA-05a 映射的 status 与 fixedDelayMilliseconds（延迟走手动 Scheduler，随
 * AbortSignal 取消）；sse 应答是 200 + 合成 SSE 字节流。没排脚本的调用照样记录，然后以普通错误失败，
 * 由调用次数断言抓住。
 */
export class FaultUpstream {
  readonly calls: FetchCall[] = [];
  private readonly scheduler: ManualScheduler;
  private readonly script: Map<string, Reply[]>;

  constructor(scheduler: ManualScheduler, script: Readonly<Record<string, readonly Reply[]>>) {
    this.scheduler = scheduler;
    this.script = new Map(Object.entries(script).map(([model, list]) => [model, [...list]]));
  }

  callsFor(model: string): FetchCall[] {
    return this.calls.filter((call) => call.model === model);
  }

  readonly fetch = (url: string, init: FetchInit): Promise<FetchResponseLike> => {
    const parsed = new URL(url);
    let model: unknown = null;
    try {
      model = (JSON.parse(init.body) as { model?: unknown }).model;
    } catch {
      model = null;
    }
    this.calls.push({
      at: this.scheduler.now(),
      method: init.method,
      pathname: parsed.pathname,
      host: parsed.host,
      accept: init.headers['Accept'],
      model,
      signal: init.signal,
    });
    const reply = typeof model === 'string' ? this.script.get(model)?.shift() : undefined;
    if (reply === undefined) return Promise.reject(new Error('unscripted fetch'));
    if (reply.t === 'sse') {
      return Promise.resolve({
        status: 200,
        body: bytes(reply.text),
        text: () => Promise.resolve(reply.text),
      });
    }
    const response = reply.mapping.response;
    if (response.fault !== undefined) return Promise.reject(new Error('synthetic transport fault'));
    const delay = response.fixedDelayMilliseconds;
    if (delay === undefined) return Promise.resolve(faultAnswer(response));
    return this.scheduler.sleep(delay, init.signal).then(() => faultAnswer(response));
  };
}

// ---------- 进程内组合链 ----------

/** 合成路由表：主位 Flash、备位 Plus（BR-AI-14 路由顺序），均为已签字评测的锁定快照。 */
function routeTable(): RouteTable {
  return {
    entries: [
      {
        id: 'flash',
        vendor: 'qwen',
        tier: 'flash',
        model: 'qwen-flash-2026-09-01',
        evaluation: { report: 'reports/synthetic-flash.md', signed: true },
      },
      {
        id: 'plus',
        vendor: 'qwen',
        tier: 'plus',
        model: 'qwen-plus-2026-09-15',
        evaluation: { report: 'reports/synthetic-plus.md', signed: true },
      },
    ],
    crossVendor: [],
  };
}

export class MemorySink implements UsageSink {
  readonly entries: UsageEntry[] = [];
  record(entry: UsageEntry): void {
    this.entries.push(entry);
  }
}

export const FIXED_AT = '2026-10-09T02:00:00.000Z';

export interface Chain {
  readonly scheduler: ManualScheduler;
  readonly upstream: FaultUpstream;
  readonly onlineMeter: MemorySink;
  readonly offlineMeter: MemorySink;
  readonly alerts: RouterAlert[];
  readonly router: ModelRouter;
  /** 发起一次 complete（本 run 模型累计时限 8000 ms），返回可观察的结果。 */
  complete(): Observed<ModelOutcome>;
}

export interface ChainOptions {
  readonly policy: GovernancePolicy;
  readonly script: Readonly<Record<string, readonly Reply[]>>;
  readonly budgetExhausted?: () => boolean;
}

export function chatInput(): RouterChatInput {
  return {
    system: '合成系统前缀',
    tools: [],
    messages: [{ role: 'user', content: '合成：找保温杯' }],
  };
}

/** 把登记表的 model.qwen 策略注入已实现的 HttpTransport → VendorGateway → ModelRouter。 */
export function buildChain(o: ChainOptions): Chain {
  const scheduler = new ManualScheduler();
  const upstream = new FaultUpstream(scheduler, o.script);
  const clock = new FixedClock(FIXED_AT);
  const transport = createHttpTransport({
    vendor: 'qwen',
    baseUrl: 'https://dashscope.invalid/bailian/compatible-mode/v1',
    apiKey: () => 'synthetic-test-credential',
    fetch: upstream.fetch,
    quirks: quirksFor('qwen'),
  });
  const onlineMeter = new MemorySink();
  const offlineMeter = new MemorySink();
  const gateway = createMeteredVendorGateway({
    transport,
    clock,
    onlineMeter,
    offlineMeter,
    offlineBudgetApproved: [],
    rewrittenSampleGrants: [],
    ownerAggregateApprovals: [],
  });
  const alerts: RouterAlert[] = [];
  const router = createModelRouter({
    gateway,
    route: () =>
      resolveRoute(
        routeTable(),
        { mode: 'models', primary: 'flash', backup: 'plus' },
        { consentVendors: ['qwen'] },
      ),
    budgetExhausted: o.budgetExhausted ?? (() => false),
    config: {
      attemptTimeoutMs: o.policy.timeoutMs,
      breaker: { ...o.policy.breaker },
    },
    scheduler,
    meter: onlineMeter,
    clock,
    onAlert: (alert) => {
      alerts.push(alert);
    },
  });
  return {
    scheduler,
    upstream,
    onlineMeter,
    offlineMeter,
    alerts,
    router,
    complete: () =>
      observe(
        router.complete(chatInput(), {
          clock: createRunModelClock(8000),
          signal: new AbortController().signal,
        }),
      ),
  };
}

/** 先让排队的回调跑完（不推进时间），再返回结果。 */
export async function settle<T>(
  scheduler: ManualScheduler,
  observed: Observed<T>,
): Promise<Observed<T>> {
  await scheduler.advance(0);
  return observed;
}
