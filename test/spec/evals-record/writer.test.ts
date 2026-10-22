import { expect, it, vi } from 'vitest';
import {
  createRecordingWriter,
  loadRecordings,
  redactRecorded,
} from '../../../packages/evals/src/index.ts';
import type { Recording } from '../../../packages/evals/src/index.ts';
import { AT, call, clock, digest, livePorts, recordingValidator, request } from './kit.ts';

it('[AC-B3-01h#1][BR-AI-21] 四字段 JSONL、内容键、注入时刻与 kind/key 排序可被独立 schema 和加载器读取', async () => {
  const writer = createRecordingWriter({ clock });
  const model = vi.fn(async () => ({ answer: '合成响应' }));
  const tool = vi.fn(async () => ({ ok: true }));
  const ports = writer.wrap({ model, tool });
  const req = request();
  const tc = call();
  const original = structuredClone({ req, tc });
  // 独立固定序列化文本，不用 writer/modelKey/toolKey 推算期望。
  const base =
    '{"messages":[{"content":"合成消息","role":"user"}],"model":"synthetic-snapshot","params":{"temperature":0},"tools":[],"vendor":"synthetic-vendor"}';
  const toolCanonical =
    '{"args":{"q":"合成文具"},"config_fingerprint":"synthetic-config-v1","name":"search_products","state":{"result_set_ids":["rs-B","rs-a"],"tool_set":["parse_input","search_products"],"turn":1}}';
  const changed = { ...req, params: { temperature: 1 } };
  const changedKey = digest(base.replace('temperature":0', 'temperature":1'));
  const descending = digest(base) > changedKey ? [req, changed] : [changed, req];
  await ports.tool(tc);
  for (const item of descending) await ports.model(item);
  const expected: Recording[] = [
    { kind: 'model', key: digest(base), response: { answer: '合成响应' }, recorded_at: AT },
    {
      kind: 'model',
      key: digest(base.replace('temperature":0', 'temperature":1')),
      response: { answer: '合成响应' },
      recorded_at: AT,
    },
    { kind: 'tool', key: digest(toolCanonical), response: { ok: true }, recorded_at: AT },
  ].sort((a, b) =>
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.key < b.key ? -1 : 1,
  ) as Recording[];
  expect(writer.lines()).toEqual(expected);
  expect({ req, tc }).toEqual(original);
  expect(model.mock.calls).toEqual(descending.map((item) => [item]));
  expect(tool.mock.calls).toEqual([[tc]]);
  const lines = writer
    .toJsonl()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
  expect(lines).toEqual(expected);
  const valid = recordingValidator();
  for (const line of lines) expect(valid(line), JSON.stringify(valid.errors)).toBe(true);
  const loaded = loadRecordings(writer.toJsonl(), 'synthetic.jsonl');
  expect(loaded.problems).toEqual([]);
  expect(loaded.store.model(req)).toEqual({ answer: '合成响应' });
  expect(loaded.store.tool(tc)).toEqual({ ok: true });
  expect(writer.problems()).toEqual([]);
});

it('[AC-B3-01h#1][BR-AI-21] 工具集合顺序不改变键，模型消息顺序改变键', async () => {
  const writer = createRecordingWriter({ clock });
  const ports = writer.wrap(livePorts());
  const tc = call();
  await ports.tool(tc);
  await ports.tool({
    ...tc,
    state: {
      ...tc.state,
      result_set_ids: [...tc.state.result_set_ids].reverse(),
      tool_set: [...tc.state.tool_set].reverse(),
    },
  });
  await ports.model(request({ messages: ['合成甲', '合成乙'] }));
  await ports.model(request({ messages: ['合成乙', '合成甲'] }));
  expect(writer.lines().filter((line) => line.kind === 'tool')).toHaveLength(1);
  const keys = writer
    .lines()
    .filter((line) => line.kind === 'model')
    .map((line) => line.key);
  expect(new Set(keys).size).toBe(2);
  expect(writer.problems()).toEqual([]);
});

// §9 指定的身份字段初始清单和鉴权键；不从待实现函数读取期望。
const identities = [
  'user_id',
  'uid',
  'app_id',
  'device_id',
  'scene',
  'pid',
  'p_id',
  'adzone_id',
  'site_id',
  'position_id',
  'relation_id',
  'special_id',
  'sub_union_id',
  'custom_parameters',
  'union_id',
];
const forbiddenKeys = [
  ...identities.flatMap((key) => [
    key,
    key.toUpperCase().replaceAll('_', '-'),
    key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase()),
  ]),
  'Authorization',
  'PROXY-AUTHORIZATION',
  'X-API-KEY',
  'api-key',
  'api_key',
  'ApiKey',
  'Cookie',
  'SET-COOKIE',
];

it('[AC-B3-01h#2][BR-AI-21] 递归剥离所有身份与鉴权键，数组和非敏感字段保持原样且深拷贝', () => {
  const secret = Object.fromEntries(
    forbiddenKeys.map((key, i) => [key, `Bearer sk-SYNTHETIC-${i}`]),
  );
  const original = {
    ...secret,
    nested: [{ ...secret, keep: { title: '合成标题', active: false, amount: 0, empty: null } }],
    positionLabel: '合成位置',
    authorizationHint: '合成提示',
  };
  const before = structuredClone(original);
  const clean = redactRecorded(original);
  expect(clean).toEqual({
    nested: [{ keep: { title: '合成标题', active: false, amount: 0, empty: null } }],
    positionLabel: '合成位置',
    authorizationHint: '合成提示',
  });
  expect(original).toEqual(before);
  expect(clean).not.toBe(original);
  original.nested[0]!.keep.title = '修改合成标题';
  expect(JSON.stringify(clean)).not.toContain('修改合成标题');
  expect(JSON.stringify(clean)).not.toContain('sk-SYNTHETIC-');
});

it.each(['model', 'tool'] as const)(
  '[AC-B3-01h#2][BR-AI-21] %s 录制副本不保留嵌套身份和凭据，也不改 live 响应',
  async (kind) => {
    const writer = createRecordingWriter({ clock });
    const response = {
      nested: [
        {
          user_id: 'SYNTHETIC-USER-SECRET',
          positionId: 'SYNTHETIC-POSITION-SECRET',
          Authorization: 'Bearer sk-SYNTHETIC-secret',
          'x-api-key': 'SYNTHETIC-API-SECRET',
          keep: ['合成标题', 0, false, null],
        },
      ],
    };
    const before = structuredClone(response);
    const ports = writer.wrap({ model: async () => response, tool: async () => response });
    if (kind === 'model') await ports.model(request());
    else await ports.tool(call());
    expect(writer.lines()).toHaveLength(1);
    expect(writer.lines()[0]?.response).toEqual({
      nested: [{ keep: ['合成标题', 0, false, null] }],
    });
    expect(response).toEqual(before);
    for (const text of [JSON.stringify(writer.lines()), writer.toJsonl()]) {
      for (const secret of [
        'user_id',
        'positionId',
        'Authorization',
        'x-api-key',
        'SYNTHETIC-USER-SECRET',
        'SYNTHETIC-POSITION-SECRET',
        'sk-SYNTHETIC-secret',
        'SYNTHETIC-API-SECRET',
      ])
        expect(text).not.toContain(secret);
    }
    response.nested[0]!.keep[0] = '修改合成标题';
    expect(writer.toJsonl()).not.toContain('修改合成标题');
  },
);

it.each(['model', 'tool'] as const)(
  '[AC-B3-01h#4][BR-AI-21] %s 重复相同响应去重，异响应报冲突并保留第一条',
  async (kind) => {
    const writer = createRecordingWriter({ clock });
    const responses = [
      { a: '合成第一条', b: true },
      { b: true, a: '合成第一条' },
      { a: '合成冲突条', b: true },
    ];
    const live = vi.fn(async () => responses.shift());
    const ports = writer.wrap({ model: live, tool: live });
    const invoke = () => (kind === 'model' ? ports.model(request()) : ports.tool(call()));
    await invoke();
    await invoke();
    expect(writer.lines()).toHaveLength(1);
    expect(writer.problems()).toEqual([]);
    await invoke();
    expect(live).toHaveBeenCalledTimes(3);
    expect(writer.lines()).toHaveLength(1);
    expect(writer.lines()[0]?.response).toEqual({ a: '合成第一条', b: true });
    expect(writer.problems().map((p) => p.code)).toEqual(['recording_conflict']);
    const loaded = loadRecordings(writer.toJsonl(), 'synthetic.jsonl');
    expect(loaded.problems).toEqual([]);
    const value = kind === 'model' ? loaded.store.model(request()) : loaded.store.tool(call());
    expect(value).toEqual({ a: '合成第一条', b: true });
  },
);

it.each(['model', 'tool'] as const)(
  '[AC-B3-01h#2][AC-B3-01h#4][BR-AI-21] %s 同键响应仅身份字段不同，按剥离后的副本去重且不报冲突',
  async (kind) => {
    const writer = createRecordingWriter({ clock });
    const live = vi
      .fn()
      .mockResolvedValueOnce({
        user_id: 'SYNTHETIC-USER-FIRST',
        nested: [{ device_id: 'SYNTHETIC-DEVICE-FIRST', title: '合成相同商品' }],
      })
      .mockResolvedValueOnce({
        user_id: 'SYNTHETIC-USER-SECOND',
        nested: [{ device_id: 'SYNTHETIC-DEVICE-SECOND', title: '合成相同商品' }],
      });
    const ports = writer.wrap({ model: live, tool: live });
    const invoke = () => (kind === 'model' ? ports.model(request()) : ports.tool(call()));
    await invoke();
    const firstJsonl = writer.toJsonl();
    await invoke();
    expect(live).toHaveBeenCalledTimes(2);
    expect(writer.problems()).toEqual([]);
    expect(writer.lines()).toHaveLength(1);
    expect(writer.lines()[0]?.response).toEqual({ nested: [{ title: '合成相同商品' }] });
    expect(writer.toJsonl()).toBe(firstJsonl);
    expect(writer.toJsonl().trim().split('\n')).toHaveLength(1);
    const loaded = loadRecordings(writer.toJsonl(), 'synthetic.jsonl');
    expect(loaded.problems).toEqual([]);
    const value = kind === 'model' ? loaded.store.model(request()) : loaded.store.tool(call());
    expect(value).toEqual({ nested: [{ title: '合成相同商品' }] });
  },
);

it.each(['model', 'tool'] as const)(
  '[AC-B3-01h#4][BR-AI-21] %s live 抛错保持同一错误、不写行，下一次成功可录制',
  async (kind) => {
    const writer = createRecordingWriter({ clock });
    const failure = new Error('合成上游错误');
    const live = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({ ok: true });
    const ports = writer.wrap({ model: live, tool: live });
    const invoke = () => (kind === 'model' ? ports.model(request()) : ports.tool(call()));
    await expect(invoke()).rejects.toBe(failure);
    expect(writer.lines()).toEqual([]);
    expect(writer.toJsonl().trim()).toBe('');
    expect(writer.problems()).toEqual([]);
    await invoke();
    expect(writer.lines()).toHaveLength(1);
  },
);
