// HTTP 传输在 SSE 畸形帧上的失败计量（B3-02h）：BR-AI-14 细则「多厂商接入」（调用费用按厂商独立计量）；
// 与 B3-02b 约定：ModelProtocolError.usage 为已收到的有效累计用量，null 表示未知、不能按零计费。
// 同一份响应字节不论被网络切成几次读取，失败时带出的已知有效累计用量都相同；仍以 malformed 失败，不把部分输出当成功。
// 只用注入的假 fetch 与异步字节流控制每次读取的边界，真实 createHttpTransport + SSE 解析；不联网、不监听端口。
// 千问与 GLM 两套真实厂商配置（vendor + quirksFor）各跑同一批合成帧，厂商不改变失败用量。
// 期望用量一律是独立字面量；切分位置只按测试自己的文本算字节偏移，不由被测实现得出。
import { expect, it } from 'vitest';
import {
  ModelProtocolError,
  createHttpTransport,
  quirksFor,
} from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import type { FetchLike } from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import type { VendorRequest } from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import { exposedText, fakeApiKey, fakeFetch, streamResponse } from '../model-openai-compat/kit.ts';

const BASE = 'https://synthetic-model.invalid/compatible-mode/v1';
const MODEL = 'qwen-flash-2025-07-28';

// ---- 合成 SSE 帧（每帧以空行结束） ----
const TEXT =
  'data: {"id":"chatcmpl-synthetic","choices":[{"index":0,"delta":{"content":"合成回答"},"finish_reason":null}]}\n\n';
const STOP =
  'data: {"id":"chatcmpl-synthetic","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';
const USAGE_64_9 =
  'data: {"id":"chatcmpl-synthetic","choices":[],"usage":{"prompt_tokens":64,"completion_tokens":9,"total_tokens":73}}\n\n';
/** usage 挂在结束片上（GLM 形态）。 */
const STOP_WITH_USAGE_64_9 =
  'data: {"id":"chatcmpl-synthetic","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":64,"completion_tokens":9,"total_tokens":73}}\n\n';
/** 中途片带较旧的累计用量。 */
const TEXT_WITH_USAGE_30_1 =
  'data: {"id":"chatcmpl-synthetic","choices":[{"index":0,"delta":{"content":"合成回答"},"finish_reason":null}],"usage":{"prompt_tokens":30,"completion_tokens":1,"total_tokens":31}}\n\n';
/** 畸形帧：JSON 未闭合；其中的探针文字不得出现在错误里。 */
const PROBE = '合成残片探针Q7';
const BAD = `data: {"id":"chatcmpl-synthetic","choices":[{"index":0,"delta":{"content":"${PROBE}"\n\n`;
/** 截断的 usage 帧：本身就是畸形 JSON，不能算作有效用量。 */
const BAD_USAGE =
  'data: {"id":"chatcmpl-synthetic","choices":[],"usage":{"prompt_tokens":64,"completion_tokens":9\n\n';
const DONE = 'data: [DONE]\n\n';

/** 能解析为 JSON 但 usage 无效的帧。 */
const INVALID_USAGE_FRAMES = {
  'prompt_tokens 为负数':
    'data: {"choices":[],"usage":{"prompt_tokens":-1,"completion_tokens":12,"total_tokens":11}}\n\n',
  'completion_tokens 为字符串':
    'data: {"choices":[],"usage":{"prompt_tokens":80,"completion_tokens":"12","total_tokens":92}}\n\n',
  'prompt_tokens 为小数':
    'data: {"choices":[],"usage":{"prompt_tokens":70.5,"completion_tokens":12,"total_tokens":82.5}}\n\n',
  '缺 completion_tokens': 'data: {"choices":[],"usage":{"prompt_tokens":80,"total_tokens":80}}\n\n',
  'usage 是字符串': 'data: {"choices":[],"usage":"80/12"}\n\n',
} as const;
type InvalidName = keyof typeof INVALID_USAGE_FRAMES;
const INVALID_NAMES = Object.keys(INVALID_USAGE_FRAMES) as InvalidName[];

/** 文本中 marker 起点的 UTF-8 字节偏移，再加 plus。 */
function byteAt(text: string, marker: string, plus = 0): number {
  const i = text.indexOf(marker);
  if (i < 0) throw new Error(`marker missing: ${marker}`);
  return new TextEncoder().encode(text.slice(0, i)).length + plus;
}

function everyByte(text: string): number[] {
  const length = new TextEncoder().encode(text).length;
  return Array.from({ length: length - 1 }, (_, i) => i + 1);
}

function http(fetch: FetchLike) {
  return createHttpTransport({
    vendor: 'qwen',
    baseUrl: BASE,
    apiKey: fakeApiKey,
    fetch,
    quirks: quirksFor('qwen'),
  });
}

function request(): VendorRequest {
  return {
    vendor: 'qwen',
    model: MODEL,
    body: {
      model: MODEL,
      messages: [{ role: 'user', content: '合成：找保温杯' }],
      tools: [],
      stream: true,
      stream_options: { include_usage: true },
    },
  };
}

/** 以给定字节切分发送一次；返回拒绝原因，或 { resolved } 包装的成功值。 */
async function sendWith(text: string, cuts: number[]): Promise<unknown> {
  const f = fakeFetch(() => Promise.resolve(streamResponse(200, text, cuts)));
  try {
    return { resolved: await http(f.fetch).send(request()) };
  } catch (error) {
    return error;
  }
}

const ALLOWED_OWN = ['stack', 'message', 'name', 'kind', 'status', 'vendorCode', 'usage'];

/** 失败必须是 malformed 协议错误，只暴露分类 / 状态 / 厂商短码 / 数值用量，不带原文与凭据。 */
function expectMalformed(err: unknown): ModelProtocolError {
  expect(err).toBeInstanceOf(ModelProtocolError);
  const e = err as ModelProtocolError;
  expect(e.kind).toBe('malformed');
  expect(e.status).toBeNull();
  expect(e.vendorCode).toBeNull();
  for (const name of Object.getOwnPropertyNames(e)) expect(ALLOWED_OWN).toContain(name);
  const seen = exposedText(e);
  for (const secret of [fakeApiKey(), PROBE, '合成回答', 'chatcmpl-synthetic']) {
    expect(seen).not.toContain(secret);
  }
  return e;
}

/** 以给定切分发送一次，要求 malformed 失败，返回错误上的 usage。 */
async function malformedUsage(text: string, cuts: number[]): Promise<unknown> {
  return expectMalformed(await sendWith(text, cuts)).usage;
}

/** 同一组里每个输入的期望都相同时，按名字展开成对照表。 */
function sameFor(names: readonly string[], usage: unknown): Record<string, unknown> {
  return Object.fromEntries(names.map((name) => [name, usage]));
}

// 每个测试把同一规则下的全部输入都跑完再整体比对，失败时一次列出全部偏差；
// 切分之间的已知用量不一致本身就是缺陷。

// ---- ① 有效 usage 之后遇到畸形帧：任何切分都带出 64/9 ----

const FAULT = TEXT + STOP + USAGE_64_9 + BAD + DONE;
const FAULT_SPLITS: readonly (readonly [string, string, number[]])[] = [
  ['切在 usage 帧之后', FAULT, [byteAt(FAULT, BAD)]],
  ['切在畸形帧中间', FAULT, [byteAt(FAULT, BAD, 12)]],
  ['逐字节读取', FAULT, everyByte(FAULT)],
  ['整段一次读取', FAULT, []],
  ['CRLF 换行、整段一次读取', FAULT.replace(/\n/g, '\r\n'), []],
  ['切在「合成回答」汉字中间，其余一次读取', FAULT, [byteAt(FAULT, '成回答', -1)]],
  ['切在 usage JSON 中间', FAULT, [byteAt(FAULT, '"completion_tokens":9')]],
  ['切在 usage 帧结尾两个换行之间', FAULT, [byteAt(FAULT, BAD, -1)]],
  ['usage 在结束片上、整段一次读取', TEXT + STOP_WITH_USAGE_64_9 + BAD + DONE, []],
];

it('[BR-AI-14][AC-B3-02h-001] 有效 usage 64/9 之后遇到畸形帧，不论九种读取方式（usage 与畸形帧分开读或同一次读、CRLF、usage 在结束片上）：都以 malformed 失败、不含原文与凭据，错误 usage 都是 64/9', async () => {
  const got: Record<string, unknown> = {};
  for (const [name, text, cuts] of FAULT_SPLITS) got[name] = await malformedUsage(text, cuts);
  expect(got).toEqual(
    sameFor(
      FAULT_SPLITS.map(([name]) => name),
      { input_tokens: 64, output_tokens: 9 },
    ),
  );
});

// ---- ①③ 首个畸形帧即终点：之后的有效 usage 不论在哪次读取里，都不算进失败用量 ----

/** 畸形帧之后才出现的更新累计用量。 */
const USAGE_64_12 =
  'data: {"id":"chatcmpl-synthetic","choices":[],"usage":{"prompt_tokens":64,"completion_tokens":12,"total_tokens":76}}\n\n';
const LATER = TEXT + STOP + USAGE_64_9 + BAD + USAGE_64_12 + DONE;
const LATER_NEWER = TEXT_WITH_USAGE_30_1 + STOP_WITH_USAGE_64_9 + BAD + USAGE_64_12 + DONE;
const LATER_NO_DONE = TEXT + STOP + USAGE_64_9 + BAD + USAGE_64_12;
const LATER_ONLY = TEXT + STOP + BAD + USAGE_64_12 + DONE;
const LATER_KNOWN: readonly (readonly [string, string, number[]])[] = [
  ['64/9、畸形帧、64/12 整段一次读取', LATER, []],
  ['64/9、畸形帧、64/12，CRLF 换行、整段一次读取', LATER.replace(/\n/g, '\r\n'), []],
  ['64/9、畸形帧、64/12，切在畸形帧之后', LATER, [byteAt(LATER, USAGE_64_12)]],
  [
    '64/9、畸形帧、64/12，切在 64/12 的 JSON 中间',
    LATER,
    [byteAt(LATER, '"completion_tokens":12')],
  ],
  [
    '64/9、畸形帧、64/12，畸形帧前后各切一次',
    LATER,
    [byteAt(LATER, BAD), byteAt(LATER, USAGE_64_12)],
  ],
  ['64/9、畸形帧、64/12，逐字节读取', LATER, everyByte(LATER)],
  ['先 30/1 后 64/9、畸形帧、64/12，整段一次读取', LATER_NEWER, []],
  ['64/9、畸形帧、64/12 后没有 [DONE]，整段一次读取', LATER_NO_DONE, []],
];
const LATER_UNKNOWN: readonly (readonly [string, string, number[]])[] = [
  ['畸形帧前没有 usage、之后有 64/12，整段一次读取', LATER_ONLY, []],
  [
    '畸形帧前没有 usage、之后有 64/12，切在畸形帧之后',
    LATER_ONLY,
    [byteAt(LATER_ONLY, USAGE_64_12)],
  ],
];

it('[BR-AI-14][AC-B3-02h-001#3][AC-B3-02h-003#8] 有效 usage 64/9、畸形帧、随后又有有效 usage 64/12 与 [DONE]：整段一次读取、CRLF、切在畸形帧之后、切在 64/12 中间、畸形帧前后各切、逐字节、先 30/1 后 64/9、没有 [DONE]，都以 malformed 失败、错误 usage 都是 64/9（不是 64/12，也不相加）；畸形帧前没有有效 usage 时，整段或切开读取都是 null，不借用之后的 64/12', async () => {
  const got: Record<string, unknown> = {};
  for (const [name, text, cuts] of [...LATER_KNOWN, ...LATER_UNKNOWN]) {
    got[name] = await malformedUsage(text, cuts);
  }
  expect(got).toEqual({
    ...sameFor(
      LATER_KNOWN.map(([name]) => name),
      { input_tokens: 64, output_tokens: 9 },
    ),
    ...sameFor(
      LATER_UNKNOWN.map(([name]) => name),
      null,
    ),
  });
});

// ---- ② 先前读取给过较旧累计 usage：取新值，不相加 ----

const NEWER = TEXT_WITH_USAGE_30_1 + STOP_WITH_USAGE_64_9 + BAD + DONE;
const NEWER_SPLITS: readonly (readonly [string, number[]])[] = [
  ['旧 usage 在前一次读取，新 usage 与畸形帧同一次读取', [byteAt(NEWER, STOP_WITH_USAGE_64_9)]],
  ['整段一次读取', []],
  ['新 usage 帧切在 JSON 中间', [byteAt(NEWER, '"prompt_tokens":64')]],
];

it('[BR-AI-14][AC-B3-02h-002] 先有累计 usage 30/1、后有 64/9 再遇畸形帧，三种读取方式：错误 usage 都取最新的 64/9，不是 30/1，也不是相加的 94/10', async () => {
  const got: Record<string, unknown> = {};
  for (const [name, cuts] of NEWER_SPLITS) got[name] = await malformedUsage(NEWER, cuts);
  expect(got).toEqual(
    sameFor(
      NEWER_SPLITS.map(([name]) => name),
      { input_tokens: 64, output_tokens: 9 },
    ),
  );
});

// ---- ③ 没有完整有效 usage：保持 null；完整 usage 之后的截断 usage 帧不抹掉它 ----

const NO_USAGE = TEXT + STOP + BAD + DONE;
const TRUNCATED_ONLY = TEXT + STOP + BAD_USAGE + DONE;
const UNKNOWN_CASES: readonly (readonly [string, string, number[]])[] = [
  ['没有 usage 帧、整段一次读取', NO_USAGE, []],
  ['没有 usage 帧、逐字节读取', NO_USAGE, everyByte(NO_USAGE)],
  ['usage 帧本身被截断、整段一次读取', TRUNCATED_ONLY, []],
  [
    'usage 帧本身被截断、切在截断处之前',
    TRUNCATED_ONLY,
    [byteAt(TRUNCATED_ONLY, '"completion_tokens":9')],
  ],
  [
    '只有无效 usage（prompt_tokens 为字符串）后接畸形帧',
    TEXT +
      STOP +
      'data: {"choices":[],"usage":{"prompt_tokens":"64","completion_tokens":9,"total_tokens":73}}\n\n' +
      BAD +
      DONE,
    [],
  ],
];
const KNOWN_THEN_TRUNCATED = TEXT + STOP + USAGE_64_9 + BAD_USAGE + DONE;
const KNOWN_CASES: readonly (readonly [string, string, number[]])[] = [
  [
    '完整 64/9 后接截断的 usage 帧、在截断帧前切开',
    KNOWN_THEN_TRUNCATED,
    [byteAt(KNOWN_THEN_TRUNCATED, BAD_USAGE)],
  ],
  ['完整 64/9 后接截断的 usage 帧、整段一次读取', KNOWN_THEN_TRUNCATED, []],
];

it('[BR-AI-14][AC-B3-02h-003] 失败用量只认完整有效的 usage 帧：没有 usage、usage 帧被截断、只有无效 usage 时为 null（未知，不当作零）；完整 64/9 之后再来截断的 usage 帧时，不论分开读还是同一次读都是 64/9', async () => {
  const got: Record<string, unknown> = {};
  for (const [name, text, cuts] of [...UNKNOWN_CASES, ...KNOWN_CASES]) {
    got[name] = await malformedUsage(text, cuts);
  }
  expect(got).toEqual({
    ...sameFor(
      UNKNOWN_CASES.map(([name]) => name),
      null,
    ),
    ...sameFor(
      KNOWN_CASES.map(([name]) => name),
      { input_tokens: 64, output_tokens: 9 },
    ),
  });
});

// ---- ⑥ 无效 usage 不得覆盖此前的有效 usage ----

it.each(INVALID_NAMES)(
  '[BR-AI-14][AC-B3-02h-006][AC-B3-02h-006#2] 有效 usage 64/9 之后出现无效 usage（%s）：没有畸形帧且正常 [DONE]、后接畸形帧且在有效 usage 后切开、后接畸形帧且整段一次读取，都以 malformed 失败，错误 usage 仍是 64/9',
  async (name) => {
    const invalid = INVALID_USAGE_FRAMES[name];
    const withBad = TEXT + STOP + USAGE_64_9 + invalid + BAD + DONE;
    const cases: readonly (readonly [string, string, number[]])[] = [
      ['没有畸形帧、正常 [DONE]', TEXT + STOP + USAGE_64_9 + invalid + DONE, []],
      ['后接畸形帧、有效 usage 后切开', withBad, [byteAt(withBad, invalid)]],
      ['后接畸形帧、整段一次读取', withBad, []],
    ];
    const got: Record<string, unknown> = {};
    for (const [label, text, cuts] of cases) got[label] = await malformedUsage(text, cuts);
    expect(got).toEqual(
      sameFor(
        cases.map(([label]) => label),
        { input_tokens: 64, output_tokens: 9 },
      ),
    );
  },
);

// ---- ④ 成功与结束语义不变：[DONE] 是成功的边界 ----

function successChunks() {
  return [
    {
      id: 'chatcmpl-synthetic',
      choices: [{ index: 0, delta: { content: '合成回答' }, finish_reason: null }],
    },
    { id: 'chatcmpl-synthetic', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    {
      id: 'chatcmpl-synthetic',
      choices: [],
      usage: { prompt_tokens: 64, completion_tokens: 9, total_tokens: 73 },
    },
  ];
}

const TRAILER = 'data: {"after":"done"}\n\n';
const AFTER_DONE = TEXT + STOP + USAGE_64_9 + DONE + BAD + TRAILER;
/** 同样的帧，只把畸形帧挪到 [DONE] 之前。 */
const BEFORE_DONE = TEXT + STOP + USAGE_64_9 + BAD + DONE + TRAILER;

it('[BR-AI-14][AC-B3-02h-004] [DONE] 是成功边界：畸形帧与多余数据在 [DONE] 之后时，四种读取方式都成功返回 [DONE] 之前的三片与 usage 64/9；同样的帧把畸形帧挪到 [DONE] 之前、整段一次读取时以 malformed 失败，错误 usage 64/9', async () => {
  const successSplits: readonly (readonly [string, number[]])[] = [
    ['整段一次读取', []],
    ['切在 [DONE] 之前', [byteAt(AFTER_DONE, DONE)]],
    [
      '[DONE] 与之后的垃圾同一次读取、其余逐段',
      [byteAt(AFTER_DONE, STOP), byteAt(AFTER_DONE, DONE)],
    ],
    ['逐字节读取', everyByte(AFTER_DONE)],
  ];
  const got: Record<string, unknown> = {};
  for (const [name, cuts] of successSplits) got[name] = await sendWith(AFTER_DONE, cuts);
  got['畸形帧在 [DONE] 之前、整段一次读取'] = await malformedUsage(BEFORE_DONE, []);
  expect(got).toEqual({
    ...sameFor(
      successSplits.map(([name]) => name),
      { resolved: { chunks: successChunks(), usage: { input_tokens: 64, output_tokens: 9 } } },
    ),
    '畸形帧在 [DONE] 之前、整段一次读取': { input_tokens: 64, output_tokens: 9 },
  });
});

const ENDS_EARLY: readonly (readonly [string, string])[] = [
  ['有效 usage 后直接结束', TEXT + STOP + USAGE_64_9],
  ['有效 usage 后是不带结尾空行的畸形帧', TEXT + STOP + USAGE_64_9 + BAD.replace(/\n\n$/, '')],
  ['有效 usage 后是完整的畸形帧', TEXT + STOP + USAGE_64_9 + BAD],
];

it('[BR-AI-14][AC-B3-02h-004#2] 流在 [DONE] 之前结束不当作成功：有效 usage 后直接结束、后接不带结尾空行的畸形帧、后接完整的畸形帧，整段一次读取或在 usage 帧前切开，都以 malformed 失败，错误 usage 是 64/9', async () => {
  const got: Record<string, unknown> = {};
  for (const [name, text] of ENDS_EARLY) {
    got[`${name}、在 usage 帧前切开`] = await malformedUsage(text, [byteAt(text, USAGE_64_9)]);
    got[`${name}、整段一次读取`] = await malformedUsage(text, []);
  }
  expect(got).toEqual(
    sameFor(
      ENDS_EARLY.flatMap(([name]) => [`${name}、在 usage 帧前切开`, `${name}、整段一次读取`]),
      { input_tokens: 64, output_tokens: 9 },
    ),
  );
});

// ---- ①③ 已计输入、尚无输出的完整 usage 64/0 同样是已知用量，不当作未知 ----

const USAGE_64_0 =
  'data: {"id":"chatcmpl-synthetic","choices":[],"usage":{"prompt_tokens":64,"completion_tokens":0,"total_tokens":64}}\n\n';
const ZERO_OUTPUT = STOP + USAGE_64_0 + BAD + DONE;
const ZERO_OUTPUT_SPLITS: readonly (readonly [string, number[]])[] = [
  ['usage 与畸形帧同一次读取', []],
  ['切在 usage 帧之后', [byteAt(ZERO_OUTPUT, BAD)]],
  ['切在畸形帧中间', [byteAt(ZERO_OUTPUT, BAD, 12)]],
  ['逐字节读取', everyByte(ZERO_OUTPUT)],
];

it('[BR-AI-14][AC-B3-02h-001#2][AC-B3-02h-003#3] 完整有效 usage 64/0（已计输入、尚无输出）之后遇到畸形帧，四种读取方式（与畸形帧同一次读、在畸形帧前切开、切在畸形帧中间、逐字节）：都以 malformed 失败、不含原文与凭据，错误 usage 都是 64/0，不是 null', async () => {
  const got: Record<string, unknown> = {};
  for (const [name, cuts] of ZERO_OUTPUT_SPLITS) {
    got[name] = await malformedUsage(ZERO_OUTPUT, cuts);
  }
  expect(got).toEqual(
    sameFor(
      ZERO_OUTPUT_SPLITS.map(([name]) => name),
      { input_tokens: 64, output_tokens: 0 },
    ),
  );
});

// ---- ③ 同一个 transport 连续复用：每次失败只带本次响应里的已知用量 ----

/** 同一个 fetch 依次给出脚本里的响应；脚本用完后以普通错误拒绝。 */
function scriptedFetch(script: readonly (readonly [string, string, number[]])[]) {
  const queue = [...script];
  return fakeFetch(() => {
    const next = queue.shift();
    if (next === undefined) return Promise.reject(new Error('unscripted fetch'));
    return Promise.resolve(streamResponse(200, next[1], next[2]));
  });
}

const REUSE_SCRIPT: readonly (readonly [string, string, number[]])[] = [
  ['第 1 次：64/9 与畸形帧同一次读取', FAULT, []],
  ['第 2 次：没有 usage、整段一次读取', NO_USAGE, []],
  ['第 3 次：64/9 后在畸形帧前切开', FAULT, [byteAt(FAULT, BAD)]],
  ['第 4 次：usage 帧本身被截断、整段一次读取', TRUNCATED_ONLY, []],
];

it('[BR-AI-14][AC-B3-02h-003#4] 同一个 HTTP transport 连续发送四次：64/9 与畸形帧同一次读取、没有 usage、64/9 后分开读取、usage 帧被截断，都以 malformed 失败；错误 usage 依次是 64/9、null、64/9、null，前一次的用量不带进后一次', async () => {
  const f = scriptedFetch(REUSE_SCRIPT);
  const transport = http(f.fetch);
  const got: Record<string, unknown> = {};
  for (const [name] of REUSE_SCRIPT) {
    let outcome: unknown;
    try {
      outcome = { resolved: await transport.send(request()) };
    } catch (error) {
      outcome = error;
    }
    got[name] = expectMalformed(outcome).usage;
  }
  expect(f.calls).toHaveLength(4);
  expect(got).toEqual({
    '第 1 次：64/9 与畸形帧同一次读取': { input_tokens: 64, output_tokens: 9 },
    '第 2 次：没有 usage、整段一次读取': null,
    '第 3 次：64/9 后在畸形帧前切开': { input_tokens: 64, output_tokens: 9 },
    '第 4 次：usage 帧本身被截断、整段一次读取': null,
  });
});

// ---- ①②③ 结束片之前就遇到畸形帧：中途片（finish_reason=null）上的完整累计 usage 同样是已知用量 ----

/** 中途片带较新的累计用量，仍未结束。 */
const TEXT_WITH_USAGE_40_3 =
  'data: {"id":"chatcmpl-synthetic","choices":[{"index":0,"delta":{"content":"合成回答"},"finish_reason":null}],"usage":{"prompt_tokens":40,"completion_tokens":3,"total_tokens":43}}\n\n';
/** 中途片显式给 usage: null：本片没有上报用量，不是无效用量。 */
const TEXT_USAGE_NULL =
  'data: {"id":"chatcmpl-synthetic","choices":[{"index":0,"delta":{"content":"合成回答"},"finish_reason":null}],"usage":null}\n\n';

const MID = TEXT_WITH_USAGE_30_1 + BAD + DONE;
const MID_AFTER_TEXT = TEXT + TEXT_WITH_USAGE_30_1 + BAD + DONE;
const MID_THEN_STOP = TEXT_WITH_USAGE_30_1 + BAD + STOP_WITH_USAGE_64_9 + DONE;
const MID_USAGE_NULL = TEXT_WITH_USAGE_30_1 + TEXT_USAGE_NULL + BAD + DONE;
const MID_TRUNCATED = TEXT_WITH_USAGE_30_1 + BAD_USAGE + DONE;
const MID_KNOWN: readonly (readonly [string, string, number[]])[] = [
  ['30/1 与畸形帧同一次读取', MID, []],
  ['30/1 后切开、畸形帧在下一次读取', MID, [byteAt(MID, BAD)]],
  ['切在畸形帧中间', MID, [byteAt(MID, BAD, 12)]],
  ['逐字节读取', MID, everyByte(MID)],
  ['CRLF 换行、整段一次读取', MID.replace(/\n/g, '\r\n'), []],
  ['30/1 后畸形帧、没有 [DONE]，整段一次读取', TEXT_WITH_USAGE_30_1 + BAD, []],
  [
    '先有不带 usage 的文本片，在 30/1 帧前切开、30/1 与畸形帧同一次读取',
    MID_AFTER_TEXT,
    [byteAt(MID_AFTER_TEXT, TEXT_WITH_USAGE_30_1)],
  ],
  ['畸形帧之后才有结束片 64/9 与 [DONE]，整段一次读取', MID_THEN_STOP, []],
  [
    '畸形帧之后才有结束片 64/9，切在结束片之前',
    MID_THEN_STOP,
    [byteAt(MID_THEN_STOP, STOP_WITH_USAGE_64_9)],
  ],
  [
    '畸形帧之后才有结束片 64/9，畸形帧前后各切一次',
    MID_THEN_STOP,
    [byteAt(MID_THEN_STOP, BAD), byteAt(MID_THEN_STOP, STOP_WITH_USAGE_64_9)],
  ],
  ['30/1 后有 usage:null 的中途片再畸形帧，整段一次读取', MID_USAGE_NULL, []],
  ['30/1 后接截断的 usage 帧，整段一次读取', MID_TRUNCATED, []],
  ['30/1 后接截断的 usage 帧，在截断帧前切开', MID_TRUNCATED, [byteAt(MID_TRUNCATED, BAD_USAGE)]],
  ...INVALID_NAMES.map((name): readonly [string, string, number[]] => [
    `30/1 后接无效 usage（${name}）再畸形帧，整段一次读取`,
    TEXT_WITH_USAGE_30_1 + INVALID_USAGE_FRAMES[name] + BAD + DONE,
    [],
  ]),
];
const MID_NONE = TEXT + BAD + DONE;
const MID_LATER_ONLY = TEXT + BAD + TEXT_WITH_USAGE_30_1 + DONE;
const MID_UNKNOWN: readonly (readonly [string, string, number[]])[] = [
  ['没有 usage、也没有结束片，整段一次读取', MID_NONE, []],
  ['没有 usage、也没有结束片，逐字节读取', MID_NONE, everyByte(MID_NONE)],
  ['只有 usage:null 的中途片再畸形帧，整段一次读取', TEXT_USAGE_NULL + BAD + DONE, []],
  ['畸形帧前没有 usage、之后才有 30/1，整段一次读取', MID_LATER_ONLY, []],
  [
    '畸形帧前没有 usage、之后才有 30/1，切在畸形帧之后',
    MID_LATER_ONLY,
    [byteAt(MID_LATER_ONLY, TEXT_WITH_USAGE_30_1)],
  ],
];

it('[BR-AI-14][AC-B3-02h-001#4][AC-B3-02h-003#10] 尚无结束片时，中途片（finish_reason=null）带完整有效 usage 30/1 后遇畸形帧：与畸形帧同一次读取、在有效帧后或畸形帧中间切开、逐字节、CRLF、没有 [DONE]、前有文本片、畸形帧之后才有结束片 64/9（整段、切在结束片前、前后各切）、之后有 usage:null 片、截断或无效 usage 帧，都以 malformed 失败、不含原文与凭据，错误 usage 都是 30/1（不借用之后的 64/9）；畸形帧前没有完整有效 usage（含只有 usage:null）时，不论整段或切开读取都是 null，不借用之后的 30/1', async () => {
  const got: Record<string, unknown> = {};
  for (const [name, text, cuts] of [...MID_KNOWN, ...MID_UNKNOWN]) {
    got[name] = await malformedUsage(text, cuts);
  }
  expect(got).toEqual({
    ...sameFor(
      MID_KNOWN.map(([name]) => name),
      { input_tokens: 30, output_tokens: 1 },
    ),
    ...sameFor(
      MID_UNKNOWN.map(([name]) => name),
      null,
    ),
  });
});

const MID_NEWER = TEXT_WITH_USAGE_30_1 + TEXT_WITH_USAGE_40_3 + BAD + DONE;
const MID_NEWER_THEN_STOP =
  TEXT_WITH_USAGE_30_1 + TEXT_WITH_USAGE_40_3 + BAD + STOP_WITH_USAGE_64_9 + DONE;
const MID_NEWER_SPLITS: readonly (readonly [string, string, number[]])[] = [
  ['30/1、40/3 与畸形帧同一次读取', MID_NEWER, []],
  [
    '30/1 在前一次读取，40/3 与畸形帧同一次读取',
    MID_NEWER,
    [byteAt(MID_NEWER, TEXT_WITH_USAGE_40_3)],
  ],
  ['40/3 后切开、畸形帧在下一次读取', MID_NEWER, [byteAt(MID_NEWER, BAD)]],
  ['逐字节读取', MID_NEWER, everyByte(MID_NEWER)],
  ['畸形帧之后才有结束片 64/9，整段一次读取', MID_NEWER_THEN_STOP, []],
];

it('[BR-AI-14][AC-B3-02h-002#2] 尚无结束片时，中途片先后带累计 usage 30/1 与 40/3 再遇畸形帧，五种读取方式（整段、30/1 在前一次读取、40/3 后切开、逐字节、畸形帧后才有结束片 64/9）：都以 malformed 失败，错误 usage 都取最新的 40/3，不是 30/1、不是相加的 70/4，也不是畸形帧之后的 64/9', async () => {
  const got: Record<string, unknown> = {};
  for (const [name, text, cuts] of MID_NEWER_SPLITS) got[name] = await malformedUsage(text, cuts);
  expect(got).toEqual(
    sameFor(
      MID_NEWER_SPLITS.map(([name]) => name),
      { input_tokens: 40, output_tokens: 3 },
    ),
  );
});

// ---- 跨厂商：真实 GLM 配置的 HTTP 传输（vendor=glm、quirksFor('glm')）走同一故障语义 ----
// 只修千问、GLM 仍走旧路径的实现，在下面的同块读取上就会丢量。帧字节与上面千问用例相同，只换厂商配置；
// 假 fetch 与 .invalid 地址都是合成的，不发生真实外发。

const GLM_BASE = 'https://synthetic-glm.invalid/api/paas/v4';
const GLM_URL = 'https://synthetic-glm.invalid/api/paas/v4/chat/completions';
const GLM_MODEL = 'glm-synthetic-0001';

function glmHttp(fetch: FetchLike) {
  return createHttpTransport({
    vendor: 'glm',
    baseUrl: GLM_BASE,
    apiKey: fakeApiKey,
    fetch,
    quirks: quirksFor('glm'),
  });
}

function glmRequest(): VendorRequest {
  return {
    vendor: 'glm',
    model: GLM_MODEL,
    body: {
      model: GLM_MODEL,
      messages: [{ role: 'user', content: '合成：给这段合成回答打分' }],
      tools: [],
      stream: true,
      stream_options: { include_usage: true },
    },
  };
}

const LEAK_PROBES: readonly (readonly [string, string])[] = [
  ['apiKey', fakeApiKey()],
  ['探针', PROBE],
  ['正文', '合成回答'],
  ['分片 id', 'chatcmpl-synthetic'],
];

/** 不在中途断言：把分类、状态、厂商短码、用量、多出的自有属性与泄露项都收进结果，最后整体比对。 */
function outcomeOf(outcome: unknown) {
  if (!(outcome instanceof ModelProtocolError)) return { error: 'not_model_protocol_error' };
  const seen = exposedText(outcome);
  return {
    kind: outcome.kind,
    status: outcome.status,
    vendorCode: outcome.vendorCode,
    usage: outcome.usage,
    extra: Object.getOwnPropertyNames(outcome).filter((name) => !ALLOWED_OWN.includes(name)),
    leaks: LEAK_PROBES.filter(([, probe]) => seen.includes(probe)).map(([label]) => label),
  };
}

/** GLM 传输以给定切分发送一次；连同请求地址一起返回。 */
async function sendGlm(text: string, cuts: number[]) {
  const f = fakeFetch(() => Promise.resolve(streamResponse(200, text, cuts)));
  let outcome: unknown;
  try {
    outcome = { resolved: await glmHttp(f.fetch).send(glmRequest()) };
  } catch (error) {
    outcome = error;
  }
  return { ...outcomeOf(outcome), urls: f.calls.map((c) => c.url) };
}

type Usage = { input_tokens: number; output_tokens: number } | null;

function glmFailed(usage: Usage) {
  return {
    kind: 'malformed',
    status: null,
    vendorCode: null,
    usage,
    extra: [],
    leaks: [],
    urls: ['https://synthetic-glm.invalid/api/paas/v4/chat/completions'],
  };
}

/** usage 挂在结束片上（GLM 形态）后接畸形帧。 */
const GLM_FAULT = TEXT + STOP_WITH_USAGE_64_9 + BAD + DONE;
const GLM_CORE: readonly (readonly [string, string, number[], Usage])[] = [
  ['独立 usage 帧 64/9 与畸形帧同一次读取', FAULT, [], { input_tokens: 64, output_tokens: 9 }],
  [
    '独立 usage 帧 64/9 后切开、畸形帧在下一次读取',
    FAULT,
    [byteAt(FAULT, BAD)],
    { input_tokens: 64, output_tokens: 9 },
  ],
  [
    '独立 usage 帧 64/9，切在畸形帧中间',
    FAULT,
    [byteAt(FAULT, BAD, 12)],
    { input_tokens: 64, output_tokens: 9 },
  ],
  [
    '独立 usage 帧 64/9，逐字节读取',
    FAULT,
    everyByte(FAULT),
    { input_tokens: 64, output_tokens: 9 },
  ],
  [
    '独立 usage 帧 64/9，CRLF 换行、整段一次读取',
    FAULT.replace(/\n/g, '\r\n'),
    [],
    { input_tokens: 64, output_tokens: 9 },
  ],
  ['结束片带 64/9 与畸形帧同一次读取', GLM_FAULT, [], { input_tokens: 64, output_tokens: 9 }],
  [
    '结束片带 64/9 后切开、畸形帧在下一次读取',
    GLM_FAULT,
    [byteAt(GLM_FAULT, BAD)],
    { input_tokens: 64, output_tokens: 9 },
  ],
  [
    '结束片带 64/9，逐字节读取',
    GLM_FAULT,
    everyByte(GLM_FAULT),
    { input_tokens: 64, output_tokens: 9 },
  ],
  [
    '结束片带 64/9，CRLF 换行、整段一次读取',
    GLM_FAULT.replace(/\n/g, '\r\n'),
    [],
    { input_tokens: 64, output_tokens: 9 },
  ],
  ['64/0 与畸形帧同一次读取', ZERO_OUTPUT, [], { input_tokens: 64, output_tokens: 0 }],
  [
    '64/0 后切开、畸形帧在下一次读取',
    ZERO_OUTPUT,
    [byteAt(ZERO_OUTPUT, BAD)],
    { input_tokens: 64, output_tokens: 0 },
  ],
  ['没有 usage 帧、整段一次读取', NO_USAGE, [], null],
  ['没有 usage 帧、逐字节读取', NO_USAGE, everyByte(NO_USAGE), null],
  ['usage 帧本身被截断、整段一次读取', TRUNCATED_ONLY, [], null],
];

it('[BR-AI-14][AC-B3-02h-001#5][AC-B3-02h-003#12] 真实 GLM 配置的 HTTP 传输（vendor=glm、quirksFor(glm)）：独立 usage 帧或结束片带完整有效 64/9 之后遇畸形帧，与畸形帧同一次读取、有效帧后切开、切在畸形帧中间、逐字节、CRLF，都以 malformed 失败（status 与厂商短码为空、不含原文与凭据）、错误 usage 都是 64/9；64/0 同一次或分开读取都是 64/0；没有 usage、usage 帧被截断时为 null', async () => {
  const got: Record<string, unknown> = {};
  for (const [name, text, cuts] of GLM_CORE) got[name] = await sendGlm(text, cuts);
  expect(got).toEqual(
    Object.fromEntries(GLM_CORE.map(([name, , , usage]) => [name, glmFailed(usage)])),
  );
});

const GLM_ORDER: readonly (readonly [string, string, number[], Usage])[] = [
  ['先 30/1 后 64/9 再畸形帧，整段一次读取', NEWER, [], { input_tokens: 64, output_tokens: 9 }],
  [
    '30/1 在前一次读取，64/9 与畸形帧同一次读取',
    NEWER,
    [byteAt(NEWER, STOP_WITH_USAGE_64_9)],
    { input_tokens: 64, output_tokens: 9 },
  ],
  [
    '先 30/1 后 64/9 再畸形帧，逐字节读取',
    NEWER,
    everyByte(NEWER),
    { input_tokens: 64, output_tokens: 9 },
  ],
  ['尚无结束片、中途片 30/1 与畸形帧同一次读取', MID, [], { input_tokens: 30, output_tokens: 1 }],
  [
    '尚无结束片、中途片 30/1 后切开',
    MID,
    [byteAt(MID, BAD)],
    { input_tokens: 30, output_tokens: 1 },
  ],
  ['中途片 30/1、40/3 与畸形帧同一次读取', MID_NEWER, [], { input_tokens: 40, output_tokens: 3 }],
  [
    '中途片 30/1、畸形帧之后才有结束片 64/9，整段一次读取',
    MID_THEN_STOP,
    [],
    { input_tokens: 30, output_tokens: 1 },
  ],
  ['64/9、畸形帧、64/12，整段一次读取', LATER, [], { input_tokens: 64, output_tokens: 9 }],
  [
    '64/9、畸形帧、64/12，切在畸形帧之后',
    LATER,
    [byteAt(LATER, USAGE_64_12)],
    { input_tokens: 64, output_tokens: 9 },
  ],
  [
    '64/9、畸形帧、64/12，逐字节读取',
    LATER,
    everyByte(LATER),
    { input_tokens: 64, output_tokens: 9 },
  ],
  ['畸形帧前没有 usage、之后有 64/12，整段一次读取', LATER_ONLY, [], null],
  [
    '畸形帧前没有 usage、之后有 64/12，切在畸形帧之后',
    LATER_ONLY,
    [byteAt(LATER_ONLY, USAGE_64_12)],
    null,
  ],
  [
    '完整 64/9 后接截断的 usage 帧，整段一次读取',
    KNOWN_THEN_TRUNCATED,
    [],
    { input_tokens: 64, output_tokens: 9 },
  ],
  ...INVALID_NAMES.map((name): readonly [string, string, number[], Usage] => [
    `64/9 后接无效 usage（${name}）再畸形帧，整段一次读取`,
    TEXT + STOP + USAGE_64_9 + INVALID_USAGE_FRAMES[name] + BAD + DONE,
    [],
    { input_tokens: 64, output_tokens: 9 },
  ]),
];

it('[BR-AI-14][AC-B3-02h-002#3][AC-B3-02h-001#6][AC-B3-02h-006#3] 真实 GLM 配置的 HTTP 传输：只认首个畸形帧之前最近一次完整有效的累计 usage——先 30/1 后 64/9 取 64/9（整段、30/1 在前一次读取、逐字节）；尚无结束片时中途片 30/1 取 30/1，30/1、40/3 取 40/3，不借畸形帧之后的结束片 64/9；64/9、畸形帧、64/12 不论整段、切在畸形帧后、逐字节都是 64/9；畸形帧前没有 usage 时整段或切开都是 null；之后的截断或无效 usage 不覆盖 64/9；全部以 malformed 失败、不含原文与凭据', async () => {
  const got: Record<string, unknown> = {};
  for (const [name, text, cuts] of GLM_ORDER) got[name] = await sendGlm(text, cuts);
  expect(got).toEqual(
    Object.fromEntries(GLM_ORDER.map(([name, , , usage]) => [name, glmFailed(usage)])),
  );
});

it('[BR-AI-14][AC-B3-02h-003#13] 同一个真实 GLM 配置的 HTTP 传输连续发送四次：64/9 与畸形帧同一次读取、没有 usage、结束片 64/9 后切开、畸形帧前没有 usage 而之后有 64/12，都以 malformed 失败；错误 usage 依次是 64/9、null、64/9、null，前一次的用量不带进后一次，也不借用畸形帧之后的用量', async () => {
  const f = scriptedFetch([
    ['第 1 次', FAULT, []],
    ['第 2 次', NO_USAGE, []],
    ['第 3 次', GLM_FAULT, [byteAt(GLM_FAULT, BAD)]],
    ['第 4 次', LATER_ONLY, []],
  ]);
  const transport = glmHttp(f.fetch);
  const got: unknown[] = [];
  for (let i = 0; i < 4; i += 1) {
    let outcome: unknown;
    try {
      outcome = { resolved: await transport.send(glmRequest()) };
    } catch (error) {
      outcome = error;
    }
    got.push(outcomeOf(outcome));
  }
  const failed = (usage: Usage) => ({
    kind: 'malformed',
    status: null,
    vendorCode: null,
    usage,
    extra: [],
    leaks: [],
  });
  expect({ got, urls: f.calls.map((c) => c.url) }).toEqual({
    got: [
      failed({ input_tokens: 64, output_tokens: 9 }),
      failed(null),
      failed({ input_tokens: 64, output_tokens: 9 }),
      failed(null),
    ],
    urls: [GLM_URL, GLM_URL, GLM_URL, GLM_URL],
  });
});
