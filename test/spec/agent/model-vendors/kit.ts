// 规则测试共用夹具（B3-02a）。全部是合成数据：不调用任何真实模型接口、不读任何密钥。
import type { Clock } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  UsageEntry,
  UsageSink,
  VendorId,
  VendorRecording,
  VendorRequest,
  VendorResponse,
  VendorTransport,
  VendorUsage,
} from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';

export const fixedAt = '2026-10-06T01:02:03.000Z';
export const fixedClock: Clock = { now: () => new Date(fixedAt) };

// 请求体与响应每次调用都新建：被测代码改动它拿到的对象，改不到断言里的期望值。
export function syntheticBody() {
  return {
    messages: [{ role: 'user', content: '合成：找一款 500ml 保温杯' }],
    tools: [{ type: 'function', function: { name: 'search_products' } }],
    stream: true,
  };
}

export function syntheticResponse(): VendorResponse {
  return {
    chunks: [{ synthetic: true, delta: '合成分片' }],
    usage: { input_tokens: 120, output_tokens: 30 },
  };
}

/**
 * 内存假传输：记录收到的请求与 signal；billable 由测试指定（模拟「会计费的真实传输」时为 true）。
 * 每次返回新建的合成结果，分片里带 vendor 与 model，便于区分是哪家返回的；
 * 用量按构造时给的队列依次返回，队列空了用 120 / 30。
 */
export class FakeTransport implements VendorTransport {
  readonly calls: VendorRequest[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  readonly billable: boolean;
  private readonly usages: VendorUsage[];
  constructor(billable: boolean, usages: readonly VendorUsage[] = []) {
    this.billable = billable;
    this.usages = usages.map((u) => ({ ...u }));
  }
  send(request: VendorRequest, signal?: AbortSignal): Promise<VendorResponse> {
    this.calls.push(request);
    this.signals.push(signal);
    const usage = this.usages.shift() ?? { input_tokens: 120, output_tokens: 30 };
    return Promise.resolve(fakeResult(request.vendor, request.model, usage));
  }
}

function fakeResult(vendor: string, model: string, usage: VendorUsage): VendorResponse {
  return {
    chunks: [{ synthetic: true, delta: `合成:${vendor}:${model}` }],
    usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
  };
}

/** 断言用的期望值：每次独立新建，与被测代码拿到的对象不共享引用。 */
export function expectedResult(
  vendor: VendorId,
  model: string,
  input_tokens = 120,
  output_tokens = 30,
): VendorResponse {
  return fakeResult(vendor, model, { input_tokens, output_tokens });
}

export class MemorySink implements UsageSink {
  readonly entries: UsageEntry[] = [];
  record(entry: UsageEntry): void {
    this.entries.push(entry);
  }
}

export function recording(
  vendor: VendorId,
  overrides: Partial<VendorRecording> = {},
): VendorRecording {
  return {
    synthetic: true,
    vendor,
    model: `${vendor}-synthetic-snapshot`,
    request: syntheticBody(),
    response: syntheticResponse(),
    ...overrides,
  };
}

/** 运行时拿到错误码；没抛错时返回 'no_error'，便于断言给出可读失败。 */
export async function rejectionCode(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return 'no_error';
  } catch (error) {
    return (error as { code?: unknown }).code ?? (error as Error).message;
  }
}

export function syncCode(run: () => unknown): unknown {
  try {
    run();
    return 'no_error';
  } catch (error) {
    return (error as { code?: unknown }).code ?? (error as Error).message;
  }
}

/** 去掉一个字段的浅拷贝（构造缺字段的录制）。 */
export function without(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
}
