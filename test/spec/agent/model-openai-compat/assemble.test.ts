// 流式分片拼装（09 CAP-X-07「流式时 tool_calls 参数分多个 chunk 返回，需拼接」；
// CAP-X-19 通过标准②「流式工具调用参数能被同一适配器正确拼接」）与畸形输入。
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { canonicalJson } from '../../../../packages/evals/src/index.ts';
import {
  ModelProtocolError,
  assembleChunks,
  usageOf,
} from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import { finishChunk, reasoningChunk, summarize, textChunk, toolChunk, usageChunk } from './kit.ts';

function searchCall() {
  return {
    id: 'call_1',
    type: 'function',
    function: { name: 'search_products', arguments: '{"q":"保温杯","platforms":["tb"]}' },
  };
}

function parseCall() {
  return {
    id: 'call_2',
    type: 'function',
    function: { name: 'parse_input', arguments: '{"text":"合成口令"}' },
  };
}

function malformedKind(chunks: readonly unknown[]): string | undefined {
  try {
    assembleChunks(chunks);
  } catch (e) {
    return e instanceof ModelProtocolError ? e.kind : `other:${String(e)}`;
  }
  return undefined;
}

it('[09 CAP-X-07 流式#1] 文本增量按顺序拼接，finish_reason=stop 产生一个 done，usage 片产生 usage 事件', () => {
  const events = assembleChunks([
    textChunk('合成'),
    textChunk('，第二段'),
    textChunk('。'),
    finishChunk('stop'),
    usageChunk(120, 30),
  ]);
  expect(summarize(events)).toEqual({
    text: '合成，第二段。',
    tools: [],
    done: ['stop'],
    usage: [{ input: 120, output: 30, cached: null }],
  });
  expect(usageOf(events)).toEqual({ input_tokens: 120, output_tokens: 30 });
});

it('[09 CAP-X-07 流式#2] 同一 index 的工具参数分多片到达，拼成一条可 JSON.parse 的完整参数；id 与 name 只在首片', () => {
  const events = assembleChunks([
    toolChunk(0, { id: 'call_1', name: 'search_products', args: '' }),
    toolChunk(0, { args: '{"q":' }),
    toolChunk(0, { args: '"保温' }),
    toolChunk(0, { args: '杯","platforms":' }),
    toolChunk(0, { args: '["tb"]}' }),
    finishChunk('tool_calls'),
    usageChunk(200, 40, 128),
  ]);
  const s = summarize(events);
  expect(s.tools).toEqual([{ index: 0, call: searchCall() }]);
  expect(JSON.parse(searchCall().function.arguments)).toEqual({ q: '保温杯', platforms: ['tb'] });
  expect(s.done).toEqual(['tool_calls']);
  expect(s.usage).toEqual([{ input: 200, output: 40, cached: 128 }]);
  expect(s.text).toBe('');
});

it('[09 CAP-X-07 流式#3] index 0 与 1 交错到达时各自拼对', () => {
  const events = assembleChunks([
    toolChunk(0, { id: 'call_1', name: 'search_products', args: '{"q":"保' }),
    toolChunk(1, { id: 'call_2', name: 'parse_input', args: '{"text":' }),
    toolChunk(0, { args: '温杯","platforms":["tb"]}' }),
    toolChunk(1, { args: '"合成口令"}' }),
    finishChunk('tool_calls'),
  ]);
  expect(summarize(events).tools).toEqual([
    { index: 0, call: searchCall() },
    { index: 1, call: parseCall() },
  ]);
});

it('[09 CAP-X-07 流式#4] 工具参数在任意位置切成任意片数都拼回原文（属性测试）', () => {
  const args = searchCall().function.arguments;
  const cutsArb = fc.uniqueArray(fc.integer({ min: 1, max: args.length - 1 }), { maxLength: 8 });
  const expected = canonicalJson([{ index: 0, call: searchCall() }]);
  expect(() =>
    fc.assert(
      fc.property(cutsArb, (cuts) => {
        const points = [0, ...[...cuts].sort((a, b) => a - b), args.length];
        const chunks: unknown[] = [];
        for (let i = 0; i + 1 < points.length; i += 1) {
          const piece = args.slice(points[i], points[i + 1]);
          chunks.push(
            toolChunk(
              0,
              i === 0 ? { id: 'call_1', name: 'search_products', args: piece } : { args: piece },
            ),
          );
        }
        chunks.push(finishChunk('tool_calls'));
        return canonicalJson(summarize(assembleChunks(chunks)).tools) === expected;
      }),
      propParams(),
    ),
  ).not.toThrow();
}, 900_000);

it('[09 CAP-X-07 流式#5] finish_reason 为 length / content_filter 时 done 带相同原因', () => {
  for (const reason of ['length', 'content_filter']) {
    const events = assembleChunks([textChunk('合成'), finishChunk(reason)]);
    expect(summarize(events).done).toEqual([reason]);
  }
});

it('[09 CAP-X-07 流式#6] 畸形输入：非 JSON 分片、结束时参数仍不是合法 JSON、整段没有 finish_reason，都抛 malformed', () => {
  expect(malformedKind(['data: oops', finishChunk('stop')])).toBe('malformed');
  expect(malformedKind([textChunk('合成'), 42, finishChunk('stop')])).toBe('malformed');
  expect(
    malformedKind([
      toolChunk(0, { id: 'call_1', name: 'search_products', args: '{"q":"保' }),
      finishChunk('tool_calls'),
    ]),
  ).toBe('malformed');
  expect(malformedKind([textChunk('合成'), usageChunk(10, 2)])).toBe('malformed');
  expect(malformedKind([])).toBe('malformed');
});

it('[09 CAP-X-19 通过标准②] GLM 合成流（带思考内容、usage 随结束片到达）用同一适配器拼装，结果同形；思考内容不进文本', () => {
  const finishWithUsage = {
    ...finishChunk('tool_calls'),
    usage: { prompt_tokens: 90, completion_tokens: 25, total_tokens: 115 },
  };
  const events = assembleChunks([
    reasoningChunk('合成思考：用户要保温杯'),
    reasoningChunk('，先搜索。'),
    textChunk('好的'),
    toolChunk(0, {
      id: 'call_1',
      name: 'search_products',
      args: '{"q":"保温杯","platforms":["tb"]}',
    }),
    finishWithUsage,
  ]);
  expect(summarize(events)).toEqual({
    text: '好的',
    tools: [{ index: 0, call: searchCall() }],
    done: ['tool_calls'],
    usage: [{ input: 90, output: 25, cached: null }],
  });
  expect(JSON.stringify(events)).not.toContain('合成思考');
});
