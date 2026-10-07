// 请求构造：前缀稳定（02 §9.2 前缀缓存）、参数白名单、厂商差异表（BR-AI-14 路由顺序「关闭思考」；
// 09 CAP-X-07 显式缓存、CAP-X-19 GLM 不能关思考）、快照锁定（05 B3-02；BR-AI-14 路由顺序）、
// toVendorRequest / fromVendorRequest 互逆。
import fc from 'fast-check';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ModelProtocolError,
  assertPinnedModel,
  buildModelRequest,
  fromVendorRequest,
  quirksFor,
  toVendorRequest,
} from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import type {
  ChatInput,
  ModelRequestShape,
  VendorQuirks,
} from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import { canonicalJson } from '../../../../packages/evals/src/index.ts';
import { propParams } from '@couli/testing';
import {
  ALLOWED_PARAM_KEYS,
  PINNED_QWEN,
  PINNED_QWEN_PLUS,
  chatInput,
  expectedGlmRequest,
  expectedGlmVendorRequest,
  expectedModelRequest,
  expectedQwenPlusRequest,
  expectedQwenPlusVendorRequest,
  expectedThreeToolRequest,
  expectedVendorRequest,
  threeToolInput,
} from './kit.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function qwenQuirks(): VendorQuirks {
  return quirksFor('qwen', { explicitCache: false, includeUsage: true });
}

/** GLM 的快照命名未定（06 Q-C31）：测试自带一个合成判定式，只换 pinnedModel，其余取差异表默认值。 */
function glmQuirks(over: Partial<Omit<VendorQuirks, 'pinnedModel'>> = {}): VendorQuirks {
  return { ...quirksFor('glm', over), pinnedModel: /^glm-synthetic-\d{4}$/ };
}

function glmInput(): ChatInput {
  return { ...chatInput(), vendor: 'glm', model: 'glm-synthetic-0001' };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function kindOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (e) {
    return e instanceof ModelProtocolError ? e.kind : `other:${String(e)}`;
  }
  return undefined;
}

it('[02 §9.2 前缀缓存#1] system 在第一条、历史按原顺序；工具映射成 function 定义并按 name 排序；不改动输入', () => {
  const req = buildModelRequest(deepFreeze(chatInput()), qwenQuirks());
  expect(req).toEqual(expectedModelRequest());
});

it('[02 §9.2 前缀缓存#2] 三个工具任意排列，产物都等于独立写出的完整期望请求，canonicalJson 逐字相同（属性测试）', () => {
  const expected = canonicalJson(expectedThreeToolRequest());
  const tools = threeToolInput().tools;
  expect(canonicalJson(buildModelRequest(threeToolInput(), qwenQuirks()))).toBe(expected);
  expect(() =>
    fc.assert(
      fc.property(fc.shuffledSubarray([...tools], { minLength: tools.length }), (shuffled) => {
        const input = { ...threeToolInput(), tools: structuredClone(shuffled) };
        return canonicalJson(buildModelRequest(input, qwenQuirks())) === expected;
      }),
      propParams(),
    ),
  ).not.toThrow();
}, 900_000);

it('[BR-AI-14 多厂商接入#1] GLM 合成模型的完整请求：vendor、model、messages、tools、params 与转换后请求体', () => {
  const req = buildModelRequest(
    glmInput(),
    glmQuirks({ explicitCache: false, includeUsage: true }),
  );
  expect(req).toEqual(expectedGlmRequest());
  expect(toVendorRequest(req)).toEqual(expectedGlmVendorRequest());
});

it('[BR-AI-14 路由顺序 Plus 备用快照] 千问 Plus 日期快照的完整请求：vendor、model、messages、tools、params 与转换后请求体', () => {
  const req = buildModelRequest({ ...chatInput(), model: PINNED_QWEN_PLUS }, qwenQuirks());
  expect(req).toEqual(expectedQwenPlusRequest());
  expect(toVendorRequest(req)).toEqual(expectedQwenPlusVendorRequest());
});

it('[02 §9.2 前缀缓存#3] params 的键只来自允许集合，tool_choice 恒为 auto，不发 parallel_tool_calls', () => {
  const variants: ModelRequestShape[] = [
    buildModelRequest(chatInput(), quirksFor('qwen')),
    buildModelRequest(chatInput(), quirksFor('qwen', { includeUsage: false })),
    buildModelRequest(glmInput(), glmQuirks()),
    buildModelRequest(
      { ...chatInput(), sampling: { temperature: 0.3, top_p: 0.8, seed: 7, max_tokens: 512 } },
      qwenQuirks(),
    ),
  ];
  for (const req of variants) {
    for (const key of Object.keys(req.params)) expect(ALLOWED_PARAM_KEYS).toContain(key);
    expect(req.params['tool_choice']).toBe('auto');
    expect(req.params['stream']).toBe(true);
    expect(req.params).not.toHaveProperty('parallel_tool_calls');
    for (const key of ['user', 'user_id', 'device_id', 'request_id', 'timestamp', 'n']) {
      expect(req.params).not.toHaveProperty(key);
    }
  }
});

it('[02 §9.2 前缀缓存#4] 同一输入在不同时刻、不同随机数下产物逐字相同（无时间戳、请求编号）', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T00:00:00Z'));
  vi.spyOn(Math, 'random').mockReturnValue(0.11);
  const first = canonicalJson(buildModelRequest(chatInput(), qwenQuirks()));
  vi.setSystemTime(new Date('2027-01-01T08:00:00Z'));
  vi.spyOn(Math, 'random').mockReturnValue(0.97);
  const second = canonicalJson(buildModelRequest(chatInput(), qwenQuirks()));
  expect(second).toBe(first);
});

it('[02 §9.2 前缀缓存#5] sampling 不填就不发；填了按给的值发，换值跟着变', () => {
  const none = buildModelRequest(chatInput(), qwenQuirks());
  for (const key of ['temperature', 'top_p', 'seed', 'max_tokens']) {
    expect(none.params).not.toHaveProperty(key);
  }
  const a = buildModelRequest({ ...chatInput(), sampling: { temperature: 0.3 } }, qwenQuirks());
  const b = buildModelRequest(
    { ...chatInput(), sampling: { temperature: 0.7, max_tokens: 256 } },
    qwenQuirks(),
  );
  expect(a.params['temperature']).toBe(0.3);
  expect(a.params).not.toHaveProperty('max_tokens');
  expect(b.params['temperature']).toBe(0.7);
  expect(b.params['max_tokens']).toBe(256);
});

it('[02 §9.2 前缀缓存#6] includeUsage 开时 stream_options.include_usage=true，关时不发 stream_options', () => {
  const on = buildModelRequest(chatInput(), quirksFor('qwen', { includeUsage: true }));
  const off = buildModelRequest(chatInput(), quirksFor('qwen', { includeUsage: false }));
  expect(on.params['stream_options']).toEqual({ include_usage: true });
  expect(off.params).not.toHaveProperty('stream_options');
});

it('[BR-AI-14 路由顺序「关闭思考」/ 09 CAP-X-19] 千问默认 enable_thinking=false；GLM 默认不发该键；换值后跟着变', () => {
  expect(quirksFor('qwen').thinking).toBe('disable');
  expect(quirksFor('glm').thinking).toBe('omit');
  const qwen = buildModelRequest(chatInput(), quirksFor('qwen'));
  expect(qwen.params['enable_thinking']).toBe(false);
  const glm = buildModelRequest(glmInput(), glmQuirks());
  expect(glm.params).not.toHaveProperty('enable_thinking');
  expect(JSON.stringify(glm)).not.toContain('thinking');
  const qwenOmit = buildModelRequest(chatInput(), quirksFor('qwen', { thinking: 'omit' }));
  expect(qwenOmit.params).not.toHaveProperty('enable_thinking');
  const glmDisable = buildModelRequest(glmInput(), glmQuirks({ thinking: 'disable' }));
  expect(glmDisable.params['enable_thinking']).toBe(false);
});

it('[09 CAP-X-07 显式缓存] explicitCache 关时整个请求没有 cache_control；开时只在 system 段出现一处', () => {
  const count = (s: string) => s.split('"cache_control"').length - 1;
  const off = buildModelRequest(chatInput(), quirksFor('qwen', { explicitCache: false }));
  expect(count(JSON.stringify(off))).toBe(0);
  const on = buildModelRequest(chatInput(), quirksFor('qwen', { explicitCache: true }));
  expect(count(JSON.stringify(on))).toBe(1);
  expect(count(JSON.stringify(on.messages[0]))).toBe(1);
  expect(JSON.stringify(on.messages[0])).toContain('合成：你是找货助手。');
  expect(on.messages.slice(1)).toEqual(expectedModelRequest().messages.slice(1));
  expect(on.tools).toEqual(expectedModelRequest().tools);
});

it('[05 B3-02 快照锁定] 主线 ID、latest 与空串一律 model_not_pinned；带日期的快照通过', () => {
  const q = quirksFor('qwen');
  for (const model of ['qwen-plus', 'qwen-flash', 'qwen-plus-latest', '']) {
    expect(kindOf(() => assertPinnedModel(model, q))).toBe('model_not_pinned');
    expect(kindOf(() => buildModelRequest({ ...chatInput(), model }, q))).toBe('model_not_pinned');
  }
  for (const model of [PINNED_QWEN, PINNED_QWEN_PLUS, 'qwen3.7-plus-2026-05-26']) {
    expect(kindOf(() => assertPinnedModel(model, q))).toBeUndefined();
  }
});

it('[05 B3-02 录制回放] toVendorRequest 的 body = { model, messages, tools, ...params }', () => {
  expect(toVendorRequest(expectedModelRequest())).toEqual(expectedVendorRequest());
  expect(fromVendorRequest(expectedVendorRequest())).toEqual(expectedModelRequest());
});

const json = fc.jsonValue({ maxDepth: 2 });
const shapeArb = fc.record({
  vendor: fc.constantFrom('qwen', 'glm'),
  model: fc.string({ minLength: 1, maxLength: 24 }),
  messages: fc.array(fc.dictionary(fc.string({ maxLength: 8 }), json, { maxKeys: 3 }), {
    maxLength: 4,
  }),
  tools: fc.array(fc.dictionary(fc.string({ maxLength: 8 }), json, { maxKeys: 3 }), {
    minLength: 1,
    maxLength: 3,
  }),
  params: fc.dictionary(fc.constantFrom(...ALLOWED_PARAM_KEYS), json, { maxKeys: 5 }),
});

it('[05 B3-02 录制回放] fromVendorRequest(toVendorRequest(x)) 与 x 相同（属性测试）', () => {
  expect(() =>
    fc.assert(
      fc.property(shapeArb, (shape) => {
        const expected = canonicalJson(shape);
        const back = fromVendorRequest(toVendorRequest(structuredClone(shape)));
        return canonicalJson(back) === expected;
      }),
      propParams(),
    ),
  ).not.toThrow();
}, 900_000);
