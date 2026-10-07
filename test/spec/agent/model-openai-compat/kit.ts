// 规则测试共用夹具（B3-02b）。全部是合成数据：不调用任何真实模型接口、不读任何密钥。
// 期望值一律由下面的函数每次新建字面量，不由被测代码产生，也不与被测代码拿到的对象共享引用。
import type {
  ChatInput,
  FetchInit,
  FetchLike,
  FetchResponseLike,
  ModelEvent,
  ModelRequestShape,
} from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import type {
  VendorRequest,
  VendorResponse,
} from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';

/** 带日期的千问快照（09 CAP-X-07 页面标出的 qwen-flash 等效快照）。 */
export const PINNED_QWEN = 'qwen-flash-2025-07-28';

/** 允许出现在 params 里的键（02 §9.2 前缀稳定；本段口径，见 tests-claude.md）。 */
export const ALLOWED_PARAM_KEYS: readonly string[] = [
  'stream',
  'stream_options',
  'tool_choice',
  'enable_thinking',
  'temperature',
  'top_p',
  'seed',
  'max_tokens',
];

/** 假 apiKey：运行时拼接，明显是假值。 */
export function fakeApiKey(): string {
  return 'test-' + 'key-not-real-' + 'b3o2b';
}

function toolDef(name: string, description: string, prop: string) {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: { [prop]: { type: 'string' } },
      required: [prop],
      additionalProperties: false,
    },
  };
}

function mappedTool(name: string, description: string, prop: string) {
  return { type: 'function', function: toolDef(name, description, prop) };
}

function history() {
  return [
    { role: 'user' as const, content: '合成：找一款保温杯' },
    {
      role: 'assistant' as const,
      content: null,
      tool_calls: [
        {
          id: 'call_s1',
          type: 'function' as const,
          function: { name: 'search_products', arguments: '{"q":"保温杯"}' },
        },
      ],
    },
    { role: 'tool' as const, content: '{"cards":["c1"]}', tool_call_id: 'call_s1' },
    { role: 'user' as const, content: '合成：要 500ml 的' },
  ];
}

/** 合成输入：工具故意不按名字排序。 */
export function chatInput(): ChatInput {
  return {
    vendor: 'qwen',
    model: PINNED_QWEN,
    system: '合成：你是找货助手。',
    tools: [
      toolDef('search_products', '合成：按关键词搜索', 'q'),
      toolDef('parse_input', '合成：解析链接与口令', 'text'),
    ],
    messages: history(),
  };
}

/** chatInput() 配 quirksFor('qwen', { explicitCache: false, includeUsage: true }) 的期望产物。 */
export function expectedModelRequest(): ModelRequestShape {
  return {
    vendor: 'qwen',
    model: PINNED_QWEN,
    messages: [{ role: 'system', content: '合成：你是找货助手。' }, ...history()],
    tools: [
      mappedTool('parse_input', '合成：解析链接与口令', 'text'),
      mappedTool('search_products', '合成：按关键词搜索', 'q'),
    ],
    params: {
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: 'auto',
      enable_thinking: false,
    },
  };
}

/** expectedModelRequest() 对应的厂商请求：body = { model, messages, tools, ...params }。 */
export function expectedVendorRequest(): VendorRequest {
  const m = expectedModelRequest();
  return {
    vendor: 'qwen',
    model: PINNED_QWEN,
    body: {
      model: PINNED_QWEN,
      messages: m.messages,
      tools: m.tools,
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: 'auto',
      enable_thinking: false,
    },
  };
}

/** 千问 Plus 档的日期快照（09 CAP-X-07 页面标出的 qwen-plus 等效快照）。 */
export const PINNED_QWEN_PLUS = 'qwen-plus-2025-12-01';

/** 三个工具的合成输入（工具故意不按名字排序；explain_order 参数为空对象）。 */
export function threeToolInput(): ChatInput {
  return {
    ...chatInput(),
    tools: [
      toolDef('search_products', '合成：按关键词搜索', 'q'),
      { name: 'explain_order', description: '合成：解释订单', parameters: {} },
      toolDef('parse_input', '合成：解析链接与口令', 'text'),
    ],
  };
}

/** threeToolInput() 的期望产物：完整字面量，工具按 name 排序。 */
export function expectedThreeToolRequest(): ModelRequestShape {
  return {
    vendor: 'qwen',
    model: 'qwen-flash-2025-07-28',
    messages: [
      { role: 'system', content: '合成：你是找货助手。' },
      { role: 'user', content: '合成：找一款保温杯' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_s1',
            type: 'function',
            function: { name: 'search_products', arguments: '{"q":"保温杯"}' },
          },
        ],
      },
      { role: 'tool', content: '{"cards":["c1"]}', tool_call_id: 'call_s1' },
      { role: 'user', content: '合成：要 500ml 的' },
    ],
    tools: [
      {
        type: 'function',
        function: { name: 'explain_order', description: '合成：解释订单', parameters: {} },
      },
      {
        type: 'function',
        function: {
          name: 'parse_input',
          description: '合成：解析链接与口令',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'search_products',
          description: '合成：按关键词搜索',
          parameters: {
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q'],
            additionalProperties: false,
          },
        },
      },
    ],
    params: {
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: 'auto',
      enable_thinking: false,
    },
  };
}

/** GLM 合成模型（chatInput() 改 vendor=glm、model=glm-synthetic-0001，思考取 GLM 默认 omit）的期望产物。 */
export function expectedGlmRequest(): ModelRequestShape {
  return {
    vendor: 'glm',
    model: 'glm-synthetic-0001',
    messages: [{ role: 'system', content: '合成：你是找货助手。' }, ...history()],
    tools: [
      mappedTool('parse_input', '合成：解析链接与口令', 'text'),
      mappedTool('search_products', '合成：按关键词搜索', 'q'),
    ],
    params: { stream: true, stream_options: { include_usage: true }, tool_choice: 'auto' },
  };
}

export function expectedGlmVendorRequest(): VendorRequest {
  return {
    vendor: 'glm',
    model: 'glm-synthetic-0001',
    body: {
      model: 'glm-synthetic-0001',
      messages: [{ role: 'system', content: '合成：你是找货助手。' }, ...history()],
      tools: [
        mappedTool('parse_input', '合成：解析链接与口令', 'text'),
        mappedTool('search_products', '合成：按关键词搜索', 'q'),
      ],
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: 'auto',
    },
  };
}

/** chatInput() 改用 Plus 日期快照的期望产物。 */
export function expectedQwenPlusRequest(): ModelRequestShape {
  return {
    vendor: 'qwen',
    model: 'qwen-plus-2025-12-01',
    messages: [{ role: 'system', content: '合成：你是找货助手。' }, ...history()],
    tools: [
      mappedTool('parse_input', '合成：解析链接与口令', 'text'),
      mappedTool('search_products', '合成：按关键词搜索', 'q'),
    ],
    params: {
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: 'auto',
      enable_thinking: false,
    },
  };
}

export function expectedQwenPlusVendorRequest(): VendorRequest {
  return {
    vendor: 'qwen',
    model: 'qwen-plus-2025-12-01',
    body: {
      model: 'qwen-plus-2025-12-01',
      messages: [{ role: 'system', content: '合成：你是找货助手。' }, ...history()],
      tools: [
        mappedTool('parse_input', '合成：解析链接与口令', 'text'),
        mappedTool('search_products', '合成：按关键词搜索', 'q'),
      ],
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: 'auto',
      enable_thinking: false,
    },
  };
}

/** sha256(canonicalJson(expectedModelRequest()))，在测试外独立算出后写死。 */
export const RECORDING_DIGEST = 'ac30127fc2e90e03903115f1ab401e4f61406fe1c63c9ec531138e80d506761c';

export function recordedResponse(): VendorResponse {
  return {
    chunks: [textChunk('合成回放'), finishChunk('stop'), usageChunk(321, 12)],
    usage: { input_tokens: 321, output_tokens: 12 },
  };
}

/** evals 格式的一行录制（kind: model）。 */
export function recordingLine(): string {
  return JSON.stringify({
    kind: 'model',
    key: RECORDING_DIGEST,
    response: recordedResponse(),
    recorded_at: '2026-10-06T01:02:03Z',
  });
}

// ---- OpenAI 兼容流式分片（合成） ----

export function textChunk(content: string) {
  return {
    id: 'chatcmpl-synthetic',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
}

export function reasoningChunk(text: string) {
  return {
    id: 'chatcmpl-synthetic',
    choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
  };
}

export function toolChunk(index: number, part: { id?: string; name?: string; args: string }) {
  const fn: Record<string, string> = { arguments: part.args };
  if (part.name !== undefined) fn['name'] = part.name;
  const call: Record<string, unknown> = { index, function: fn };
  if (part.id !== undefined) {
    call['id'] = part.id;
    call['type'] = 'function';
  }
  return {
    id: 'chatcmpl-synthetic',
    choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }],
  };
}

export function finishChunk(reason: string) {
  return { id: 'chatcmpl-synthetic', choices: [{ index: 0, delta: {}, finish_reason: reason }] };
}

export function usageChunk(prompt: number, completion: number, cached?: number) {
  const usage: Record<string, unknown> = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
  if (cached !== undefined) usage['prompt_tokens_details'] = { cached_tokens: cached };
  return { id: 'chatcmpl-synthetic', choices: [], usage };
}

/** 与拆分粒度无关的事件摘要：文本拼接、按 index 排序的工具调用、done 与 usage。 */
export function summarize(events: readonly ModelEvent[]) {
  let text = '';
  const tools: { index: number; call: unknown }[] = [];
  const done: string[] = [];
  const usage: unknown[] = [];
  for (const e of events) {
    if (e.t === 'text_delta') text += e.text;
    else if (e.t === 'tool_call') tools.push({ index: e.index, call: e.call });
    else if (e.t === 'done') done.push(e.reason);
    else usage.push({ input: e.input, output: e.output, cached: e.cached });
  }
  tools.sort((a, b) => a.index - b.index);
  return { text, tools, done, usage };
}

// ---- SSE 文本（合成） ----

/** 含注释行、[DONE] 之后的多余数据。 */
export function sseText(): string {
  return [
    ': keep-alive',
    '',
    'data: {"choices":[{"index":0,"delta":{"content":"合成"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{"content":"回答"},"finish_reason":"stop"}]}',
    '',
    ': ping',
    '',
    'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":4,"total_tokens":34}}',
    '',
    'data: [DONE]',
    '',
    'data: {"after":"done"}',
    '',
    '',
  ].join('\n');
}

/** sseText() 解析后应得的分片（[DONE] 之后的不算）。 */
export function sseChunks(): unknown[] {
  return [
    { choices: [{ index: 0, delta: { content: '合成' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: '回答' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 } },
  ];
}

// ---- 假 fetch ----

export interface FakeFetch {
  readonly fetch: FetchLike;
  readonly calls: { url: string; init: FetchInit }[];
  /** 第一次被调用时兑现。 */
  readonly called: Promise<void>;
}

export function fakeFetch(respond: (init: FetchInit) => Promise<FetchResponseLike>): FakeFetch {
  const calls: { url: string; init: FetchInit }[] = [];
  let mark: () => void = () => undefined;
  const called = new Promise<void>((resolve) => {
    mark = resolve;
  });
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    mark();
    return respond(init);
  };
  return { fetch, calls, called };
}

/** 按字节切成若干段的响应体；cuts 是字节位置。 */
export function streamResponse(status: number, text: string, cuts: number[]): FetchResponseLike {
  const bytes = new TextEncoder().encode(text);
  const points = [0, ...[...cuts].sort((a, b) => a - b), bytes.length];
  return {
    status,
    body: {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i + 1 < points.length; i += 1) {
          await Promise.resolve();
          yield bytes.slice(points[i], points[i + 1]);
        }
      },
    },
    text: () => Promise.resolve(text),
  };
}

export function errorResponse(status: number, text: string): FetchResponseLike {
  return { status, body: null, text: () => Promise.resolve(text) };
}

/**
 * 把错误对象能被看到的各处拼成一个字符串：String(err)、message、stack，以及各层自有属性
 * （含不可枚举属性与 cause）里的全部字符串值，递归遍历嵌套对象与数组，跳过已访问的对象。
 * 编排者 2026-10-07 收口修正：原先用数组 replacer 序列化，嵌套对象里的字段（如 body.error.message）看不到。
 */
export function exposedText(err: unknown): string {
  const parts: string[] = [String(err)];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (typeof value !== 'object' || value === null) {
      if (value !== undefined) parts.push(String(value));
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      parts.push(key);
      visit((value as Record<string, unknown>)[key]);
    }
  };
  visit(err);
  return parts.join('\n');
}
