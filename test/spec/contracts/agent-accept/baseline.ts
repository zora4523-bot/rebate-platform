import { expect } from 'vitest';
import { at, check, compile, list, shape, text, type Obj } from './kit.ts';

// CT-08d（47eaf92 / #290）的形状，保留已合并 CT-01e（fa8b610）的 trace 头与 SSE 结尾空行。
// 逐项断言固定基线，不在运行时从 Git 或待测 YAML 生成期望值。
export const sendPath = '/v1/agent/sessions/{id}/messages';
export const cancelPath = '/v1/agent/runs/{run_id}/cancel';
const id = { type: 'string', minLength: 1, maxLength: 64 };
const traceId = { ...id, pattern: '^[A-Za-z0-9_-]+$' };
const traceHeader = { required: true, schema: traceId };
const headers = [
  {
    name: 'X-App-Id',
    in: 'header',
    required: true,
    schema: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[a-z0-9_]+$' },
  },
  {
    name: 'X-Platform',
    in: 'header',
    required: true,
    schema: { type: 'string', enum: ['ios', 'android', 'harmony', 'h5', 'admin'] },
  },
  {
    name: 'X-App-Version',
    in: 'header',
    required: true,
    schema: { type: 'string', pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+$', maxLength: 32 },
  },
  { name: 'X-Build', in: 'header', required: false, schema: { type: 'string', maxLength: 32 } },
  {
    name: 'X-Channel',
    in: 'header',
    required: false,
    schema: { type: 'string', enum: ['appstore', 'official', 'huawei', 'agc'] },
  },
  { name: 'X-Trace-Id', in: 'header', required: false, schema: traceId },
  { name: 'X-Device-Id', in: 'header', required: true, schema: id },
];

export function commonShape(doc: Obj, path: string, operationId: string, pathName: string): Obj {
  const item = at(doc, 'paths', path);
  const op = at(item, 'post');
  expect(op['operationId']).toBe(operationId);
  // B3-03f implements the four session / message operations (planned removed, approvals #31).
  expect(op).not.toHaveProperty('x-implementation');
  expect(op['x-auth']).toBe('optional');
  expect(op['security']).toEqual([{}, { bearerAuth: [] }]);
  expect(op['x-min-version-gate']).toBe(true);
  expect(op['x-signed']).toBe(false);
  expect(op['x-idempotent']).toBe(false);
  expect(op).not.toHaveProperty('x-session-scopes');
  expect(item).not.toHaveProperty('parameters');
  expect(shape(list(op['parameters']))).toEqual([
    ...headers,
    { name: pathName, in: 'path', required: true, schema: id },
  ]);
  return op;
}

const requestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['client_msg_id', 'text'],
  properties: {
    client_msg_id: { type: 'string', minLength: 8, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' },
    text: { type: 'string', minLength: 1 },
    context: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['product_key'],
          properties: { product_key: { type: 'string', minLength: 3, maxLength: 128 } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['order_id'],
          properties: { order_id: id },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } },
        },
      ],
    },
  },
};

// 只锁定三个既有示例的原文；不解析、不测试 SSE 帧语义（由 agent-http / agent-stream 覆盖）。
const streamExamples = {
  accepted: {
    summary: 'An accepted message answered with one page guide card',
    value:
      'event: meta\nid: 1\ndata: {"session_id":"019a0000-0000-7000-8000-000000000021","run_id":"019a0000-0000-7000-8000-000000000121","message_id":"019a0000-0000-7000-8000-000000000221","prompt_version":"demo-prompt-v1","model_label":"演示模型","ai_label":"内容由 AI 生成，仅供参考","duplicate":false}\n\n: ping\n\nevent: card\nid: 2\ndata: {"seq":2,"card_id":"c1","type":"page_guide","schema_version":1,"data":{"route":"WithdrawRecords","text_key":"agent.guide.WithdrawRecords"},"fallback_text":"提现进度在提现记录里查看。"}\n\nevent: done\nid: 3\ndata: {"finish_reason":"stop","quota_left":24}\n\n',
  },
  duplicateEnded: {
    summary: 'A repeated client_msg_id whose run has ended',
    value:
      'event: meta\nid: 1\ndata: {"session_id":"019a0000-0000-7000-8000-000000000021","run_id":"019a0000-0000-7000-8000-000000000121","message_id":"019a0000-0000-7000-8000-000000000221","prompt_version":"demo-prompt-v1","model_label":"演示模型","ai_label":"内容由 AI 生成，仅供参考","duplicate":true}\n\nevent: done\nid: 2\ndata: {"finish_reason":"stop","quota_left":24}\n\n',
  },
  duplicateInProgress: {
    summary: 'A repeated client_msg_id whose run is still running',
    value:
      'event: meta\nid: 1\ndata: {"session_id":"019a0000-0000-7000-8000-000000000021","run_id":"019a0000-0000-7000-8000-000000000123","message_id":"019a0000-0000-7000-8000-000000000223","prompt_version":"demo-prompt-v1","model_label":"演示模型","ai_label":"内容由 AI 生成，仅供参考","duplicate":true}\n\nevent: error\nid: 2\ndata: {"code":30506,"msg":"上一条还在回复中","retryable":true,"fallback":null,"fallback_q":null}\n\n',
  },
};

export function sendShape(op: Obj): void {
  const body = at(op, 'requestBody');
  expect(shape(body)).toEqual({
    required: true,
    content: {
      'application/json': {
        schema: requestSchema,
        example: { client_msg_id: 'msg-20261006-0001', text: '提现记录在哪看' },
      },
    },
  });
  const media = at(body, 'content', 'application/json');
  const validate = compile(at(media, 'schema'));
  check(validate, media['example'], true);
  check(validate, { text: '缺少幂等键' }, false);
  check(validate, { client_msg_id: 'msg-20261006-0001' }, false);
  const response = at(op, 'responses', '200');
  expect(shape(at(response, 'headers'))).toEqual({
    'X-Trace-Id': traceHeader,
    'Cache-Control': { required: true, schema: { type: 'string', enum: ['no-cache'] } },
  });
  expect(Object.keys(at(response, 'content'))).toEqual(['text/event-stream']);
  const stream = at(response, 'content', 'text/event-stream');
  expect(shape(at(stream, 'schema'))).toEqual({ type: 'string' });
  expect(Object.keys(stream).toSorted()).toEqual(['examples', 'schema']);
  const examples = at(stream, 'examples');
  expect(Object.keys(examples).toSorted()).toEqual(Object.keys(streamExamples).toSorted());
  for (const [name, expected] of Object.entries(streamExamples)) {
    expect(at(examples, name), `CT-08d SSE 示例 ${name} 必须保留`).toEqual(expected);
  }
}

export function cancelShape(op: Obj): void {
  expect(op).not.toHaveProperty('requestBody');
  const response = at(op, 'responses', '200');
  expect(shape(at(response, 'headers'))).toEqual({ 'X-Trace-Id': traceHeader });
  expect(Object.keys(at(response, 'content'))).toEqual(['application/json']);
  const media = at(response, 'content', 'application/json');
  const schema = at(media, 'schema');
  expect(shape(schema)).toEqual({
    type: 'object',
    additionalProperties: false,
    required: ['code', 'msg', 'data', 'trace_id'],
    properties: {
      code: { type: 'integer', format: 'int32', enum: [0] },
      msg: { type: 'string' },
      data: { type: 'object', additionalProperties: false },
      trace_id: traceId,
    },
  });
  const example = { code: 0, msg: '', data: {}, trace_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b' };
  expect(media['example']).toEqual(example);
  const validate = compile(schema);
  check(validate, example, true);
  for (const data of [null, [], { run_id: 'unexpected' }]) {
    check(validate, { ...example, data }, false);
  }
}

export function description(op: Obj): string {
  // YAML 的换行不改变英文标记；保留大小写，不整句比对。
  return text(op['description']).replace(/\s+/gu, ' ');
}

export function acceptanceOrder(op: Obj): void {
  const value = description(op);
  const markers = [
    '① 30501',
    '② 10001 / 10005',
    '③ 10004',
    '④ 30504',
    '⑤ 20001',
    '⑥ repeated client_msg_id',
    '⑦ 30506',
    '⑧ 42901',
    '⑨ 30504',
    '⑩ 30502',
  ];
  let previous = -1;
  for (const marker of markers) {
    expect(value).toContain(marker);
    const index = value.indexOf(marker);
    expect(index, `受理顺序 ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}
