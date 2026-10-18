import { expect, it } from 'vitest';
import { at, check, compile, contract, list, resolve } from './kit.ts';

it('[CT-04f#12] 订单列表置顶字段可选且仅为 boolean，旧响应 required 保持不变', () => {
  const doc = contract();
  const op = at(doc, 'paths', '/v1/orders', 'get');
  const response = resolve(doc, at(op, 'responses', '200'));
  const envelope = resolve(doc, at(response, 'content', 'application/json', 'schema'));
  const data = resolve(doc, at(envelope, 'properties', 'data'));
  const pinned = resolve(doc, at(data, 'properties', 'claim_entry_pinned'));
  expect(pinned['type']).toBe('boolean');
  expect(data['additionalProperties']).toBe(false);
  expect(list(data['required']).toSorted()).toEqual([
    'earliest_visible_date',
    'items',
    'next_cursor',
  ]);
  expect(list(data['required'])).not.toContain('claim_entry_pinned');
  const validate = compile(doc, data);
  const oldPage = { items: [], next_cursor: null, earliest_visible_date: null };
  check(validate, oldPage, true);
  for (const value of [true, false])
    check(validate, { ...oldPage, claim_entry_pinned: value }, true);
  for (const value of [null, 0, 1, 'true', 'false', {}, []]) {
    check(validate, { ...oldPage, claim_entry_pinned: value }, false);
  }
  for (const name of ['OrderSummary', 'OrderDetail']) {
    expect(at(doc, 'components', 'schemas', name, 'properties')).not.toHaveProperty(
      'claim_entry_pinned',
    );
  }
});
