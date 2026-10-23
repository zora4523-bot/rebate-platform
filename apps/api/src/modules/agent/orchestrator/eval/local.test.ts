import { expect, it, vi } from 'vitest';
import type { ToolContext } from '../core/ports.ts';
import { createLocalEvalAgent, createPortTools, decodeToolOutcome } from './local.ts';
import type { EvalInput, EvalPorts } from './adapter.ts';

// Synthetic only: example.invalid, obviously synthetic names and numbers; no real model or review.
const AT = '2026-10-22T03:04:05.000Z';
const PHONE = '13800138000';

function input(text: string): EvalInput {
  return {
    case_id: 'synthetic-local-unit',
    turn: 1,
    text,
    untrusted: false,
    subject: 'guest',
    switches: {},
  };
}

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return { id: 'synthetic', choices: [{ index: 0, delta, finish_reason: finish }] };
}

function answer(text: string) {
  return {
    chunks: [
      chunk({ content: text }),
      chunk({}, 'stop'),
      { id: 'synthetic', choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } },
    ],
    usage: { input_tokens: 3, output_tokens: 1 },
  };
}

function modelAgent() {
  let n = 0;
  return createLocalEvalAgent({
    clock: { now: () => new Date(AT) },
    ids: { next: () => `synthetic-${String((n += 1))}` },
    prompt: { current: async () => ({ version: 'synthetic@1', system: '合成提示词。' }) },
    route: async () => ({
      mode: 'models',
      dropped: [],
      attempts: [
        {
          id: 'synthetic-flash',
          vendor: 'qwen',
          tier: 'flash',
          model: 'qwen-flash-2026-10-01',
          evaluation: { report: 'synthetic-only', signed: true },
        },
      ],
    }),
  });
}

function context(): ToolContext {
  return {
    subject: {
      appId: 'couli',
      traceId: 'synthetic-trace',
      deviceId: 'synthetic-device',
      deviceHash: 'synthetic-hash',
      ipKey: 'synthetic-ip',
      userId: null,
      phoneBound: false,
    },
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    placeholders: {},
  };
}

it('[AC-B3-05m#2][BR-AI-14] 走模型分支时模型端口只收到脱敏后的用户文本，不含原手机号', async () => {
  const model = vi.fn<EvalPorts['model']>(async () => answer('合成回答。'));
  const tool = vi.fn<EvalPorts['tool']>(async () => ({ kind: 'failed', modelView: {} }));
  const output = await modelAgent()(input(`合成保温杯，联系 ${PHONE}`), { model, tool });
  expect(model).toHaveBeenCalledTimes(1);
  const sent = JSON.stringify(model.mock.calls[0]![0]);
  expect(sent).not.toContain(PHONE);
  expect(sent).toContain('合成保温杯');
  expect(output.frames.at(-1)?.event).toBe('done');
});

it('[AC-B3-05m#7][BR-AI-14] 本机装配与运行不读取 process.env', async () => {
  const original = process.env;
  const reads: PropertyKey[] = [];
  process.env = new Proxy(original, {
    get(target, key) {
      reads.push(key);
      return Reflect.get(target, key);
    },
    has(target, key) {
      reads.push(key);
      return Reflect.has(target, key);
    },
    ownKeys(target) {
      reads.push('*');
      return Reflect.ownKeys(target);
    },
  });
  try {
    const model = vi.fn<EvalPorts['model']>(async () => answer('合成回答。'));
    const tool = vi.fn<EvalPorts['tool']>(async () => ({ kind: 'failed', modelView: {} }));
    await modelAgent()(input('合成保温杯'), { model, tool });
  } finally {
    process.env = original;
  }
  expect(reads).toEqual([]);
});

it('[AC-B3-05m#3][BR-AI-21] 工具端口的普通异常记为 failed，非对象参数不调用端口', async () => {
  const port = vi.fn<EvalPorts['tool']>(async () => {
    throw new Error('synthetic port failure');
  });
  const tools = createPortTools(
    port,
    { definitions: async () => [], enabledSearchPlatforms: async () => [] },
    1,
  );
  expect(
    await tools.execute({ id: 'synthetic-call', name: 'search_products', args: [] }, context()),
  ).toEqual({ kind: 'rejected', modelView: { error: 'invalid_args' } });
  expect(port).not.toHaveBeenCalled();
  expect(
    await tools.execute({ id: 'synthetic-call', name: 'search_products', args: {} }, context()),
  ).toMatchObject({ kind: 'failed' });
  expect(port).toHaveBeenCalledTimes(1);
});

it('[AC-B3-05m#3][BR-AI-21] 降级搜索录制缺平台或非法时按平台失败处理', async () => {
  const port = vi.fn<EvalPorts['tool']>(async () => ({
    kind: 'ok',
    modelView: { results: [{ platform: 'taobao', ok: true, items: [] }] },
  }));
  const tools = createPortTools(
    port,
    { definitions: async () => [], enabledSearchPlatforms: async () => ['taobao', 'jd'] },
    1,
  );
  const plan = { q: '合成杯', platforms: ['taobao', 'jd'], sort: 'relevance' as const };
  expect(await tools.searchKeyword(plan, context())).toEqual({
    results: [
      { platform: 'taobao', ok: true, items: [] },
      { platform: 'jd', ok: false },
    ],
    cards: [],
  });
  port.mockResolvedValueOnce({ kind: 'ok', modelView: { results: 'bad' } });
  expect((await tools.searchKeyword(plan, context())).results).toEqual([
    { platform: 'taobao', ok: false },
    { platform: 'jd', ok: false },
  ]);
});

it.each([
  { kind: 'ok', modelView: {}, suggestions: [{ text: '合成' }] },
  { kind: 'ok', modelView: {}, suggestions: [{ text: '', send_text: '合成追问' }] },
  { kind: 'ok', modelView: {}, suggestions: [{ text: '合成', send_text: '' }] },
  {
    kind: 'ok',
    modelView: {},
    suggestions: ['一', '二', '三', '四'].map((n) => ({ text: `合成${n}`, send_text: `合成${n}` })),
  },
  { kind: 'ok', modelView: {}, trace: { link_registrations: [{ link_id: 'x' }] } },
  { kind: 'ok', modelView: {}, trace: { card_sources: [{ card_id: 'c1', fields: { a: {} } }] } },
  { kind: 'failed' },
])('[AC-B3-05m#3][BR-AI-21] 非法字段的工具录制拒绝解码 %j', (response) => {
  expect(decodeToolOutcome(response)).toBeNull();
});
