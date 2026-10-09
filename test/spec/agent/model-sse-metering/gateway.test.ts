// 真实网关链路上的 SSE 畸形帧失败计量（B3-02h）：BR-AI-14 细则「多厂商接入」（离线调用费用按厂商独立计量，线上 / 离线不混）；
// BR-AI-16（失败但已产生用量的调用同样计入，只记一次）。链路：createVendorGateway → createHttpTransport → SSE 解析，全部真实；
// 只有 fetch 是注入的假实现，用异步字节流控制每次读取的边界；不联网、不监听端口。
// 千问走线上与离线；GLM 只登记离线，只走离线（额度批准是注入的假配置）。
// 期望条目一律是独立字面量；切分位置只按测试自己的文本算字节偏移。
import { expect, it } from 'vitest';
import {
  ModelProtocolError,
  createHttpTransport,
  quirksFor,
  type FetchResponseLike,
} from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import { createVendorGateway } from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import type { VendorCall } from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import { MemorySink, gatewayClock, rejection } from '../model-metering/kit.ts';
import { exposedText, fakeApiKey, fakeFetch, streamResponse } from '../model-openai-compat/kit.ts';

const MODEL = 'qwen-flash-2026-09-01';

const TEXT =
  'data: {"id":"chatcmpl-synthetic","choices":[{"index":0,"delta":{"content":"合成回答"},"finish_reason":null}]}\n\n';
const STOP =
  'data: {"id":"chatcmpl-synthetic","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';
const USAGE_64_9 =
  'data: {"id":"chatcmpl-synthetic","choices":[],"usage":{"prompt_tokens":64,"completion_tokens":9,"total_tokens":73}}\n\n';
const TEXT_WITH_USAGE_30_1 =
  'data: {"id":"chatcmpl-synthetic","choices":[{"index":0,"delta":{"content":"合成回答"},"finish_reason":null}],"usage":{"prompt_tokens":30,"completion_tokens":1,"total_tokens":31}}\n\n';
const STOP_WITH_USAGE_64_9 =
  'data: {"id":"chatcmpl-synthetic","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":64,"completion_tokens":9,"total_tokens":73}}\n\n';
const PROBE = '合成残片探针K4';
const BAD = `data: {"id":"chatcmpl-synthetic","choices":[{"index":0,"delta":{"content":"${PROBE}"\n\n`;
const DONE = 'data: [DONE]\n\n';

const FAULT = TEXT + STOP + USAGE_64_9 + BAD + DONE;
const NEWER = TEXT_WITH_USAGE_30_1 + STOP_WITH_USAGE_64_9 + BAD + DONE;
const NO_USAGE = TEXT + STOP + BAD + DONE;

function byteAt(text: string, marker: string, plus = 0): number {
  const i = text.indexOf(marker);
  if (i < 0) throw new Error(`marker missing: ${marker}`);
  return new TextEncoder().encode(text.slice(0, i)).length + plus;
}

type Purpose = 'online' | 'offline';

function call(purpose: Purpose): VendorCall {
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: '合成：找保温杯' }],
    tools: [],
    stream: true,
    stream_options: { include_usage: true },
  };
  if (purpose === 'online') {
    return { purpose: 'online', vendor: 'qwen', model: MODEL, dataClass: 'user_input', body };
  }
  return {
    purpose: 'offline',
    vendor: 'qwen',
    model: MODEL,
    use: 'eval_compare',
    accessPath: 'bailian',
    workspace: 'ws-synthetic-eval',
    dataClass: 'synthetic',
    body,
  };
}

/** 真实网关 + 真实 HTTP 传输；每次 fetch 都按同一文本与切分新建响应流。 */
function chain(text: string, cuts: number[]) {
  const online = new MemorySink();
  const offline = new MemorySink();
  const f = fakeFetch(() => Promise.resolve(streamResponse(200, text, cuts)));
  const transport = createHttpTransport({
    vendor: 'qwen',
    baseUrl: 'https://synthetic-model.invalid/compatible-mode/v1',
    apiKey: fakeApiKey,
    fetch: f.fetch,
    quirks: quirksFor('qwen'),
  });
  const gateway = createVendorGateway({
    transport,
    clock: gatewayClock,
    onlineMeter: online,
    offlineMeter: offline,
    offlineBudgetApproved: [],
    rewrittenSampleGrants: [],
    ownerAggregateApprovals: [],
  });
  return { online, offline, gateway, f };
}

function entry64x9(purpose: Purpose) {
  return {
    vendor: 'qwen',
    purpose,
    use: purpose === 'offline' ? 'eval_compare' : null,
    model: 'qwen-flash-2026-09-01',
    input_tokens: 64,
    output_tokens: 9,
    recorded_at: new Date('2026-10-07T03:04:05.000Z'),
  };
}

function expectMalformed(err: unknown): ModelProtocolError {
  expect(err).toBeInstanceOf(ModelProtocolError);
  const e = err as ModelProtocolError;
  expect(e.kind).toBe('malformed');
  const seen = exposedText(e);
  for (const secret of [fakeApiKey(), PROBE, '合成回答']) expect(seen).not.toContain(secret);
  return e;
}

/** 本用途的计量去处在前，另一去处在后。 */
function sinks(c: ReturnType<typeof chain>, purpose: Purpose): readonly [MemorySink, MemorySink] {
  return purpose === 'online' ? [c.online, c.offline] : [c.offline, c.online];
}

const NO_USAGE_SPLITS: readonly (readonly [string, number[]])[] = [
  ['整段一次读取', []],
  ['切在畸形帧之前', [byteAt(NO_USAGE, BAD)]],
];

const SPLITS: readonly (readonly [string, string, number[]])[] = [
  ['64/9 后畸形帧、切在 usage 帧之后', FAULT, [byteAt(FAULT, BAD)]],
  ['64/9 后畸形帧、整段一次读取', FAULT, []],
  ['64/9 后畸形帧、切在 usage JSON 中间', FAULT, [byteAt(FAULT, '"completion_tokens":9')]],
  ['先 30/1 后 64/9 再畸形帧、整段一次读取', NEWER, []],
  ['先 30/1 后 64/9 再畸形帧、30/1 在前一次读取', NEWER, [byteAt(NEWER, STOP_WITH_USAGE_64_9)]],
];

it.each(['online', 'offline'] as const)(
  '[BR-AI-14 多厂商接入 计量][AC-B3-02h-005][AC-B3-02h-003#2][AC-B3-02h-004#3] 真实网关 %s 调用的计量对照：[DONE] 之后跟畸形帧照常成功、本用途只记一条 64/9；没有有效 usage 的畸形流以 malformed 失败、usage 为 null、两处都不写（不记零）；64/9（或先 30/1 后 64/9）之后遇畸形帧，五种读取方式都以 malformed 失败、本用途恰记一条 64/9、另一计量去处不写',
  async (purpose) => {
    // [DONE] 之后的畸形帧不影响成功与计量。
    {
      const c = chain(TEXT + STOP + USAGE_64_9 + DONE + BAD, []);
      const res = await c.gateway.invoke(call(purpose));
      expect(res.usage).toEqual({ input_tokens: 64, output_tokens: 9 });
      const [hit, other] = sinks(c, purpose);
      expect(hit.entries).toEqual([entry64x9(purpose)]);
      expect(other.entries).toEqual([]);
    }

    // 用量未知：不写零。
    for (const [, cuts] of NO_USAGE_SPLITS) {
      const c = chain(NO_USAGE, cuts);
      const e = expectMalformed(await rejection(() => c.gateway.invoke(call(purpose))));
      expect(e.usage).toBeNull();
      expect(c.online.entries).toEqual([]);
      expect(c.offline.entries).toEqual([]);
    }

    // 用量已知：不论读取方式，本用途恰记一条最新累计用量。
    const got: Record<string, unknown> = {};
    for (const [name, text, cuts] of SPLITS) {
      const c = chain(text, cuts);
      expectMalformed(await rejection(() => c.gateway.invoke(call(purpose))));
      expect(c.f.calls).toHaveLength(1);
      const [hit, other] = sinks(c, purpose);
      got[name] = { hit: hit.entries, other: other.entries };
    }
    expect(got).toEqual(
      Object.fromEntries(SPLITS.map(([name]) => [name, { hit: [entry64x9(purpose)], other: [] }])),
    );
  },
);

// ---- 首个畸形帧即终点：之后的有效 usage 不计量 ----

/** 畸形帧之后才出现的更新累计用量。 */
const USAGE_64_12 =
  'data: {"id":"chatcmpl-synthetic","choices":[],"usage":{"prompt_tokens":64,"completion_tokens":12,"total_tokens":76}}\n\n';
const LATER = TEXT + STOP + USAGE_64_9 + BAD + USAGE_64_12 + DONE;
const LATER_ONLY = TEXT + STOP + BAD + USAGE_64_12 + DONE;
const LATER_KNOWN: readonly (readonly [string, number[]])[] = [
  ['整段一次读取', []],
  ['切在畸形帧之后', [byteAt(LATER, USAGE_64_12)]],
  ['畸形帧前后各切一次', [byteAt(LATER, BAD), byteAt(LATER, USAGE_64_12)]],
];
const LATER_UNKNOWN: readonly (readonly [string, number[]])[] = [
  ['畸形帧前没有 usage、整段一次读取', []],
  ['畸形帧前没有 usage、切在畸形帧之后', [byteAt(LATER_ONLY, USAGE_64_12)]],
];

it.each(['online', 'offline'] as const)(
  '[BR-AI-14 多厂商接入 计量][AC-B3-02h-005#5][AC-B3-02h-003#9] 真实网关 %s 调用：有效 usage 64/9、畸形帧、随后又有有效 usage 64/12 与 [DONE]，整段一次读取、切在畸形帧之后、畸形帧前后各切，都以 malformed 失败、错误 usage 都是 64/9，本用途恰记一条 64/9、另一计量去处不写；畸形帧前没有有效 usage 时 usage 为 null、两处都不写，不借用之后的 64/12',
  async (purpose) => {
    const got: Record<string, unknown> = {};
    const cases = [
      ...LATER_KNOWN.map(([name, cuts]) => [name, LATER, cuts] as const),
      ...LATER_UNKNOWN.map(([name, cuts]) => [name, LATER_ONLY, cuts] as const),
    ];
    for (const [name, text, cuts] of cases) {
      const c = chain(text, cuts);
      const e = expectMalformed(await rejection(() => c.gateway.invoke(call(purpose))));
      expect(c.f.calls).toHaveLength(1);
      const [hit, other] = sinks(c, purpose);
      got[name] = { usage: e.usage, hit: hit.entries, other: other.entries };
    }
    expect(got).toEqual({
      ...Object.fromEntries(
        LATER_KNOWN.map(([name]) => [
          name,
          {
            usage: { input_tokens: 64, output_tokens: 9 },
            hit: [entry64x9(purpose)],
            other: [],
          },
        ]),
      ),
      ...Object.fromEntries(
        LATER_UNKNOWN.map(([name]) => [name, { usage: null, hit: [], other: [] }]),
      ),
    });
  },
);

// ---- 已计输入、尚无输出的完整 usage 64/0：照常计量，不当作未知 ----

const USAGE_64_0 =
  'data: {"id":"chatcmpl-synthetic","choices":[],"usage":{"prompt_tokens":64,"completion_tokens":0,"total_tokens":64}}\n\n';
const ZERO_OUTPUT = STOP + USAGE_64_0 + BAD + DONE;
const ZERO_OUTPUT_SPLITS: readonly (readonly [string, number[]])[] = [
  ['usage 与畸形帧同一次读取', []],
  ['切在 usage 帧之后', [byteAt(ZERO_OUTPUT, BAD)]],
];

function entry64x0(purpose: Purpose) {
  return {
    vendor: 'qwen',
    purpose,
    use: purpose === 'offline' ? 'eval_compare' : null,
    model: 'qwen-flash-2026-09-01',
    input_tokens: 64,
    output_tokens: 0,
    recorded_at: new Date('2026-10-07T03:04:05.000Z'),
  };
}

it.each(['offline', 'online'] as const)(
  '[BR-AI-14 多厂商接入 计量][AC-B3-02h-005#2][AC-B3-02h-003#5] 真实网关 %s 调用：完整有效 usage 64/0 之后遇畸形帧，与畸形帧同一次读取或分开读取，都以 malformed 失败、错误 usage 为 64/0、本用途恰记一条 64/0、另一计量去处不写',
  async (purpose) => {
    const got: Record<string, unknown> = {};
    for (const [name, cuts] of ZERO_OUTPUT_SPLITS) {
      const c = chain(ZERO_OUTPUT, cuts);
      const e = expectMalformed(await rejection(() => c.gateway.invoke(call(purpose))));
      expect(c.f.calls).toHaveLength(1);
      const [hit, other] = sinks(c, purpose);
      got[name] = { usage: e.usage, hit: hit.entries, other: other.entries };
    }
    expect(got).toEqual(
      Object.fromEntries(
        ZERO_OUTPUT_SPLITS.map(([name]) => [
          name,
          {
            usage: { input_tokens: 64, output_tokens: 0 },
            hit: [entry64x0(purpose)],
            other: [],
          },
        ]),
      ),
    );
  },
);

// ---- 同一个网关与 transport 连续复用：后一次失败不带前一次的用量，也不重复计量 ----

/** 真实网关 + 同一个真实 HTTP 传输；每次 fetch 依次取脚本里的下一份响应，用完后以普通错误拒绝。 */
function scriptedChain(script: readonly (readonly [string, number[]])[]) {
  const online = new MemorySink();
  const offline = new MemorySink();
  const queue = [...script];
  const f = fakeFetch(() => {
    const next = queue.shift();
    if (next === undefined) return Promise.reject(new Error('unscripted fetch'));
    return Promise.resolve(streamResponse(200, next[0], next[1]));
  });
  const transport = createHttpTransport({
    vendor: 'qwen',
    baseUrl: 'https://synthetic-model.invalid/compatible-mode/v1',
    apiKey: fakeApiKey,
    fetch: f.fetch,
    quirks: quirksFor('qwen'),
  });
  const gateway = createVendorGateway({
    transport,
    clock: gatewayClock,
    onlineMeter: online,
    offlineMeter: offline,
    offlineBudgetApproved: [],
    rewrittenSampleGrants: [],
    ownerAggregateApprovals: [],
  });
  return { online, offline, gateway, f };
}

it.each(['offline', 'online'] as const)(
  '[BR-AI-14 多厂商接入 计量][AC-B3-02h-005#3][AC-B3-02h-003#6] 同一个真实网关与 HTTP transport 连续两次 %s 调用：第一次 64/9 与畸形帧同一次读取失败、第二次没有任何 usage 失败；第二次错误 usage 为 null，本用途从头到尾只有第一次的一条 64/9，另一计量去处不写',
  async (purpose) => {
    const c = scriptedChain([
      [FAULT, []],
      [NO_USAGE, []],
    ]);
    const [hit, other] = sinks(c, purpose);
    const got: unknown[] = [];
    for (let i = 0; i < 2; i += 1) {
      const e = expectMalformed(await rejection(() => c.gateway.invoke(call(purpose))));
      got.push({ usage: e.usage, hit: [...hit.entries], other: [...other.entries] });
    }
    expect(c.f.calls).toHaveLength(2);
    expect(got).toEqual([
      {
        usage: { input_tokens: 64, output_tokens: 9 },
        hit: [entry64x9(purpose)],
        other: [],
      },
      { usage: null, hit: [entry64x9(purpose)], other: [] },
    ]);
  },
);

// ---- 同一个网关与 transport 上两次调用交错：各自的失败用量只属于自己 ----

/**
 * 两块的响应体：第一块交出后，消费者再次读取时才兑现 ready，然后停住，直到测试调用 release 才交出第二块。
 * 不用计时器；ready 兑现说明第一块已被消费者处理完。
 */
function heldResponse(head: string, tail: string) {
  let markReady: () => void = () => undefined;
  let release: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const encoder = new TextEncoder();
  const response: FetchResponseLike = {
    status: 200,
    body: {
      async *[Symbol.asyncIterator]() {
        yield encoder.encode(head);
        markReady();
        await released;
        yield encoder.encode(tail);
      },
    },
    text: () => Promise.resolve(head + tail),
  };
  return { response, ready, release: () => release() };
}

function outcome(err: unknown) {
  if (!(err instanceof ModelProtocolError)) return { error: 'not_model_protocol_error' };
  return { kind: err.kind, usage: err.usage };
}

it('[BR-AI-14 多厂商接入 计量][AC-B3-02h-005#4][AC-B3-02h-003#7] 同一个真实网关与 HTTP transport 上两次调用交错：线上 A 第一块收到 64/9 后停住，离线 B 在同一块里收到 64/0 与畸形帧并失败，再放 A 的畸形帧；A 以 malformed 失败、usage 64/9，B 以 malformed 失败、usage 64/0；B 结束时线上不写、离线只有 B 的 64/0；最终线上恰一条 A 的 64/9、离线恰一条 B 的 64/0', async () => {
  const held = heldResponse(TEXT + STOP + USAGE_64_9, BAD + DONE);
  const responses: FetchResponseLike[] = [
    held.response,
    streamResponse(200, STOP + USAGE_64_0 + BAD + DONE, []),
  ];
  const online = new MemorySink();
  const offline = new MemorySink();
  const f = fakeFetch(() => {
    const next = responses.shift();
    if (next === undefined) return Promise.reject(new Error('unscripted fetch'));
    return Promise.resolve(next);
  });
  const transport = createHttpTransport({
    vendor: 'qwen',
    baseUrl: 'https://synthetic-model.invalid/compatible-mode/v1',
    apiKey: fakeApiKey,
    fetch: f.fetch,
    quirks: quirksFor('qwen'),
  });
  const gateway = createVendorGateway({
    transport,
    clock: gatewayClock,
    onlineMeter: online,
    offlineMeter: offline,
    offlineBudgetApproved: [],
    rewrittenSampleGrants: [],
    ownerAggregateApprovals: [],
  });

  const runA = rejection(() => gateway.invoke(call('online')));
  let errB: unknown = 'not_run';
  let whileAHeld: unknown = 'not_run';
  try {
    // A 若提前结束也不挂起：照样跑 B，由下面的断言报出。
    await Promise.race([held.ready, runA.then(() => undefined)]);
    errB = await rejection(() => gateway.invoke(call('offline')));
    whileAHeld = { online: [...online.entries], offline: [...offline.entries] };
  } finally {
    held.release();
  }
  const errA = await runA;

  expect({
    a: outcome(errA),
    b: outcome(errB),
    whileAHeld,
    final: { online: online.entries, offline: offline.entries },
    fetchCalls: f.calls.length,
  }).toEqual({
    a: { kind: 'malformed', usage: { input_tokens: 64, output_tokens: 9 } },
    b: { kind: 'malformed', usage: { input_tokens: 64, output_tokens: 0 } },
    whileAHeld: {
      online: [],
      offline: [
        {
          vendor: 'qwen',
          purpose: 'offline',
          use: 'eval_compare',
          model: 'qwen-flash-2026-09-01',
          input_tokens: 64,
          output_tokens: 0,
          recorded_at: new Date('2026-10-07T03:04:05.000Z'),
        },
      ],
    },
    final: {
      online: [
        {
          vendor: 'qwen',
          purpose: 'online',
          use: null,
          model: 'qwen-flash-2026-09-01',
          input_tokens: 64,
          output_tokens: 9,
          recorded_at: new Date('2026-10-07T03:04:05.000Z'),
        },
      ],
      offline: [
        {
          vendor: 'qwen',
          purpose: 'offline',
          use: 'eval_compare',
          model: 'qwen-flash-2026-09-01',
          input_tokens: 64,
          output_tokens: 0,
          recorded_at: new Date('2026-10-07T03:04:05.000Z'),
        },
      ],
    },
    fetchCalls: 2,
  });
  expectMalformed(errA);
  expectMalformed(errB);
});

// ---- 结束片之前就遇到畸形帧：中途片（finish_reason=null）上的完整累计 usage 30/1 照常计量 ----

const MID = TEXT_WITH_USAGE_30_1 + BAD + DONE;
const MID_THEN_STOP = TEXT_WITH_USAGE_30_1 + BAD + STOP_WITH_USAGE_64_9 + DONE;
const MID_NONE = TEXT + BAD + DONE;
const MID_SPLITS: readonly (readonly [string, string, number[]])[] = [
  ['30/1 与畸形帧同一次读取', MID, []],
  ['30/1 后切开、畸形帧在下一次读取', MID, [byteAt(MID, BAD)]],
  ['畸形帧之后才有结束片 64/9 与 [DONE]，整段一次读取', MID_THEN_STOP, []],
  [
    '畸形帧之后才有结束片 64/9，畸形帧前后各切一次',
    MID_THEN_STOP,
    [byteAt(MID_THEN_STOP, BAD), byteAt(MID_THEN_STOP, STOP_WITH_USAGE_64_9)],
  ],
];

const ALLOWED_OWN = ['stack', 'message', 'name', 'kind', 'status', 'vendorCode', 'usage'];

function entry30x1(purpose: Purpose) {
  return {
    vendor: 'qwen',
    purpose,
    use: purpose === 'offline' ? 'eval_compare' : null,
    model: 'qwen-flash-2026-09-01',
    input_tokens: 30,
    output_tokens: 1,
    recorded_at: new Date('2026-10-07T03:04:05.000Z'),
  };
}

/** 错误只暴露分类 / 状态 / 厂商短码 / 数值用量；extra 列出多出的自有属性。 */
function failure(err: unknown) {
  const e = expectMalformed(err);
  return {
    kind: e.kind,
    status: e.status,
    vendorCode: e.vendorCode,
    usage: e.usage,
    extra: Object.getOwnPropertyNames(e).filter((name) => !ALLOWED_OWN.includes(name)),
  };
}

it.each(['online', 'offline'] as const)(
  '[BR-AI-14 多厂商接入 计量][AC-B3-02h-005#6][AC-B3-02h-003#11] 真实网关 %s 调用：尚无结束片时中途片带完整有效 usage 30/1（finish_reason=null）后遇畸形帧，与畸形帧同一次读取、有效帧后切开、畸形帧之后才有结束片 64/9（整段或前后各切），都以 malformed 失败（status 与厂商短码为空、不含原文与凭据）、错误 usage 都是 30/1，本用途恰记一条 30/1、另一计量去处不写；没有 usage 也没有结束片时 usage 为 null、两处都不写；同一网关先 30/1 合块失败、再无 usage 失败，第二次 usage 为 null、不新增计量',
  async (purpose) => {
    const got: Record<string, unknown> = {};
    for (const [name, text, cuts] of MID_SPLITS) {
      const c = chain(text, cuts);
      const err = await rejection(() => c.gateway.invoke(call(purpose)));
      const [hit, other] = sinks(c, purpose);
      got[name] = {
        ...failure(err),
        fetchCalls: c.f.calls.length,
        hit: hit.entries,
        other: other.entries,
      };
    }
    {
      const c = chain(MID_NONE, []);
      const err = await rejection(() => c.gateway.invoke(call(purpose)));
      const [hit, other] = sinks(c, purpose);
      got['没有 usage 也没有结束片'] = { ...failure(err), hit: hit.entries, other: other.entries };
    }
    {
      const c = scriptedChain([
        [MID, []],
        [MID_NONE, []],
      ]);
      const [hit, other] = sinks(c, purpose);
      const serial: unknown[] = [];
      for (let i = 0; i < 2; i += 1) {
        const err = await rejection(() => c.gateway.invoke(call(purpose)));
        serial.push({
          usage: failure(err).usage,
          hit: [...hit.entries],
          other: [...other.entries],
        });
      }
      got['同一网关连续两次'] = { serial, fetchCalls: c.f.calls.length };
    }

    const failed30x1 = {
      kind: 'malformed',
      status: null,
      vendorCode: null,
      usage: { input_tokens: 30, output_tokens: 1 },
      extra: [],
      fetchCalls: 1,
      hit: [entry30x1(purpose)],
      other: [],
    };
    expect(got).toEqual({
      '30/1 与畸形帧同一次读取': failed30x1,
      '30/1 后切开、畸形帧在下一次读取': failed30x1,
      '畸形帧之后才有结束片 64/9 与 [DONE]，整段一次读取': failed30x1,
      '畸形帧之后才有结束片 64/9，畸形帧前后各切一次': failed30x1,
      '没有 usage 也没有结束片': {
        kind: 'malformed',
        status: null,
        vendorCode: null,
        usage: null,
        extra: [],
        hit: [],
        other: [],
      },
      同一网关连续两次: {
        serial: [
          { usage: { input_tokens: 30, output_tokens: 1 }, hit: [entry30x1(purpose)], other: [] },
          { usage: null, hit: [entry30x1(purpose)], other: [] },
        ],
        fetchCalls: 2,
      },
    });
  },
);

// ---- 跨厂商：真实 GLM 离线链（vendor=glm、quirksFor('glm') 的 HTTP 传输 + 真实网关）----
// GLM 只登记了离线用途，这里不构造 GLM 线上调用。offlineBudgetApproved: ['glm'] 只是注入本测试网关的假配置
// （与 model-metering/gateway.test.ts 同口径），不代表真实额度或授权；fetch 与 .invalid 地址都是合成的，不发生真实外发或付费。

const GLM_MODEL = 'glm-synthetic-0001';
const GLM_URL = 'https://synthetic-glm.invalid/api/paas/v4/chat/completions';
/** usage 挂在结束片上（GLM 形态）后接畸形帧。 */
const GLM_FAULT = TEXT + STOP_WITH_USAGE_64_9 + BAD + DONE;

function glmOfflineCall(): VendorCall {
  return {
    purpose: 'offline',
    vendor: 'glm',
    model: GLM_MODEL,
    use: 'review_scoring',
    accessPath: 'zhipu_open',
    workspace: 'ws-synthetic-glm-review',
    dataClass: 'synthetic',
    body: {
      model: GLM_MODEL,
      messages: [{ role: 'user', content: '合成：给这段合成回答打分' }],
      tools: [],
      stream: true,
      stream_options: { include_usage: true },
    },
  };
}

/** 真实网关 + 真实 GLM 配置的 HTTP 传输；respond 决定每次 fetch 的合成响应。 */
function glmChain(respond: () => Promise<FetchResponseLike>) {
  const online = new MemorySink();
  const offline = new MemorySink();
  const f = fakeFetch(respond);
  const transport = createHttpTransport({
    vendor: 'glm',
    baseUrl: 'https://synthetic-glm.invalid/api/paas/v4',
    apiKey: fakeApiKey,
    fetch: f.fetch,
    quirks: quirksFor('glm'),
  });
  const gateway = createVendorGateway({
    transport,
    clock: gatewayClock,
    onlineMeter: online,
    offlineMeter: offline,
    offlineBudgetApproved: ['glm'],
    rewrittenSampleGrants: [],
    ownerAggregateApprovals: [],
  });
  return { online, offline, gateway, f };
}

function glmEntry(input: number, output: number) {
  return {
    vendor: 'glm',
    purpose: 'offline',
    use: 'review_scoring',
    model: 'glm-synthetic-0001',
    input_tokens: input,
    output_tokens: output,
    recorded_at: new Date('2026-10-07T03:04:05.000Z'),
  };
}

const LEAK_PROBES: readonly (readonly [string, string])[] = [
  ['apiKey', fakeApiKey()],
  ['探针', PROBE],
  ['正文', '合成回答'],
];

/** 不在中途断言：把分类、状态、厂商短码、用量、多出的自有属性与泄露项都收进结果，最后整体比对。 */
function summary(err: unknown) {
  if (!(err instanceof ModelProtocolError)) return { error: 'not_model_protocol_error' };
  const seen = exposedText(err);
  return {
    kind: err.kind,
    status: err.status,
    vendorCode: err.vendorCode,
    usage: err.usage,
    extra: Object.getOwnPropertyNames(err).filter((name) => !ALLOWED_OWN.includes(name)),
    leaks: LEAK_PROBES.filter(([, probe]) => seen.includes(probe)).map(([label]) => label),
  };
}

type Usage = { input_tokens: number; output_tokens: number } | null;

function glmFailed(usage: Usage) {
  return { kind: 'malformed', status: null, vendorCode: null, usage, extra: [], leaks: [] };
}

const GLM_CASES: readonly (readonly [string, string, number[], Usage])[] = [
  ['独立 usage 帧 64/9 与畸形帧同一次读取', FAULT, [], { input_tokens: 64, output_tokens: 9 }],
  [
    '独立 usage 帧 64/9 后切开、畸形帧在下一次读取',
    FAULT,
    [byteAt(FAULT, BAD)],
    { input_tokens: 64, output_tokens: 9 },
  ],
  ['结束片带 64/9 与畸形帧同一次读取', GLM_FAULT, [], { input_tokens: 64, output_tokens: 9 }],
  [
    '结束片带 64/9 后切开、畸形帧在下一次读取',
    GLM_FAULT,
    [byteAt(GLM_FAULT, BAD)],
    { input_tokens: 64, output_tokens: 9 },
  ],
  ['先 30/1 后 64/9 再畸形帧，整段一次读取', NEWER, [], { input_tokens: 64, output_tokens: 9 }],
  [
    '30/1 在前一次读取，64/9 与畸形帧同一次读取',
    NEWER,
    [byteAt(NEWER, STOP_WITH_USAGE_64_9)],
    { input_tokens: 64, output_tokens: 9 },
  ],
  ['64/9、畸形帧、64/12，整段一次读取', LATER, [], { input_tokens: 64, output_tokens: 9 }],
  [
    '64/9、畸形帧、64/12，切在畸形帧之后',
    LATER,
    [byteAt(LATER, USAGE_64_12)],
    { input_tokens: 64, output_tokens: 9 },
  ],
  ['64/0 与畸形帧同一次读取', ZERO_OUTPUT, [], { input_tokens: 64, output_tokens: 0 }],
  ['没有 usage，整段一次读取', NO_USAGE, [], null],
  ['畸形帧前没有 usage、之后有 64/12，整段一次读取', LATER_ONLY, [], null],
];

it('[BR-AI-14 多厂商接入 计量][AC-B3-02h-005#7][AC-B3-02h-003#14] 真实网关 + 真实 GLM 配置的 HTTP 传输，GLM 离线调用（合成数据、评审打分、假额度配置）：独立 usage 帧或结束片带 64/9 之后遇畸形帧，同一次读取或有效帧后切开，先 30/1 后 64/9（整段或 30/1 在前一次读取），64/9、畸形帧、64/12（整段或切在畸形帧后），都以 malformed 失败（status 与厂商短码为空、不含原文与凭据）、错误 usage 64/9，离线恰记一条 GLM 64/9、线上不写；64/0 恰记一条 64/0；畸形帧前没有 usage 时 usage 为 null、两处都不写；[DONE] 之后的畸形帧照常成功、离线恰记一条 64/9', async () => {
  const got: Record<string, unknown> = {};
  for (const [name, text, cuts] of GLM_CASES) {
    const c = glmChain(() => Promise.resolve(streamResponse(200, text, cuts)));
    const err = await rejection(() => c.gateway.invoke(glmOfflineCall()));
    got[name] = {
      ...summary(err),
      urls: c.f.calls.map((x) => x.url),
      offline: c.offline.entries,
      online: c.online.entries,
    };
  }
  {
    const c = glmChain(() =>
      Promise.resolve(streamResponse(200, TEXT + STOP + USAGE_64_9 + DONE + BAD, [])),
    );
    let result: unknown;
    try {
      result = { usage: (await c.gateway.invoke(glmOfflineCall())).usage };
    } catch (error) {
      result = summary(error);
    }
    got['[DONE] 之后跟畸形帧'] = {
      result,
      urls: c.f.calls.map((x) => x.url),
      offline: c.offline.entries,
      online: c.online.entries,
    };
  }

  expect(got).toEqual({
    ...Object.fromEntries(
      GLM_CASES.map(([name, , , usage]) => [
        name,
        {
          ...glmFailed(usage),
          urls: [GLM_URL],
          offline: usage === null ? [] : [glmEntry(usage.input_tokens, usage.output_tokens)],
          online: [],
        },
      ]),
    ),
    '[DONE] 之后跟畸形帧': {
      result: { usage: { input_tokens: 64, output_tokens: 9 } },
      urls: [GLM_URL],
      offline: [glmEntry(64, 9)],
      online: [],
    },
  });
});

it('[BR-AI-14 多厂商接入 计量][AC-B3-02h-005#8][AC-B3-02h-003#15] 同一个真实网关与真实 GLM 配置的 HTTP 传输连续四次 GLM 离线调用：64/9 与畸形帧同一次读取、没有 usage、先 30/1 后 64/9 与畸形帧同一次读取、畸形帧前没有 usage 而之后有 64/12，都以 malformed 失败；错误 usage 依次是 64/9、null、64/9、null，离线依次累计为一条、一条、两条、两条 GLM 64/9，线上始终不写', async () => {
  const script: (readonly [string, number[]])[] = [
    [FAULT, []],
    [NO_USAGE, []],
    [NEWER, []],
    [LATER_ONLY, []],
  ];
  const c = glmChain(() => {
    const next = script.shift();
    if (next === undefined) return Promise.reject(new Error('unscripted fetch'));
    return Promise.resolve(streamResponse(200, next[0], next[1]));
  });
  const got: unknown[] = [];
  for (let i = 0; i < 4; i += 1) {
    const err = await rejection(() => c.gateway.invoke(glmOfflineCall()));
    got.push({
      ...summary(err),
      offline: [...c.offline.entries],
      online: [...c.online.entries],
    });
  }
  expect({ got, urls: c.f.calls.map((x) => x.url) }).toEqual({
    got: [
      {
        ...glmFailed({ input_tokens: 64, output_tokens: 9 }),
        offline: [glmEntry(64, 9)],
        online: [],
      },
      { ...glmFailed(null), offline: [glmEntry(64, 9)], online: [] },
      {
        ...glmFailed({ input_tokens: 64, output_tokens: 9 }),
        offline: [glmEntry(64, 9), glmEntry(64, 9)],
        online: [],
      },
      { ...glmFailed(null), offline: [glmEntry(64, 9), glmEntry(64, 9)], online: [] },
    ],
    urls: [GLM_URL, GLM_URL, GLM_URL, GLM_URL],
  });
});
