import { expect, it } from 'vitest';
import { parseAttrCode } from '../../../../apps/api/src/modules/orders/domain/attribution.ts';

it.each(['n_abcd1234', 'n_abcd1234_a', 'n_abcd1234_0123456789abcdef'])(
  '[AC-B1-08h#01] 京东完整参数 %s 只解析八位 attr_code',
  (sub_union_id) => {
    expect(parseAttrCode('jd', { sub_union_id, relation_id: null, custom_parameters: null })).toBe(
      'abcd1234',
    );
  },
);
it.each([
  null,
  '',
  'abcd1234',
  'x_abcd1234',
  'n_Abcd1234',
  'n_abcd123',
  'n_abcd12345',
  'n_abcd1234_',
  'n_abcd1234_0123456789abcdefg',
  'n_abcd1234_A',
  ' n_abcd1234',
  'n_abcd1234\n',
  'n_abcd1234_a_b',
])('[AC-B1-08h#02] 京东拒绝非法或非完整匹配参数 %s', (sub_union_id) => {
  expect(
    parseAttrCode('jd', {
      sub_union_id,
      relation_id: null,
      custom_parameters: '{"app":"n","uid":"abcd1234"}',
    }),
  ).toBeNull();
});
it.each([
  '{"app":"n","uid":"abcd1234"}',
  '{"uid":"abcd1234","lk":"link1","app":"n"}',
  '{"app":"n","uid":"abcd1234","sc":"share","extra":true}',
])('[AC-B1-08h#03] 拼多多 JSON 对象中的字符串 uid 可归因：%s', (custom_parameters) => {
  expect(parseAttrCode('pdd', { custom_parameters, relation_id: null, sub_union_id: null })).toBe(
    'abcd1234',
  );
});
it.each([
  null,
  '',
  '{',
  'null',
  '[]',
  '1',
  '"abcd1234"',
  '{"app":"n","uid":12345678}',
  '{"app":"x","uid":"abcd1234"}',
  '{"uid":"abcd1234"}',
  '{"app":"n","uid":"ABCD1234"}',
  '{"app":"n","uid":"abcd123"}',
  '{"app":"n","uid":"abcd12345"}',
  '{"app":"n","uid":"abcd1234\\n"}',
  '{"app":"n","uid":null}',
  '{"app":"n","uid":["abcd1234"]}',
])('[AC-B1-08h#04] 拼多多非法参数 %s 不能借用京东参数归因', (custom_parameters) => {
  expect(
    parseAttrCode('pdd', { custom_parameters, relation_id: null, sub_union_id: 'n_abcd1234' }),
  ).toBeNull();
});
it('[AC-B1-08h#05] 淘宝不借用其他平台参数查用户', () => {
  expect(
    parseAttrCode('taobao', {
      relation_id: 'relation',
      sub_union_id: 'n_abcd1234',
      custom_parameters: '{"app":"n","uid":"abcd1234"}',
    }),
  ).toBeNull();
});
