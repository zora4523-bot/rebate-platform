import { expect, it } from 'vitest';
import {
  at,
  check,
  claim,
  claimKeys,
  claimSchema,
  closed,
  compile,
  contract,
  dataSchema,
  endpoints,
  enumValues,
  envelope,
  examples,
  item,
  itemKeys,
  itemSchema,
  list,
  media,
  object,
  responseSchema,
  resolve,
} from './kit.ts';

it.each(endpoints)(
  '[CT-04f#6] %s %s 的用户投影封闭，子项不泄露证据、匹配路径或他人信息',
  (method) => {
    const doc = contract();
    const schema = claimSchema(doc, method);
    closed(schema, claimKeys);
    const properties = at(schema, 'properties');
    expect(at(properties, 'claim_id')['$ref']).toBe('#/components/schemas/Id');
    expect(at(properties, 'platform')['$ref']).toBe('#/components/schemas/PlatformCode');
    expect(resolve(doc, properties['order_no'])['type']).toBe('string');
    expect(resolve(doc, properties['paid_date'])).toMatchObject({ type: 'string', format: 'date' });
    expect(resolve(doc, properties['created_at'])).toMatchObject({
      type: 'string',
      format: 'date-time',
    });
    expect(resolve(doc, properties['items'])).toMatchObject({ type: 'array', minItems: 1 });
    const child = itemSchema(doc, method);
    closed(child, itemKeys);
    expect(resolve(doc, at(child, 'properties', 'sub_order_id'))).toMatchObject({
      type: 'string',
      minLength: 1,
    });
    for (const forbidden of [
      'evidence',
      'evidence_level',
      'order_no_type',
      'handler_admin_id',
      'link_log',
      'user_id',
      'app_id',
    ]) {
      expect(properties).not.toHaveProperty(forbidden);
      expect(at(child, 'properties')).not.toHaveProperty(forbidden);
    }
  },
);

it.each(endpoints)(
  '[CT-04f#7] %s %s 接受全部 claim 状态、待审 null 及全部驳回码，拒绝非法投影',
  (method) => {
    const doc = contract();
    const validate = compile(doc, claimSchema(doc, method));
    const validateItem = compile(doc, itemSchema(doc, method));
    for (const status of enumValues.claim_status) check(validate, { ...claim, status }, true);
    check(validateItem, item, true);
    for (const decision of enumValues.claim_item_decision)
      check(validateItem, { ...item, decision }, true);
    for (const reject_reason of enumValues.claim_reject_reason) {
      check(validateItem, { ...item, decision: 'rejected', reject_reason }, true);
    }
    for (const key of claimKeys) {
      const missing: Record<string, unknown> = { ...claim };
      delete missing[key];
      check(validate, missing, false);
    }
    for (const key of itemKeys) {
      const missing: Record<string, unknown> = { ...item };
      delete missing[key];
      check(validateItem, missing, false);
    }
    for (const patch of [
      { status: 'pending' },
      { status: null },
      { items: [] },
      { items: null },
      { items: [{ ...item, sub_order_id: '' }] },
      { paid_date: '2026/10/06' },
      { created_at: '2026-10-06' },
      { claim_id: null },
      { platform: 'unknown' },
      { order_no: null },
    ])
      check(validate, { ...claim, ...patch }, false);
    for (const patch of [
      { decision: 'pending' },
      { reject_reason: 'RISK_BLOCKED' },
      { decision: 1 },
      { reject_reason: 1 },
    ]) {
      check(validateItem, { ...item, ...patch }, false);
    }
    for (const key of [
      'evidence',
      'evidence_level',
      'order_no_type',
      'handler_admin_id',
      'link_log',
      'user_id',
      'app_id',
      'failed_items',
    ]) {
      check(validate, { ...claim, [key]: 'private' }, false);
      check(validateItem, { ...item, [key]: 'private' }, false);
    }
  },
);

it('[CT-04f#8] GET 列表仅含必填 items / next_cursor，支持空页、末页和继续翻页', () => {
  const doc = contract();
  const schema = dataSchema(doc, 'get');
  closed(schema, ['items', 'next_cursor']);
  expect(at(schema, 'properties', 'items')['type']).toBe('array');
  const validate = compile(doc, schema);
  for (const next_cursor of [null, 'opaque-next-page']) {
    check(validate, { items: [], next_cursor }, true);
    check(validate, { items: [claim], next_cursor }, true);
  }
  for (const value of [
    { items: [] },
    { next_cursor: null },
    { items: null, next_cursor: null },
    { items: [], next_cursor: 1 },
    { items: [], next_cursor: null, total: 1 },
    { items: [{ ...claim, evidence_level: 'strong' }], next_cursor: null },
  ])
    check(validate, value, false);
});

it.each(endpoints)(
  '[CT-04f#9] %s %s 成功信封和响应示例通过 strict schema，POST 示例为证据计算后的状态',
  (method) => {
    const doc = contract();
    const schema = responseSchema(doc, method);
    closed(schema, ['code', 'msg', 'data', 'trace_id']);
    expect(at(schema, 'properties', 'code')['$ref']).toBe('#/components/schemas/SuccessCode');
    const validate = compile(doc, schema);
    const data = method === 'post' ? claim : { items: [claim], next_cursor: null };
    const valid = envelope(data);
    check(validate, valid, true);
    for (const key of ['code', 'msg', 'data', 'trace_id']) {
      const missing = { ...valid };
      delete missing[key];
      check(validate, missing, false);
    }
    for (const patch of [
      { code: 30201 },
      { data: null },
      { msg: null },
      { trace_id: null },
      { evidence: 'private' },
    ]) {
      check(validate, { ...valid, ...patch }, false);
    }
    for (const example of examples(doc, media(doc, method))) {
      check(validate, example, true);
      if (method === 'post') {
        expect(['manual_review', 'auto_matched']).toContain(at(example, 'data')['status']);
      } else {
        const items = list(at(example, 'data')['items']).map(object);
        for (const entry of items) expect(entry).not.toHaveProperty('evidence_level');
      }
    }
  },
);
