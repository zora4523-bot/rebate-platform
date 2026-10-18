import { expect, it } from 'vitest';
import { parseLinkCode } from '../../../../apps/api/src/modules/orders/index.ts';

it.each([
  ['n_k3m9x2qa_a1b2c3', 'a1b2c3'],
  ['n_k3m9x2qa_0', '0'],
  ['n_k3m9x2qa_0123456789abcdef', '0123456789abcdef'],
  ['n_k3m9x2qa', null],
  ['n_k3m9x2qa_', null],
  ['n_k3m9x2qa_0123456789abcdefg', null],
  ['n_k3m9x2qa_ABC123', null],
  ['n_k3m9x2qa_a-b', null],
  ['n_short_a1b2c3', null],
  ['prefix_n_k3m9x2qa_a1b2c3', null],
  ['n_k3m9x2qa_a1b2c3\n', null],
  [null, null],
] as const)('[AC-B1-08j#17] 京东从完整 subUnionId 的第二组解析 %s', (sub_union_id, expected) => {
  expect(
    parseLinkCode('jd', { sub_union_id, relation_id: null, custom_parameters: '{"lk":"pdd123"}' }),
  ).toBe(expected);
});

it.each([
  ['{"lk":"a1b2c3"}', 'a1b2c3'],
  ['{"lk":"0"}', '0'],
  ['{"lk":"0123456789abcdef"}', '0123456789abcdef'],
  ['{"lk":"0123456789abcdefg"}', null],
  ['{"lk":123456}', null],
  ['{"lk":null}', null],
  ['{"lk":""}', null],
  ['{"lk":"ABC123"}', null],
  ['{"lk":"abc\\n"}', null],
  ['{"uid":"abcd1234"}', null],
  ['[{"lk":"a1b2c3"}]', null],
  ['"a1b2c3"', null],
  ['null', null],
  ['true', null],
  ['{broken', null],
  [null, null],
] as const)(
  '[AC-B1-08j#18] 拼多多只接受 JSON 对象的 1–16 位 base36 lk：%s',
  (custom_parameters, expected) => {
    expect(
      parseLinkCode('pdd', {
        custom_parameters,
        relation_id: null,
        sub_union_id: 'n_k3m9x2qa_jd1234',
      }),
    ).toBe(expected);
  },
);

it('[AC-B1-08j#19] 淘宝不从其他平台参数取得 lk', () => {
  expect(
    parseLinkCode('taobao', {
      relation_id: 'relation',
      sub_union_id: 'n_k3m9x2qa_a1b2c3',
      custom_parameters: '{"lk":"a1b2c3"}',
    }),
  ).toBeNull();
});
