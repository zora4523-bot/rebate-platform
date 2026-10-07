// VendorGateway 直接调用时协议错误携带的用量：BR-AI-14 细则「多厂商接入」（离线调用费用按厂商独立计量，线上 / 离线不混）、
// BR-AI-16（单次调用成本按 input / output token 计，在调用完成时计入；失败但已产生用量的调用同样已完成计费）。
// 与 B3-02b 约定：ModelProtocolError.usage 为已收到的有效累计用量，null 表示未知、不能按零计费。
// 口径（tests-claude.md）：网关掌握 transport.billable 与调用用途，invoke 拒绝时若错误是 ModelProtocolError 且 usage 非 null，
// 计费传输按用途记一条（线上进 onlineMeter、use=null；离线进 offlineMeter、带 use），时刻取网关的 Clock；
// billable=false 不记；usage=null 不记；错误对象原样抛给调用方。
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { createVendorGateway } from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import type {
  OfflineUse,
  OfflineVendorCall,
  VendorCall,
  VendorId,
  VendorTransport,
} from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import {
  ModelProtocolError,
  type ModelErrorKind,
} from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import type { Clock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  GATEWAY_AT,
  MemorySink,
  PlanTransport,
  gatewayClock,
  rejection,
  usageEntry,
} from './kit.ts';

type OfflineName = 'offline-qwen' | 'offline-glm' | 'offline-qwen-review' | 'offline-glm-gen';
type CallName = 'online' | OfflineName;

/** 四种离线用途各一条调用（BR-AI-14 多厂商接入：评测对照、评审打分、提示词改写、生成合成评测题）。 */
const OFFLINE_CALLS = {
  'offline-qwen': {
    vendor: 'qwen',
    use: 'eval_compare',
    accessPath: 'bailian',
    workspace: 'ws-synthetic-eval',
    model: 'qwen-synthetic-m1',
    dataClass: 'synthetic',
  },
  'offline-glm': {
    vendor: 'glm',
    use: 'prompt_rewrite',
    accessPath: 'zhipu_open',
    workspace: 'ws-synthetic-rewrite',
    model: 'glm-synthetic-m2',
    dataClass: 'prompt',
  },
  'offline-qwen-review': {
    vendor: 'qwen',
    use: 'review_scoring',
    accessPath: 'bailian',
    workspace: 'ws-synthetic-review',
    model: 'qwen-synthetic-m3',
    dataClass: 'public_product',
  },
  'offline-glm-gen': {
    vendor: 'glm',
    use: 'synthetic_eval_gen',
    accessPath: 'bailian',
    workspace: 'ws-synthetic-gen',
    model: 'glm-synthetic-m4',
    dataClass: 'synthetic',
  },
} as const satisfies Record<OfflineName, Omit<OfflineVendorCall, 'purpose' | 'body'>>;

/** 期望条目的厂商 / 用途 / 型号：与上表分开手写，不由夹具或被测代码推出。 */
const EXPECTED: Record<CallName, { vendor: VendorId; use: OfflineUse | null; model: string }> = {
  online: { vendor: 'qwen', use: null, model: 'qwen-synthetic-m1' },
  'offline-qwen': { vendor: 'qwen', use: 'eval_compare', model: 'qwen-synthetic-m1' },
  'offline-glm': { vendor: 'glm', use: 'prompt_rewrite', model: 'glm-synthetic-m2' },
  'offline-qwen-review': { vendor: 'qwen', use: 'review_scoring', model: 'qwen-synthetic-m3' },
  'offline-glm-gen': { vendor: 'glm', use: 'synthetic_eval_gen', model: 'glm-synthetic-m4' },
};

function call(name: CallName): VendorCall {
  const body = { messages: [{ role: 'user', content: '合成：找保温杯' }], stream: true };
  if (name === 'online') {
    return {
      purpose: 'online',
      vendor: 'qwen',
      model: 'qwen-synthetic-m1',
      dataClass: 'user_input',
      body,
    };
  }
  return { purpose: 'offline', ...OFFLINE_CALLS[name], body };
}

function gatewayOver(
  transport: VendorTransport,
  onlineMeter: MemorySink,
  offlineMeter: MemorySink,
  clock: Clock = gatewayClock,
) {
  return createVendorGateway({
    transport,
    clock,
    onlineMeter,
    offlineMeter,
    offlineBudgetApproved: ['glm'] satisfies VendorId[],
    rewrittenSampleGrants: [],
    ownerAggregateApprovals: [],
  });
}

it.each([
  { name: 'online', kind: 'server', input: 200, output: 15 },
  { name: 'offline-qwen', kind: 'malformed', input: 64, output: 9 },
  { name: 'offline-glm', kind: 'timeout', input: 7, output: 0 },
] as const)(
  '[BR-AI-14 多厂商接入 计量][BR-AI-16] 计费传输以 $kind 拒绝且错误带 usage（$name）：网关按用途记恰好一条、另一侧不记，错误对象原样抛出',
  async ({ name, kind, input, output }) => {
    const error = new ModelProtocolError(kind, 'synthetic failure', {
      usage: { input_tokens: input, output_tokens: output },
    });
    const online = new MemorySink();
    const offline = new MemorySink();
    const gateway = gatewayOver(new PlanTransport(true, [{ t: 'fail', error }]), online, offline);
    expect(await rejection(() => gateway.invoke(call(name)))).toBe(error);
    if (name === 'online') {
      expect(online.entries).toEqual([
        usageEntry('online', 'qwen', null, 'qwen-synthetic-m1', 200, 15, GATEWAY_AT),
      ]);
      expect(offline.entries).toEqual([]);
    } else {
      expect(online.entries).toEqual([]);
      expect(offline.entries).toEqual([
        name === 'offline-qwen'
          ? usageEntry('offline', 'qwen', 'eval_compare', 'qwen-synthetic-m1', 64, 9, GATEWAY_AT)
          : usageEntry('offline', 'glm', 'prompt_rewrite', 'glm-synthetic-m2', 7, 0, GATEWAY_AT),
      ]);
    }
  },
);

it.each([
  { name: 'offline-qwen-review', kind: 'malformed', input: 64, output: 9 },
  { name: 'offline-glm-gen', kind: 'server', input: 64, output: 9 },
  { name: 'offline-qwen-review', kind: 'network', input: 2_147_483_649, output: 1 },
  { name: 'offline-glm-gen', kind: 'rate_limited', input: 0, output: 9_007_199_254_740_991 },
] as const)(
  '[BR-AI-14 多厂商接入 计量][BR-AI-16] 离线 $name 带已知用量 $input / $output 以 $kind 失败：离线恰记一条（use 与 token 逐字段精确），线上不记',
  async ({ name, kind, input, output }) => {
    const error = new ModelProtocolError(kind, 'synthetic failure', {
      usage: { input_tokens: input, output_tokens: output },
    });
    const online = new MemorySink();
    const offline = new MemorySink();
    const gateway = gatewayOver(new PlanTransport(true, [{ t: 'fail', error }]), online, offline);
    expect(await rejection(() => gateway.invoke(call(name)))).toBe(error);
    expect(online.entries).toEqual([]);
    expect(offline.entries).toEqual([
      name === 'offline-qwen-review'
        ? usageEntry(
            'offline',
            'qwen',
            'review_scoring',
            'qwen-synthetic-m3',
            input,
            output,
            GATEWAY_AT,
          )
        : usageEntry(
            'offline',
            'glm',
            'synthetic_eval_gen',
            'glm-synthetic-m4',
            input,
            output,
            GATEWAY_AT,
          ),
    ]);
  },
);

it.each(['online', 'offline-qwen'] as const)(
  '[BR-AI-14 多厂商接入 计量] billable=false 的传输（录制回放类）错误带 usage 不记；同一组计量去处上的计费网关照记（%s）',
  async (name) => {
    const online = new MemorySink();
    const offline = new MemorySink();
    const replayError = new ModelProtocolError('malformed', 'synthetic failure', {
      usage: { input_tokens: 500, output_tokens: 50 },
    });
    const replay = gatewayOver(
      new PlanTransport(false, [{ t: 'fail', error: replayError }]),
      online,
      offline,
    );
    expect(await rejection(() => replay.invoke(call(name)))).toBe(replayError);
    expect([...online.entries, ...offline.entries]).toEqual([]);
    const paidError = new ModelProtocolError('network', 'synthetic failure', {
      usage: { input_tokens: 41, output_tokens: 3 },
    });
    const paid = gatewayOver(
      new PlanTransport(true, [{ t: 'fail', error: paidError }]),
      online,
      offline,
    );
    expect(await rejection(() => paid.invoke(call(name)))).toBe(paidError);
    expect([...online.entries, ...offline.entries]).toEqual([
      name === 'online'
        ? usageEntry('online', 'qwen', null, 'qwen-synthetic-m1', 41, 3, GATEWAY_AT)
        : usageEntry('offline', 'qwen', 'eval_compare', 'qwen-synthetic-m1', 41, 3, GATEWAY_AT),
    ]);
  },
);

it.each(['online', 'offline-glm-gen'] as const)(
  '[BR-AI-16 只记一次] 同一网关两次独立调用（%s）各抛出内容相同但引用不同的协议错误：恰记两条，不按内容去重',
  async (name) => {
    const first = new ModelProtocolError('malformed', 'synthetic failure', {
      usage: { input_tokens: 64, output_tokens: 9 },
    });
    const second = new ModelProtocolError('malformed', 'synthetic failure', {
      usage: { input_tokens: 64, output_tokens: 9 },
    });
    const online = new MemorySink();
    const offline = new MemorySink();
    const gateway = gatewayOver(
      new PlanTransport(true, [
        { t: 'fail', error: first },
        { t: 'fail', error: second },
      ]),
      online,
      offline,
    );
    expect(await rejection(() => gateway.invoke(call(name)))).toBe(first);
    expect(await rejection(() => gateway.invoke(call(name)))).toBe(second);
    if (name === 'online') {
      expect(online.entries).toEqual([
        usageEntry('online', 'qwen', null, 'qwen-synthetic-m1', 64, 9, GATEWAY_AT),
        usageEntry('online', 'qwen', null, 'qwen-synthetic-m1', 64, 9, GATEWAY_AT),
      ]);
      expect(offline.entries).toEqual([]);
    } else {
      expect(offline.entries).toEqual([
        usageEntry('offline', 'glm', 'synthetic_eval_gen', 'glm-synthetic-m4', 64, 9, GATEWAY_AT),
        usageEntry('offline', 'glm', 'synthetic_eval_gen', 'glm-synthetic-m4', 64, 9, GATEWAY_AT),
      ]);
      expect(online.entries).toEqual([]);
    }
  },
);

it('[BR-AI-16] usage 为 null 的协议错误不记（不按零用量记）；随后一次带 usage 的失败只记它自己那一条', async () => {
  const online = new MemorySink();
  const offline = new MemorySink();
  const unknown = new ModelProtocolError('server', 'synthetic failure');
  const known = new ModelProtocolError('server', 'synthetic failure', {
    usage: { input_tokens: 5, output_tokens: 1 },
  });
  const gateway = gatewayOver(
    new PlanTransport(true, [
      { t: 'fail', error: unknown },
      { t: 'fail', error: known },
    ]),
    online,
    offline,
  );
  expect(await rejection(() => gateway.invoke(call('online')))).toBe(unknown);
  expect(online.entries).toEqual([]);
  expect(await rejection(() => gateway.invoke(call('online')))).toBe(known);
  expect(online.entries).toEqual([
    usageEntry('online', 'qwen', null, 'qwen-synthetic-m1', 5, 1, GATEWAY_AT),
  ]);
  expect(offline.entries).toEqual([]);
});

it('[BR-AI-16][回归] 成功调用的计量不变：成功一条、随后失败一条，按发生顺序各记一次', async () => {
  const online = new MemorySink();
  const offline = new MemorySink();
  const error = new ModelProtocolError('rate_limited', 'synthetic failure', {
    usage: { input_tokens: 90, output_tokens: 0 },
  });
  const gateway = gatewayOver(
    new PlanTransport(true, [
      { t: 'ok', input: 321, output: 54 },
      { t: 'fail', error },
    ]),
    online,
    offline,
  );
  const response = await gateway.invoke(call('offline-qwen'));
  expect(response.usage).toEqual({ input_tokens: 321, output_tokens: 54 });
  expect(await rejection(() => gateway.invoke(call('offline-qwen')))).toBe(error);
  expect(offline.entries).toEqual([
    usageEntry('offline', 'qwen', 'eval_compare', 'qwen-synthetic-m1', 321, 54, GATEWAY_AT),
    usageEntry('offline', 'qwen', 'eval_compare', 'qwen-synthetic-m1', 90, 0, GATEWAY_AT),
  ]);
  expect(online.entries).toEqual([]);
});

// 属性：任意用途（线上与四种离线用途）、任意计费属性、任意已知 / 未知用量、任意错误种类、任意计量时刻（Clock 注入值）。
const kinds: ModelErrorKind[] = [
  'content_refused',
  'auth',
  'bad_request',
  'rate_limited',
  'quota_exhausted',
  'server',
  'timeout',
  'network',
  'aborted',
  'malformed',
  'model_not_pinned',
];
// token：任意安全整数（含大于 2^31 的值），另显式混入 0、1、奇数与 2^31、2^31+1、2^32+1、最大安全整数等边界。
const tokens = fc.oneof(
  fc.constantFrom(
    0,
    1,
    7,
    2_147_483_647,
    2_147_483_648,
    2_147_483_649,
    4_294_967_297,
    Number.MAX_SAFE_INTEGER,
  ),
  fc.integer({ min: 0, max: 2_147_483_647 }),
  fc.integer({ min: 2_147_483_648, max: Number.MAX_SAFE_INTEGER }),
);
const sample = fc.record({
  name: fc.constantFrom<CallName>(
    'online',
    'offline-qwen',
    'offline-glm',
    'offline-qwen-review',
    'offline-glm-gen',
  ),
  billable: fc.boolean(),
  usage: fc.option(
    fc.record({
      input_tokens: tokens,
      output_tokens: tokens,
    }),
    { nil: null },
  ),
  kind: fc.constantFrom(...kinds),
  atMs: fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) }),
});
type Sample = typeof sample extends fc.Arbitrary<infer T> ? T : never;

async function holds(s: Sample): Promise<boolean> {
  const error = new ModelProtocolError(s.kind, 'synthetic failure', { usage: s.usage });
  const online = new MemorySink();
  const offline = new MemorySink();
  const clock: Clock = { now: () => new Date(s.atMs) };
  const gateway = gatewayOver(
    new PlanTransport(s.billable, [{ t: 'fail', error }]),
    online,
    offline,
    clock,
  );
  if ((await rejection(() => gateway.invoke(call(s.name)))) !== error) return false;
  const expected = EXPECTED[s.name];
  const target = s.name === 'online' ? online : offline;
  const other = s.name === 'online' ? offline : online;
  if (other.entries.length !== 0) return false;
  if (!s.billable || s.usage === null) return target.entries.length === 0;
  const got = target.entries[0];
  return (
    target.entries.length === 1 &&
    got !== undefined &&
    Object.keys(got).sort().join(',') ===
      'input_tokens,model,output_tokens,purpose,recorded_at,use,vendor' &&
    got.vendor === expected.vendor &&
    got.purpose === (s.name === 'online' ? 'online' : 'offline') &&
    got.use === expected.use &&
    got.model === expected.model &&
    got.input_tokens === s.usage.input_tokens &&
    got.output_tokens === s.usage.output_tokens &&
    got.recorded_at instanceof Date &&
    got.recorded_at.getTime() === s.atMs
  );
}

it('[BR-AI-14 多厂商接入 计量][BR-AI-16] 任意用途 / 计费属性 / 用量 / 错误种类 / 计量时刻：计费且 usage 非 null 时按用途恰记一条（值与时刻对得上），否则两侧都不记', async () => {
  const details = await fc.check(fc.asyncProperty(sample, holds), propParams());
  expect({ failed: details.failed, counterexample: details.counterexample }).toStrictEqual({
    failed: false,
    counterexample: null,
  });
}, 900_000);
