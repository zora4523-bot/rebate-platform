// 规则测试共用夹具（B3-02e）。全部是合成数据：不调用任何真实模型接口、不读任何密钥、不联网。
// 时间只走手动 Scheduler（复用 model-routing / platform/http 的夹具）与固定 Clock；不用真实计时器。
// 网关用真实的 createVendorGateway（未经 createMeteredVendorGateway 登记），传输是进程内的按次脚本假传输。
// 网关与路由器故意注入两个不同时刻的 Clock、两个不同的计量去处：计量条目落在哪里、带哪个时刻，就能看出是谁记的。
// 期望值一律由下面的函数每次新建字面量，不由被测代码产生，也不与被测代码拿到的对象共享引用。
import type { Clock } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  OfflineUse,
  UsageEntry,
  VendorId,
  VendorPurpose,
  VendorRequest,
  VendorResponse,
  VendorTransport,
} from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import type { ModelProtocolError } from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';

export {
  ManualScheduler,
  MemorySink,
  chatInput,
  ctx,
  flush,
  observe,
  quietBreaker,
  resolved,
  FLASH,
  PLUS,
} from '../model-routing/kit.ts';

/** 网关的计量时刻。 */
export const GATEWAY_AT = '2026-10-07T03:04:05.000Z';
/** 路由器的计量时刻（与网关不同）：条目若带这个时刻，说明是路由器补记的。 */
export const ROUTER_AT = '2026-10-07T09:08:07.000Z';
export const gatewayClock: Clock = { now: () => new Date(GATEWAY_AT) };
export const routerClock: Clock = { now: () => new Date(ROUTER_AT) };

/**
 * 每次 send 取下一步：ok 返回带用量的分片；fail 以给定错误对象拒绝；
 * onAbort 挂起，收到 signal 中止后才以给定错误对象拒绝（模拟中止后才报出已收用量的传输）；
 * manual 挂起，由测试调用 settle 拒绝（模拟不理会 signal 的上游）。
 * 没排脚本的调用照样记录，然后以普通错误失败，由调用次数断言抓住。
 */
export type Plan =
  | { readonly t: 'ok'; readonly input: number; readonly output: number }
  | { readonly t: 'fail'; readonly error: ModelProtocolError }
  | { readonly t: 'onAbort'; readonly error: ModelProtocolError }
  | { readonly t: 'manual' };

export class PlanTransport implements VendorTransport {
  readonly billable: boolean;
  readonly calls: VendorRequest[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  readonly manual: ((error: unknown) => void)[] = [];
  private readonly plans: Plan[];
  constructor(billable: boolean, plans: readonly Plan[]) {
    this.billable = billable;
    this.plans = [...plans];
  }
  send(request: VendorRequest, signal?: AbortSignal): Promise<VendorResponse> {
    this.calls.push(request);
    this.signals.push(signal);
    const plan = this.plans.shift();
    if (plan === undefined) return Promise.reject(new Error('unscripted transport call'));
    if (plan.t === 'fail') return Promise.reject(plan.error);
    if (plan.t === 'onAbort') {
      return new Promise<VendorResponse>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(plan.error), { once: true });
      });
    }
    if (plan.t === 'manual') {
      return new Promise<VendorResponse>((_resolve, reject) => {
        this.manual.push(reject);
      });
    }
    return Promise.resolve({
      chunks: [
        { choices: [{ index: 0, delta: { content: `合成回答:${request.model}` } }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: plan.input, completion_tokens: plan.output },
        },
      ],
      usage: { input_tokens: plan.input, output_tokens: plan.output },
    });
  }
}

/** 计量条目的期望值（每次新建字面量）。 */
export function usageEntry(
  purpose: VendorPurpose,
  vendor: VendorId,
  use: OfflineUse | null,
  model: string,
  input: number,
  output: number,
  at: string,
): UsageEntry {
  return {
    vendor,
    purpose,
    use,
    model,
    input_tokens: input,
    output_tokens: output,
    recorded_at: new Date(at),
  };
}

/** 运行时拿到拒绝原因；没拒绝时返回 'no_error'。 */
export async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return 'no_error';
  } catch (error) {
    return error;
  }
}
