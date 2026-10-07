// HTTP 传输（02 §9.2「取消与断线：服务端中止模型调用」；02 §12.6 千问 API Key 只在 KMS，值不外泄）
// 与评测端口传输（05 B3-02 录制回放；BR-AI-21 录制不计费）。只用注入的假 fetch，不联网。
import { expect, it } from 'vitest';
import {
  ModelProtocolError,
  createHttpTransport,
  createPortTransport,
  quirksFor,
} from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import type {
  FetchLike,
  ModelRequestShape,
} from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import {
  errorResponse,
  expectedGlmVendorRequest,
  expectedModelRequest,
  expectedVendorRequest,
  exposedText,
  fakeApiKey,
  fakeFetch,
  recordedResponse,
  sseText,
  streamResponse,
} from './kit.ts';

const BASE = 'https://synthetic-model.invalid/compatible-mode/v1';

function http(fetch: FetchLike, apiKey: () => string = fakeApiKey, baseUrl = BASE) {
  return createHttpTransport({ vendor: 'qwen', baseUrl, apiKey, fetch, quirks: quirksFor('qwen') });
}

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const hit = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return hit === undefined ? undefined : headers[hit];
}

/** 「合」字的第二个字节：切在一个汉字中间。 */
function midCharCut(text: string): number {
  return new TextEncoder().encode(text.slice(0, text.indexOf('合'))).length + 1;
}

it('[02 §9.2 模型路由 传输#1] POST {baseUrl}/chat/completions，带 Bearer apiKey，body 是厂商请求的 JSON；分片经 SSE 解析，usage 取最后的 usage 片', async () => {
  const text = sseText();
  const f = fakeFetch(() => Promise.resolve(streamResponse(200, text, [midCharCut(text), 40])));
  const t = http(f.fetch);
  expect(t.billable).toBe(true);
  const res = await t.send(expectedVendorRequest());
  expect(f.calls).toHaveLength(1);
  const call = f.calls[0];
  expect(call?.url).toBe(`${BASE}/chat/completions`);
  expect(call?.init.method).toBe('POST');
  expect(header(call?.init.headers ?? {}, 'authorization')).toBe('Bearer ' + fakeApiKey());
  expect(header(call?.init.headers ?? {}, 'content-type')).toContain('application/json');
  expect(JSON.parse(call?.init.body ?? 'null')).toEqual(expectedVendorRequest().body);
  expect(res).toEqual({
    chunks: [
      { choices: [{ index: 0, delta: { content: '合成' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: '回答' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 } },
    ],
    usage: { input_tokens: 30, output_tokens: 4 },
  });
});

it('[02 §9.2 模型路由 传输#2] baseUrl 末尾带斜杠时地址不重复斜杠', async () => {
  const f = fakeFetch(() => Promise.resolve(streamResponse(200, sseText(), [])));
  await http(f.fetch, fakeApiKey, `${BASE}/`).send(expectedVendorRequest());
  expect(f.calls[0]?.url).toBe(`${BASE}/chat/completions`);
});

it('[BR-AI-14 多厂商接入 离线计量 传输#2b] GLM 合成响应：usage 在 choices 非空的结束片上，send 仍取到 input_tokens=90、output_tokens=25', async () => {
  const text = [
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"合成思考"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{"content":"好的"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":90,"completion_tokens":25,"total_tokens":115}}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
  const f = fakeFetch(() => Promise.resolve(streamResponse(200, text, [17, 90])));
  const t = createHttpTransport({
    vendor: 'glm',
    baseUrl: 'https://synthetic-glm.invalid/api/paas/v4',
    apiKey: fakeApiKey,
    fetch: f.fetch,
    quirks: quirksFor('glm'),
  });
  const res = await t.send(expectedGlmVendorRequest());
  expect(f.calls[0]?.url).toBe('https://synthetic-glm.invalid/api/paas/v4/chat/completions');
  expect(res).toEqual({
    chunks: [
      { choices: [{ index: 0, delta: { reasoning_content: '合成思考' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: '好的' }, finish_reason: null }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 90, completion_tokens: 25, total_tokens: 115 },
      },
    ],
    usage: { input_tokens: 90, output_tokens: 25 },
  });
});

it('[02 §12.6 密钥 传输#3] apiKey 在每次请求时读取：换值后下一次请求用新值', async () => {
  let current = fakeApiKey();
  const f = fakeFetch(() => Promise.resolve(streamResponse(200, sseText(), [])));
  const t = http(f.fetch, () => current);
  await t.send(expectedVendorRequest());
  current = 'test-' + 'key-rotated-not-real';
  await t.send(expectedVendorRequest());
  expect(header(f.calls[0]?.init.headers ?? {}, 'authorization')).toBe('Bearer ' + fakeApiKey());
  expect(header(f.calls[1]?.init.headers ?? {}, 'authorization')).toBe(
    'Bearer test-key-rotated-not-real',
  );
});

it('[02 §12.6 密钥 传输#4] baseUrl 不是 https、带用户名或查询串时构造即失败', () => {
  const f = fakeFetch(() => Promise.resolve(streamResponse(200, sseText(), [])));
  expect(() => http(f.fetch)).not.toThrow();
  for (const bad of [
    'http://synthetic-model.invalid/v1',
    'https://user@synthetic-model.invalid/v1',
    'https://user:pw@synthetic-model.invalid/v1',
    'https://synthetic-model.invalid/v1?region=x',
  ]) {
    expect(() => http(f.fetch, fakeApiKey, bad)).toThrow();
  }
});

it('[02 §9.2 取消与断线 传输#5] 已中止的 signal 不发请求，以 aborted 失败', async () => {
  const f = fakeFetch(() => Promise.resolve(streamResponse(200, sseText(), [])));
  const c = new AbortController();
  c.abort();
  const err = await failure(http(f.fetch).send(expectedVendorRequest(), c.signal));
  expect(f.calls).toHaveLength(0);
  expect(err).toBeInstanceOf(ModelProtocolError);
  expect((err as ModelProtocolError).kind).toBe('aborted');
});

it('[02 §9.2 取消与断线 传输#6] 请求途中中止：假 fetch 收到同一个 signal 且已中止；普通中止归 aborted，TimeoutError 归 timeout', async () => {
  for (const [reason, kind] of [
    [undefined, 'aborted'],
    [new DOMException('合成超时', 'TimeoutError'), 'timeout'],
  ] as const) {
    // 可控收尾：假 fetch 在自己收到的 signal 中止时以其 reason 拒绝；测试也能自行以网络错误收尾，
    // 保证传输没把 c.signal 交给 fetch 时，测试以断言失败结束而不是超时。
    let settle: (e: unknown) => void = () => undefined;
    const f = fakeFetch(
      (init) =>
        new Promise((_, reject) => {
          settle = reject;
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        }),
    );
    const c = new AbortController();
    const pending = failure(http(f.fetch).send(expectedVendorRequest(), c.signal));
    const reached = await Promise.race([
      f.called.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    expect(reached).toBe(true);
    try {
      expect(f.calls[0]?.init.signal).toBe(c.signal);
    } finally {
      c.abort(reason);
      settle(new TypeError('合成：测试收尾'));
    }
    const err = await pending;
    expect(f.calls[0]?.init.signal.aborted).toBe(true);
    expect(err).toBeInstanceOf(ModelProtocolError);
    expect((err as ModelProtocolError).kind).toBe(kind);
  }
});

it('[BR-AI-14 无模型降级触发 传输#7] 网络失败归 network；非 2xx 按错误归类，带 status 与厂商码', async () => {
  const net = fakeFetch(() => Promise.reject(new TypeError('fetch failed')));
  const netErr = await failure(http(net.fetch).send(expectedVendorRequest()));
  expect((netErr as ModelProtocolError).kind).toBe('network');
  const body = JSON.stringify({
    error: { message: 'Requests rate limit exceeded', type: 'limit', code: 'limit_requests' },
  });
  const limited = fakeFetch(() => Promise.resolve(errorResponse(429, body)));
  const err = await failure(http(limited.fetch).send(expectedVendorRequest()));
  expect(err).toBeInstanceOf(ModelProtocolError);
  expect((err as ModelProtocolError).kind).toBe('rate_limited');
  expect((err as ModelProtocolError).status).toBe(429);
  expect((err as ModelProtocolError).vendorCode).toBe('limit_requests');
});

it('[BR-AI-14 无模型降级触发 传输#7b] 503 加非 JSON 正文：send 抛 server，status=503', async () => {
  const f = fakeFetch(() => Promise.resolve(errorResponse(503, 'upstream error')));
  const err = await failure(http(f.fetch).send(expectedVendorRequest()));
  expect(err).toBeInstanceOf(ModelProtocolError);
  expect((err as ModelProtocolError).kind).toBe('server');
  expect((err as ModelProtocolError).status).toBe(503);
});

it('[BR-AI-14 无模型降级触发 429 兜底 传输#7c] 千问 429 的未知文案、空正文、非 JSON 正文：send 都抛 rate_limited，status=429', async () => {
  const bodies = [
    JSON.stringify({ error: { message: '合成：未登记的限流文案', code: 'synthetic_unknown' } }),
    '',
    'Too Many Requests',
  ];
  for (const body of bodies) {
    const f = fakeFetch(() => Promise.resolve(errorResponse(429, body)));
    const err = await failure(http(f.fetch).send(expectedVendorRequest()));
    expect(err).toBeInstanceOf(ModelProtocolError);
    expect((err as ModelProtocolError).kind).toBe('rate_limited');
    expect((err as ModelProtocolError).status).toBe(429);
  }
});

it('[02 §12.6 密钥 传输#8] 厂商在错误正文里回显 apiKey 时，抛出的错误各处都不含 apiKey 的值', async () => {
  // 辅助函数自检：嵌套在错误对象自有属性里的字段（如 body.error.message）也要能被看到。
  const probe = Object.assign(new Error('probe'), {
    body: { error: { message: `echo ${fakeApiKey()}` } },
  });
  expect(exposedText(probe)).toContain(fakeApiKey());
  const body = JSON.stringify({
    error: {
      message: `Incorrect API key provided: ${fakeApiKey()}`,
      type: 'invalid_request_error',
      code: 'invalid_api_key',
    },
  });
  const f = fakeFetch(() => Promise.resolve(errorResponse(401, body)));
  const err = await failure(http(f.fetch).send(expectedVendorRequest()));
  expect(err).toBeInstanceOf(ModelProtocolError);
  expect((err as ModelProtocolError).kind).toBe('auth');
  expect(exposedText(err)).not.toContain(fakeApiKey());
  const net = fakeFetch(() => Promise.reject(new TypeError(`connect failed ${fakeApiKey()}`)));
  expect(exposedText(await failure(http(net.fetch).send(expectedVendorRequest())))).not.toContain(
    fakeApiKey(),
  );
});

it('[05 B3-02 录制回放 端口#1] 端口收到 fromVendorRequest 的结果；返回值原样作为响应；billable=false', async () => {
  const seen: ModelRequestShape[] = [];
  const t = createPortTransport((req) => {
    seen.push(req);
    return Promise.resolve(recordedResponse());
  });
  expect(t.billable).toBe(false);
  expect(await t.send(expectedVendorRequest())).toEqual(recordedResponse());
  expect(seen).toEqual([expectedModelRequest()]);
});

it('[05 B3-02 录制回放 端口#2] 端口返回值不符合 VendorResponse 形状时报 malformed；已中止的 signal 不调端口', async () => {
  for (const bad of [
    null,
    { chunks: 'x', usage: { input_tokens: 1, output_tokens: 1 } },
    { chunks: [] },
    { chunks: [], usage: { input_tokens: '1', output_tokens: 1 } },
  ]) {
    const err = await failure(
      createPortTransport(() => Promise.resolve(bad)).send(expectedVendorRequest()),
    );
    expect(err).toBeInstanceOf(ModelProtocolError);
    expect((err as ModelProtocolError).kind).toBe('malformed');
  }
  let calls = 0;
  const c = new AbortController();
  c.abort();
  const t = createPortTransport(() => {
    calls += 1;
    return Promise.resolve(recordedResponse());
  });
  const err = await failure(t.send(expectedVendorRequest(), c.signal));
  expect(calls).toBe(0);
  expect((err as ModelProtocolError).kind).toBe('aborted');
});
