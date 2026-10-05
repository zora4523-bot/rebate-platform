import { expect, it } from 'vitest';
import {
  canonicalJson, sha256Hex, modelKey, toolKey, loadRecordings, RecordingMiss,
} from '../../../packages/evals/src/index.ts';
import type { ModelRequest, ToolCall } from '../../../packages/evals/src/index.ts';
import { call, digest, jsonl, recording, request } from './fixtures.ts';

it('[B3-01b] 规范化与摘要按 UTF-16 键序、UTF-8 编码，数组保序、省略 undefined、拒绝非有限数', () => {
  const value = { z: undefined, '2': '二', '10': '十', a: [{ z: 2, A: 1 }], Z: '中文😀' };
  const canonical = '{"10":"十","2":"二","Z":"中文😀","a":[{"A":1,"z":2}]}';
  expect(canonicalJson(value)).toBe(canonical);
  expect(canonicalJson({ '\uE000': 1, '😀': 2, A: 3, a: 4 })).toBe('{"A":3,"a":4,"😀":2,"":1}');
  expect(canonicalJson([true, null, 'x', 1])).toBe('[true,null,"x",1]');
  for (const n of [NaN, Infinity, -Infinity]) {
    expect(() => canonicalJson({ nested: [n] })).toThrow();
  }
  expect(sha256Hex(canonical)).toBe(digest(canonical));
  expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

it('[B3-01b] modelKey 覆盖完整请求；键插入顺序不影响摘要', () => {
  const req = request({ messages: ['合成一', '合成二'], params: { z: 1, a: { y: 2, x: 3 } } });
  const expected = digest('{"messages":["合成一","合成二"],"model":"synthetic-snapshot","params":{"a":{"x":3,"y":2},"z":1},"tools":[],"vendor":"synthetic-vendor"}');
  expect(modelKey(req)).toBe(expected);
  expect(modelKey({ params: { a: { x: 3, y: 2 }, z: 1 }, tools: [], messages: req.messages,
    model: req.model, vendor: req.vendor })).toBe(expected);
});

it.each<{ field: string; patch: Partial<ModelRequest> }>([
  { field: 'vendor', patch: { vendor: 'another-vendor' } },
  { field: 'model', patch: { model: 'another-snapshot' } },
  { field: 'messages 内容', patch: { messages: ['changed'] } },
  { field: 'messages 顺序', patch: { messages: ['b', 'a'] } },
  { field: 'tools 内容', patch: { tools: [{ name: 'other' }] } },
  { field: 'tools 顺序', patch: { tools: ['b', 'a'] } },
  { field: 'params', patch: { params: { temperature: 1 } } },
])('[B3-01b] modelKey 的 $field 改变时禁止复用录制', ({ patch }) => {
  const req = request({ messages: ['a', 'b'], tools: ['a', 'b'] });
  expect(modelKey({ ...req, ...patch })).not.toBe(modelKey(req));
});

it('[B3-01b] toolKey 仅两个状态集合排序，其余数组保序且不修改输入', () => {
  const original = call({ args: { ordered: ['b', 'a'] } });
  const before = structuredClone(original);
  const sorted = { ...original, state: { turn: 1, result_set_ids: ['rs-B', 'rs-a'], tool_set: ['parse_input', 'search_products'] } };
  expect(toolKey(original)).toBe(digest(canonicalJson(sorted)));
  expect(toolKey({ ...original, state: { turn: 1, result_set_ids: ['rs-a', 'rs-B'], tool_set: ['search_products', 'parse_input'] } })).toBe(toolKey(original));
  expect(original).toEqual(before);
  expect(toolKey({ ...original, args: { ordered: ['a', 'b'] } })).not.toBe(toolKey(original));
});

it.each<{ field: string; patch: Partial<ToolCall> }>([
  { field: '工具名', patch: { name: 'parse_input' } },
  { field: '参数', patch: { args: { q: '另一合成文具' } } },
  { field: '配置', patch: { config_fingerprint: 'config-v2' } },
  { field: '轮次', patch: { state: { ...call().state, turn: 2 } } },
  { field: '结果集', patch: { state: { ...call().state, result_set_ids: ['rs-new'] } } },
  { field: '主体过滤后的工具集', patch: { state: { ...call().state, tool_set: [] } } },
])('[B3-01b] toolKey 包含 $field，避免跨状态匹配', ({ patch }) => {
  expect(toolKey(call(patch))).not.toBe(toolKey(call()));
});

it('[B3-01b] RecordingMiss 是携带 kind 和 key 的 Error', () => {
  const miss = new RecordingMiss('tool', 'f'.repeat(64));
  expect(miss).toBeInstanceOf(Error);
  expect(miss.kind).toBe('tool');
  expect(miss.key).toBe('f'.repeat(64));
});

it('[B3-01b] 回放按内容查找，可重复命中、忽略对象键序与录制行顺序、分别追踪 unused', () => {
  const req = request({ params: { a: 1, z: 2 } });
  const tool = call();
  const records = [
    recording({ key: modelKey(req), response: { result: 'model-A' } }),
    recording({ kind: 'tool', key: toolKey(tool), response: ['tool-B'] }),
    recording({ key: 'f'.repeat(64), response: null }),
  ];
  for (const lines of [records, [...records].reverse()]) {
    const { store, problems } = loadRecordings(`\n${jsonl(lines)}\r\n\n`, 'synthetic.jsonl');
    expect(problems).toEqual([]);
    expect(store.unused()).toHaveLength(3);
    expect(store.tool(tool)).toEqual(['tool-B']);
    expect(store.model(req)).toEqual({ result: 'model-A' });
    expect(store.model({ ...req, params: { z: 2, a: 1 } })).toEqual({ result: 'model-A' });
    expect(store.tool({ ...tool, state: { ...tool.state, tool_set: [...tool.state.tool_set].reverse() } })).toEqual(['tool-B']);
    expect(store.unused()).toEqual([{ kind: 'model', key: 'f'.repeat(64) }]);
  }
});

it('[B3-01b] 空录制合法；缺录制不拿下一条，抛对应 kind 与请求 key，unused 不变', () => {
  expect(loadRecordings(' \n\r\n', 'empty.jsonl').problems).toEqual([]);
  const { store } = loadRecordings(jsonl([recording()]), 'unrelated.jsonl');
  for (const [kind, key, lookup] of [
    ['model', modelKey(request()), () => store.model(request())],
    ['tool', toolKey(call()), () => store.tool(call())],
  ] as const) {
    expect(lookup).toThrow(RecordingMiss);
    try { lookup(); } catch (error) { expect(error).toMatchObject({ kind, key }); }
  }
  expect(store.unused()).toEqual([{ kind: 'model', key: 'a'.repeat(64) }]);
});

it.each<[string, unknown]>([
  ['多余字段', { ...recording(), extra: true }],
  ...['kind', 'key', 'response', 'recorded_at'].map((field): [string, unknown] => [
    `缺少 ${field}`, Object.fromEntries(Object.entries(recording()).filter(([key]) => key !== field)),
  ]),
  ['kind 越界', recording({ kind: 'other' as 'model' })],
  ['key 大写', recording({ key: 'A'.repeat(64) })],
  ['key 短', recording({ key: 'a'.repeat(63) })],
  ['key 非 hex', recording({ key: 'g'.repeat(64) })],
  ['无时区', recording({ recorded_at: '2026-10-06T09:00:00' })],
  ['日期不是字符串', { ...recording(), recorded_at: 123 }],
  ['非对象', null],
])('[B3-01b] 录制结构错误 %s 报 schema 和物理行号，后续有效录制可加载', (_label, invalid) => {
  const { store, problems } = loadRecordings(`\n${JSON.stringify(invalid)}\n\n${jsonl([recording()])}`, 'bad.jsonl');
  expect(problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'schema', file: 'bad.jsonl', line: 2 })]));
  expect(store.unused()).toEqual([{ kind: 'model', key: 'a'.repeat(64) }]);
});

it('[B3-01b] 非 JSON 行返回有文件与行号的问题，不阻止后续有效行', () => {
  const { problems, store } = loadRecordings(`\n{broken\n${jsonl([recording()])}`, 'broken.jsonl');
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatchObject({ file: 'broken.jsonl', line: 2 });
  expect(store.unused()).toHaveLength(1);
});

it('[B3-01b] 同 kind+key 的等价响应去重；时间不同不冲突，kind 不同不合并', () => {
  const { problems, store } = loadRecordings(jsonl([
    recording({ response: { z: 1, a: [2, 3] } }),
    recording({ response: { a: [2, 3], z: 1 }, recorded_at: '2026-10-06T02:00:00Z' }),
    recording({ kind: 'tool', response: 'other-kind' }),
  ]), 'duplicate.jsonl');
  expect(problems).toEqual([]);
  expect(store.unused()).toEqual(expect.arrayContaining([
    { kind: 'model', key: 'a'.repeat(64) }, { kind: 'tool', key: 'a'.repeat(64) },
  ]));
  expect(store.unused()).toHaveLength(2);
});

it.each([null, false, [2, 1], { a: 2 }].map((response) => ({ response })))(
  '[B3-01b] 同 key 不同 response=$response 报 recording_conflict', ({ response }) => {
  const { problems } = loadRecordings(jsonl([recording({ response: [1, 2] }), recording({ response })]), 'conflict.jsonl');
  expect(problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'recording_conflict' })]));
});

it.each([null, false, 0, '', ['synthetic'], { nested: { value: 1 } }].map((response) => ({ response })))(
  '[B3-01b] 录制 response=$response 不解释原样交回', ({ response }) => {
  const req = request();
  const { store, problems } = loadRecordings(jsonl([recording({ key: modelKey(req), response })]), 'response.jsonl');
  expect(problems).toEqual([]);
  expect(store.model(req)).toEqual(response);
  expect(store.unused()).toEqual([]);
});
