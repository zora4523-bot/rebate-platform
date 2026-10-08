import { expect, it } from 'vitest';
import {
  at,
  check,
  compile,
  contract,
  endpoints,
  envelope,
  errorCodes,
  examples,
  list,
  liveCode,
  object,
  operation,
  sendPath,
  session,
  text,
  type Obj,
} from './kit.ts';

// CT-08d §9 是本组形状断言的依据；不覆盖 CT-08e 或消息受理的运行时顺序。
it.each(endpoints)(
  '[AC-CT-08d#1] %s %s（%s）的共同标注、请求头和错误外壳',
  async (method, path, id) => {
    const doc = await contract();
    const op = operation(doc, method, path);
    expect(op['operationId']).toBe(id);
    expect(list(doc['tags']).map((tag) => object(tag)['name'])).toContain('agent');
    expect(list(op['tags'])).toContain('agent');
    expect(op['x-auth']).toBe('optional');
    expect(op['security']).toEqual([{}, { bearerAuth: [] }]);
    expect(op['x-signed']).toBe(false);
    expect(op['x-idempotent']).toBe(false);
    expect(op['x-implementation']).toBe('planned');
    expect(op).not.toHaveProperty('x-session-scopes');
    if (method === 'post') {
      expect(op['x-min-version-gate']).toBe(true);
      expect(list(op['x-error-codes'])).toContain(10405);
    } else {
      expect(op).not.toHaveProperty('x-min-version-gate');
    }
    const parameters = [
      ...list(at(doc, 'paths', path)['parameters'] ?? []),
      ...list(op['parameters']),
    ].map(object);
    const headers = parameters.filter((parameter) => parameter['in'] === 'header');
    expect(headers).toContainEqual(
      expect.objectContaining({ name: 'X-Device-Id', required: true }),
    );
    const names = headers.map((header) => text(header['name']).toLowerCase());
    for (const forbidden of ['x-timestamp', 'x-nonce', 'x-sign', 'idempotency-key']) {
      expect(names).not.toContain(forbidden);
    }
    expect(at(op, 'responses', '429', 'headers', 'Retry-After')['required']).toBe(true);
    for (const status of ['4XX', '5XX']) {
      const content = at(op, 'responses', status, 'content');
      expect(Object.keys(content)).toEqual(['application/json']);
      expect(at(content, 'application/json', 'schema')).toEqual(
        at(doc, 'components', 'schemas', 'ErrorEnvelope'),
      );
    }
  },
);

it.each(endpoints)(
  '[AC-CT-08d#2] %s %s（%s）声明所需且仍有效的错误码',
  async (method, path, id) => {
    const op = operation(await contract(), method, path);
    const required = [30501, 10001, 10005, 10004];
    if (id === 'sendAgentMessage') required.push(30504, 20001, 30506, 30502, 50302);
    if (id === 'cancelAgentRun') required.push(30505);
    if (method === 'post') required.push(10405);
    const listed = list(op['x-error-codes']);
    expect(listed).toEqual(expect.arrayContaining(required));
    const codes = errorCodes();
    for (const code of listed) {
      expect(code).toBeTypeOf('number');
      liveCode(codes, code as number);
    }
    if (id === 'cancelAgentRun') expect(listed).not.toContain(30504);
  },
);

it('[AC-CT-08d#3] 新建会话无请求体，返回封闭且必填的会话数据及合法示例', async () => {
  const op = operation(await contract(), 'post', '/v1/agent/sessions');
  expect(op).not.toHaveProperty('requestBody');
  const media = at(op, 'responses', '200', 'content', 'application/json');
  const schema = at(media, 'schema');
  const data = at(schema, 'properties', 'data');
  expect(data['additionalProperties']).toBe(false);
  expect(list(data['required'])).toEqual(expect.arrayContaining(Object.keys(session)));
  const validate = compile(schema);
  check(validate, envelope(session), true);
  for (const example of examples(media)) check(validate, example, true);
  for (const key of Object.keys(session)) {
    const missing: Obj = { ...session };
    delete missing[key];
    check(validate, envelope(missing), false);
  }
  check(validate, envelope({ ...session, extra: true }), false);
  const missingData = envelope(session);
  delete missingData['data'];
  check(validate, missingData, false);
});

it('[AC-CT-08d#4] 当前会话 data 只有必填 session，接受会话或 null 并提供空态示例', async () => {
  const op = operation(await contract(), 'get', '/v1/agent/sessions/current');
  const media = at(op, 'responses', '200', 'content', 'application/json');
  const schema = at(media, 'schema');
  const data = at(schema, 'properties', 'data');
  expect(Object.keys(at(data, 'properties'))).toEqual(['session']);
  expect(data['required']).toEqual(['session']);
  expect(data['additionalProperties']).toBe(false);
  const validate = compile(schema);
  for (const value of [session, null]) check(validate, envelope({ session: value }), true);
  for (const value of [{}, { session: 42 }, { session: null, extra: true }]) {
    check(validate, envelope(value), false);
  }
  for (const key of Object.keys(session)) {
    const missing: Obj = { ...session };
    delete missing[key];
    check(validate, envelope({ session: missing }), false);
  }
  check(validate, envelope({ session: { ...session, extra: true } }), false);
  const missingData = envelope({ session: null });
  delete missingData['data'];
  check(validate, missingData, false);
  const values = examples(media);
  for (const value of values) check(validate, value, true);
  expect(values.some((value) => at(value, 'data')['session'] === null)).toBe(true);
});

async function messageSchema(): Promise<Obj> {
  const op = operation(await contract(), 'post', sendPath);
  const body = at(op, 'requestBody');
  expect(body['required']).toBe(true);
  const content = at(body, 'content');
  expect(Object.keys(content)).toEqual(['application/json']);
  const schema = at(content, 'application/json', 'schema');
  expect(schema['additionalProperties']).toBe(false);
  expect(list(schema['required'])).toEqual(expect.arrayContaining(['client_msg_id', 'text']));
  expect(list(schema['required'])).not.toContain('context');
  return schema;
}

const message = { client_msg_id: 'Ab09_-xy', text: '帮我找牛奶' };

it('[AC-CT-08d#5] 消息必填、封闭，client_msg_id 仅接受 8–64 位字母数字下划线短横线', async () => {
  const validate = compile(await messageSchema());
  for (const client_msg_id of ['Ab09_-xy', 'A'.repeat(64)]) {
    check(validate, { ...message, client_msg_id }, true);
  }
  for (const client_msg_id of [
    'a'.repeat(7),
    'a'.repeat(65),
    'abcd efgh',
    'abcdefgh\n',
    '中文消息标识符号',
    12345678,
    null,
  ]) {
    check(validate, { ...message, client_msg_id }, false);
  }
  check(validate, { text: message.text }, false);
  check(validate, { ...message, extra: true }, false);
});

it('[AC-CT-08d#5] text 非空必填但 schema 不设 maxLength，600 字留给业务顺序校验', async () => {
  const schema = await messageSchema();
  expect(at(schema, 'properties', 'text')).not.toHaveProperty('maxLength');
  const validate = compile(schema);
  check(validate, message, true);
  check(validate, { ...message, text: '奶'.repeat(600) }, true);
  check(validate, { client_msg_id: message.client_msg_id }, false);
  for (const text of ['', null, 123, {}]) check(validate, { ...message, text }, false);
});

it('[AC-CT-08d#5] context 可省略或仅含 product_key、order_id、text 之一，文本上限 2000 字', async () => {
  const validate = compile(await messageSchema());
  const contexts = [
    { product_key: 'tb:7Kq9LmN3pQ' },
    { order_id: '019a0000-0000-7000-8000-000000000003' },
    { text: '奶'.repeat(2000) },
  ];
  check(validate, message, true);
  for (const context of contexts) {
    check(validate, { ...message, context }, true);
    check(validate, { ...message, context: { ...context, extra: true } }, false);
  }
  for (let i = 0; i < contexts.length; i++) {
    for (let j = i + 1; j < contexts.length; j++) {
      check(validate, { ...message, context: { ...contexts[i], ...contexts[j] } }, false);
    }
  }
  for (const context of [{}, null, [], { text: '奶'.repeat(2001) }]) {
    check(validate, { ...message, context }, false);
  }
});

it('[AC-CT-08d#7] 停止生成无请求体，200 复用 EmptyResponse 且 data 为空对象', async () => {
  const doc = await contract();
  const op = operation(doc, 'post', '/v1/agent/runs/{run_id}/cancel');
  expect(op).not.toHaveProperty('requestBody');
  const schema = at(op, 'responses', '200', 'content', 'application/json', 'schema');
  expect(schema).toEqual(at(doc, 'components', 'schemas', 'EmptyResponse'));
  const validate = compile(schema);
  check(validate, envelope({}), true);
  for (const data of [null, [], '', { run_id: 'unexpected' }])
    check(validate, envelope(data), false);
  const missing = envelope({});
  delete missing['data'];
  check(validate, missing, false);
});

it('[AC-CT-08d#8] 30501–30506 有效，30502 登记 reset_at 与准确的 next 取值', () => {
  const codes = errorCodes();
  for (const code of [30501, 30502, 30503, 30504, 30505, 30506]) liveCode(codes, code);
  const data = at(liveCode(codes, 30502), 'data');
  expect(data).toHaveProperty('reset_at');
  expect(list(data['next']).toSorted()).toEqual(['bind_phone', 'login', 'none']);
});

it('[AC-CT-08d#8] 30506 含义包括重复 client_msg_id 的原 run 仍在进行', () => {
  const meaning = text(liveCode(errorCodes(), 30506)['meaning']);
  expect(meaning).toContain('client_msg_id');
  expect(meaning).toMatch(/重复|duplicate|repeat/iu);
  expect(meaning).toMatch(/进行中|未结束|in.progress|running/iu);
});
