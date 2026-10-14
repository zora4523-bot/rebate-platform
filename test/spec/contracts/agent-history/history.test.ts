import { expect, it } from 'vitest';
import {
  at,
  check,
  closed,
  compile,
  contract,
  envelope,
  finishReasons,
  historyMedia,
  historyPath,
  list,
  message,
  messageSchema,
  operation,
  parameters,
  testRequire,
  text,
  type Obj,
} from './kit.ts';

it('[AC-CT-08e#3] 历史复用 Cursor/Limit，limit 允许 50，拒绝 51 和小数', async () => {
  const doc = await contract();
  const params = parameters(doc, 'get', historyPath);
  for (const [name, component] of [
    ['cursor', 'Cursor'],
    ['limit', 'Limit'],
  ]) {
    const matches = params.filter((param) => param['name'] === name && param['in'] === 'query');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(at(doc, 'components', 'parameters', component!));
  }
  const validate = compile(at(doc, 'components', 'parameters', 'Limit', 'schema'));
  check(validate, 50, true);
  check(validate, 51, false);
  check(validate, 1.5, false);
});

it('[AC-CT-08e#3] 历史 data 只有必填 items/next_cursor/expired（BR-AI-20），不接纳旧草稿字段', async () => {
  const schema = at(historyMedia(await contract()), 'schema');
  const data = at(schema, 'properties', 'data');
  closed(data, ['items', 'next_cursor', 'expired']);
  expect(at(data, 'properties', 'expired')['type']).toBe('boolean');
  expect(at(data, 'properties', 'items')['type']).toBe('array');
  const validate = compile(schema);
  for (const next_cursor of [null, 'opaque-older-page']) {
    check(validate, envelope({ items: [], next_cursor, expired: false }), true);
  }
  const valid = { items: [message], next_cursor: null, expired: false };
  check(validate, envelope({ ...valid, expired: true }), true);
  check(validate, envelope(valid), true);
  for (const key of ['items', 'next_cursor', 'expired']) {
    const missing: Obj = { ...valid };
    delete missing[key];
    check(validate, envelope(missing), false);
  }
  for (const expired of [null, 'true', 1]) {
    check(validate, envelope({ ...valid, expired }), false);
  }
  for (const key of ['session_id', 'run_id', 'extra']) {
    check(validate, envelope({ ...valid, [key]: true }), false);
  }
  for (const items of [null, {}, 'messages']) {
    check(validate, envelope({ ...valid, items }), false);
  }
  for (const next_cursor of [1, false, {}, []]) {
    check(validate, envelope({ ...valid, next_cursor }), false);
  }
  const missingData = envelope(valid);
  delete missingData['data'];
  check(validate, missingData, false);
});

it('[AC-CT-08e#4] 历史逐条消息六字段必填且封闭，支持空文本与两个角色', async () => {
  const schema = messageSchema(await contract());
  closed(schema, ['message_id', 'role', 'created_at', 'text', 'cards', 'finish_reason']);
  expect(list(at(schema, 'properties', 'role')['enum']).toSorted()).toEqual(['assistant', 'user']);
  expect(at(schema, 'properties', 'created_at')['format']).toBe('date-time');
  expect(at(schema, 'properties', 'text')['type']).toBe('string');
  expect(at(schema, 'properties', 'cards')['type']).toBe('array');
  const validate = compile(schema);
  for (const role of ['user', 'assistant']) {
    check(validate, { ...message, role, text: '原文保留' }, true);
  }
  check(validate, message, true);
  for (const key of Object.keys(message)) {
    const missing: Obj = { ...message };
    delete missing[key];
    check(validate, missing, false);
  }
  for (const key of ['seq', 'run_id', 'status', 'content_status', 'client_msg_id', 'extra']) {
    check(validate, { ...message, [key]: 'unexpected' }, false);
  }
  for (const role of ['system', 'tool', '', null]) check(validate, { ...message, role }, false);
  for (const created_at of ['2026-10-14', 'invalid', '2026-02-30T10:00:00Z', null, 42]) {
    check(validate, { ...message, created_at }, false);
  }
  for (const text of [null, 42, {}, []]) check(validate, { ...message, text }, false);
  for (const cards of [null, {}, 'card']) check(validate, { ...message, cards }, false);
});

// nullable 包装可用 anyOf/oneOf；绑定必须落在该字段实际引用的枚举节点上。
function enumNodes(schema: Obj): Obj[] {
  const nodes = [schema];
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    if (schema[keyword] !== undefined) {
      for (const child of list(schema[keyword])) nodes.push(...enumNodes(at(child)));
    }
  }
  return nodes;
}

it('[AC-CT-08e#4] finish_reason 接受现行枚举或 null，且实际字段登记 ENUM_BINDINGS', async () => {
  const doc = await contract();
  const schema = at(messageSchema(doc), 'properties', 'finish_reason');
  const values = finishReasons();
  const validate = compile(schema);
  for (const value of [...values, null]) check(validate, value, true);
  for (const value of ['', 'not_a_finish_reason', 1, false, {}, []]) check(validate, value, false);
  const { ENUM_BINDINGS } = testRequire(
    '../../../../packages/contracts-ts/scripts/conformance.ts',
  ) as {
    ENUM_BINDINGS: Readonly<Record<string, string>>;
  };
  const nodes = enumNodes(schema);
  const matches = Object.entries(ENUM_BINDINGS).filter(([pointer, name]) => {
    if (name !== 'agent_finish_reason') return false;
    const target = at(doc, 'components', 'schemas', ...pointer.split('/'));
    return nodes.includes(target);
  });
  expect(matches, '绑定必须引用历史字段使用的枚举对象，不能只登记一个无关 schema').not.toHaveLength(
    0,
  );
  for (const [pointer] of matches) {
    expect(
      list(at(doc, 'components', 'schemas', ...pointer.split('/'))['enum']).toSorted(),
    ).toEqual(values.toSorted());
  }
});

it('[AC-CT-08e#4] 历史卡片五字段封闭，不带 seq，未知类型仍可按 fallback_text 降级', async () => {
  const schema = at(messageSchema(await contract()), 'properties', 'cards', 'items');
  closed(schema, ['card_id', 'type', 'schema_version', 'data', 'fallback_text']);
  expect(at(schema, 'properties', 'card_id')['pattern']).toBe('^c[1-9][0-9]*$');
  expect(at(schema, 'properties', 'type')['type']).toBe('string');
  expect(at(schema, 'properties', 'schema_version')['type']).toBe('integer');
  expect(at(schema, 'properties', 'data')['type']).toBe('object');
  const card = {
    card_id: 'c1',
    type: 'future_card',
    schema_version: 1,
    data: { future_payload: 'preserved' },
    fallback_text: '请更新客户端查看此卡片',
  };
  const validate = compile(schema);
  check(validate, card, true);
  check(validate, { ...card, card_id: 'c123', schema_version: 2 }, true);
  for (const key of Object.keys(card)) {
    const missing: Obj = { ...card };
    delete missing[key];
    check(validate, missing, false);
  }
  for (const card_id of ['c0', 'C1', 'c01', '', 1, null]) {
    check(validate, { ...card, card_id }, false);
  }
  for (const schema_version of [0, -1, 1.5, '1', null]) {
    check(validate, { ...card, schema_version }, false);
  }
  for (const type of [null, 1, {}]) check(validate, { ...card, type }, false);
  for (const data of [null, [], 'data', 1]) check(validate, { ...card, data }, false);
  for (const fallback_text of ['', null, 1]) check(validate, { ...card, fallback_text }, false);
  for (const key of ['seq', 'extra']) check(validate, { ...card, [key]: 1 }, false);
});

it('[AC-CT-08e#6] 历史说明交代归属、过期只读、更早游标和收益卡留存投影', async () => {
  const op = operation(await contract(), 'get', historyPath);
  const description = text(op['description']);
  expect(description).toMatch(/所有者|owner/iu);
  expect(description).toContain('30504');
  expect(description).toMatch(/过期|expired/iu);
  expect(description).toMatch(/只读|read.only/iu);
  expect(description).toContain('next_cursor');
  expect(description).toContain('null');
  expect(description).toMatch(/更早|earlier|older/iu);
  expect(description).toContain('earnings_summary_history');
  expect(description).toContain('as_of');
  expect(description).toMatch(/按钮|actions|buttons/iu);
  expect(description).toMatch(
    /不.{0,12}(回放|重放)|not.{0,16}replay|never.{0,16}replay|no.{0,16}replay|omit/iu,
  );
  for (const event of ['tool.status', 'ping', 'suggestions', 'meta']) {
    expect(description).toContain(event);
  }
});
