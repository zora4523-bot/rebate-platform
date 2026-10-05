import {
  deriveProductKey,
  type ProductKeyDerivation,
  type UnionProductPayload,
} from '@couli/domain';
import { expect, it } from 'vitest';
import { failureOf, jdItem, jdSku, pdd, taobao } from './kit.ts';

// AC-B1-05b-* are local test identifiers; the task has no external acceptance IDs.
it('[AC-B1-05b-01] [BR-PROD-03] 淘宝取最后一段，无连字符时保留整串与大小写', () => {
  const examples = [
    ['AbC12xyz-7Kq9LmN3pQ', 'tb:7Kq9LmN3pQ'],
    ['A-B-C9', 'tb:C9'],
    ['7Kq9LmN3pQ', 'tb:7Kq9LmN3pQ'],
    ['-AbC', 'tb:AbC'],
    ['A--AbC', 'tb:AbC'],
    ['000AbC', 'tb:000AbC'],
    ['A-:', 'tb::'],
  ] as const;
  expect(examples.map(([item_id]) => deriveProductKey(taobao, { item_id }))).toEqual(
    examples.map(([, key]) => key),
  );
});

it('[AC-B1-05b-02] [BR-PROD-03] 京东默认 item；取第二段而非最后一段并添加 i_', () => {
  const payload = { itemId: 'A_BcD_C', skuId: '999' };
  expect([
    deriveProductKey({ platform: 'jd', keyPrefix: 'jd' }, payload),
    deriveProductKey(jdItem, payload),
    deriveProductKey(jdItem, { itemId: '_000AbC' }),
    deriveProductKey(jdSku, payload),
    deriveProductKey(jdSku, { skuId: '100012043978' }),
  ]).toEqual(['jd:i_BcD', 'jd:i_BcD', 'jd:i_000AbC', 'jd:999', 'jd:100012043978']);
});

it('[AC-B1-05b-03] [BR-PROD-03] 拼多多只用 goods_id，保留大整数文本和前导零', () => {
  expect([
    deriveProductKey(pdd, { goods_id: '123456789', goods_sign: 'first' }),
    deriveProductKey(pdd, { goods_id: '123456789', goods_sign: 'second' }),
    deriveProductKey(pdd, { goods_id: '0009007199254740993' }),
  ]).toEqual(['pdd:123456789', 'pdd:123456789', 'pdd:0009007199254740993']);
});

it('[AC-B1-05b-04] [BR-PROD-02] 派生前缀使用调用方快照，不写死三平台前缀', () => {
  expect([
    deriveProductKey({ ...taobao, keyPrefix: 'xy' }, { item_id: 'A_B-C' }),
    deriveProductKey({ ...jdItem, keyPrefix: 'abc' }, { itemId: 'A_B' }),
    deriveProductKey({ ...pdd, keyPrefix: 'zz' }, { goods_id: 'C' }),
  ]).toEqual(['xy:C', 'abc:i_B', 'zz:C']);
});

it('[AC-B1-05b-05] [BR-PROD-03] 缺失、null、空段或只有另一模式字段时统一派生失败', () => {
  const cases: readonly [ProductKeyDerivation, UnionProductPayload][] = [
    [taobao, {}],
    [taobao, { item_id: null }],
    [taobao, { item_id: '' }],
    [taobao, { item_id: 'AbC-' }],
    [taobao, { item_id: '-' }],
    [jdSku, {}],
    [jdSku, { skuId: null }],
    [jdSku, { skuId: '' }],
    [jdSku, { itemId: 'A_B' }],
    [jdSku, { skuId: '', itemId: 'A_B' }],
    [jdItem, {}],
    [jdItem, { itemId: null }],
    [jdItem, { itemId: '' }],
    [jdItem, { itemId: 'NoDelimiter' }],
    [jdItem, { itemId: 'A_' }],
    [jdItem, { itemId: 'A__C' }],
    [jdItem, { skuId: '123' }],
    [jdItem, { itemId: 'A_', skuId: '123' }],
    [{ platform: 'jd', keyPrefix: 'jd' }, { skuId: '123' }],
    [pdd, {}],
    [pdd, { goods_id: null }],
    [pdd, { goods_id: '' }],
    [pdd, { goods_sign: 'not-a-goods-id' }],
    [pdd, { goods_id: '', goods_sign: 'not-a-goods-id' }],
  ];
  expect(
    cases.map(([platform, payload]) => failureOf(() => deriveProductKey(platform, payload))),
  ).toEqual(cases.map(() => expect.objectContaining({ code: 'PRODUCT_KEY_UNDERIVABLE' })));
});

it('[AC-B1-05b-06] [BR-PROD-03] 非 MVP 平台即使有前缀与所有字段也不能派生', () => {
  const unsupported = [
    'meituan',
    'vip',
    'douyin',
    'kuaishou',
    'suning',
    'eleme',
    'future',
    'tmall',
  ];
  const payload = { item_id: 'A_B-C', itemId: 'A_B', skuId: '123', goods_id: '123' };
  expect(
    unsupported.map((platform) =>
      failureOf(() =>
        deriveProductKey({ platform, keyPrefix: platform === 'eleme' ? null : 'xy' }, payload),
      ),
    ),
  ).toEqual(unsupported.map(() => expect.objectContaining({ code: 'PRODUCT_KEY_UNDERIVABLE' })));
});

it('[AC-B1-05b-07] [BR-PROD-02] 派生所需前缀为空或不满足小写 2–3 字母时失败', () => {
  const prefixes = [null, '', 'T B', 'TB', 't', 'taobao', 't1', 'tb:', 'tb\n'];
  expect(
    prefixes.map((keyPrefix) =>
      failureOf(() => deriveProductKey({ ...taobao, keyPrefix }, { item_id: 'Valid' })),
    ),
  ).toEqual(prefixes.map(() => expect.objectContaining({ code: 'PRODUCT_KEY_UNDERIVABLE' })));
});

it('[AC-B1-05b-08] [BR-PROD-02/03] 派生结果长度边界包含京东 i_，不限制被丢弃的原串前段', () => {
  expect([
    deriveProductKey(taobao, { item_id: `${'x'.repeat(200)}-${'A'.repeat(124)}` }),
    deriveProductKey(jdItem, { itemId: `${'x'.repeat(200)}_${'B'.repeat(122)}` }),
    deriveProductKey(jdSku, { skuId: 'C'.repeat(124) }),
    deriveProductKey(pdd, { goods_id: 'D'.repeat(124) }),
    deriveProductKey(taobao, { item_id: 'discard/this?-Valid' }),
    deriveProductKey(jdItem, { itemId: 'discard/#?_Valid' }),
  ]).toEqual([
    `tb:${'A'.repeat(124)}`,
    `jd:i_${'B'.repeat(122)}`,
    `jd:${'C'.repeat(124)}`,
    `pdd:${'D'.repeat(124)}`,
    'tb:Valid',
    'jd:i_Valid',
  ]);
});

it('[AC-B1-05b-09] [BR-PROD-02/03] 非法字符与超长结果失败，不裁剪、转义、trim 或回退', () => {
  const invalid = [
    'a/b',
    'a?b',
    'a#b',
    'a b',
    ' abc',
    'abc ',
    'a\u0000b',
    'a\tb',
    'a\nb',
    'abc\n',
    'a\rb',
    'a\u007fb',
    '中文',
    'é',
    '😀',
    'x'.repeat(125),
  ];
  const errors = invalid.flatMap((id) => [
    failureOf(() => deriveProductKey(taobao, { item_id: `A-${id}` })),
    failureOf(() => deriveProductKey(jdSku, { skuId: id, itemId: 'A_Valid' })),
    failureOf(() => deriveProductKey(jdItem, { itemId: `A_${id}`, skuId: 'Valid' })),
    failureOf(() => deriveProductKey(pdd, { goods_id: id, goods_sign: 'Valid' })),
  ]);
  errors.push(failureOf(() => deriveProductKey(jdItem, { itemId: `A_${'x'.repeat(123)}` })));
  expect(errors).toEqual(
    errors.map(() => expect.objectContaining({ code: 'PRODUCT_KEY_UNDERIVABLE' })),
  );
});

it('[AC-B1-05b-10] [BR-PROD-02/03] 原样保留允许的特殊字符，不解 URL 编码或折叠大小写', () => {
  const id = 'AbC:%2F%3F%23+&=@!~';
  expect([
    deriveProductKey(taobao, { item_id: `prefix-${id}` }),
    deriveProductKey(jdItem, { itemId: `prefix_${id}` }),
    deriveProductKey(jdSku, { skuId: id }),
    deriveProductKey(pdd, { goods_id: id }),
  ]).toEqual([`tb:${id}`, `jd:i_${id}`, `jd:${id}`, `pdd:${id}`]);
});

it('[AC-B1-05b-11] [BR-PROD-03] 合成的跨入口载荷派生一致；用户归因字段和数量不进入身份', () => {
  const entries = ['search', 'detail', 'parse', 'pool', 'order'];
  const results = entries.map((entry, index) => {
    const metadata = {
      entry,
      user_id: `user${index}`,
      relation_id: `rel${index}`,
      promotion_slot: `slot${index}`,
      quantity: index + 1,
    };
    return [
      deriveProductKey(taobao, { ...metadata, item_id: `changing${index}-AbC` }),
      deriveProductKey(jdItem, { ...metadata, itemId: `changing${index}_AbC` }),
      deriveProductKey(jdSku, { ...metadata, skuId: '123' }),
      deriveProductKey(pdd, { ...metadata, goods_id: '123', goods_sign: `sign${index}` }),
    ];
  });
  expect(results).toEqual(entries.map(() => ['tb:AbC', 'jd:i_AbC', 'jd:123', 'pdd:123']));
});

it('[AC-B1-05b-12] [BR-PROD-03] 纯函数可复用冻结入参，模式由本次注入配置决定', () => {
  const payload = Object.freeze({ itemId: 'A_B', skuId: '123' });
  expect([
    deriveProductKey(jdItem, payload),
    deriveProductKey(jdSku, payload),
    deriveProductKey(jdItem, payload),
    payload,
  ]).toEqual(['jd:i_B', 'jd:123', 'jd:i_B', { itemId: 'A_B', skuId: '123' }]);
});

it('[AC-B1-05b-26] [BR-PROD-02/03] 每条派生路径接受完整合法字符域，分隔符只参与本平台原串拆段', () => {
  const allowed = Array.from({ length: 94 }, (_, index) => String.fromCharCode(index + 33)).filter(
    (char) => !['#', '/', '?'].includes(char),
  );
  const cases = allowed.flatMap((id) => [
    { config: jdSku, payload: { skuId: id }, expected: `jd:${id}` },
    { config: pdd, payload: { goods_id: id }, expected: `pdd:${id}` },
    ...(id === '-'
      ? []
      : [{ config: taobao, payload: { item_id: `A-${id}` }, expected: `tb:${id}` }]),
    ...(id === '_'
      ? []
      : [{ config: jdItem, payload: { itemId: `A_${id}` }, expected: `jd:i_${id}` }]),
  ]);
  expect(cases.map(({ config, payload }) => deriveProductKey(config, payload))).toEqual(
    cases.map(({ expected }) => expected),
  );
});

it('[AC-B1-05b-27] [BR-PROD-03] 不参与所选规则的字段即使非法也不改变合法派生结果', () => {
  expect([
    deriveProductKey(taobao, { item_id: 'A_Keep', itemId: '/', skuId: '?', goods_id: '#' }),
    deriveProductKey(jdItem, { itemId: 'A_Keep', skuId: 'invalid/' }),
    deriveProductKey(jdSku, { skuId: 'Keep', itemId: 'invalid/' }),
    deriveProductKey(pdd, { goods_id: 'Keep', goods_sign: 'invalid/#? ' }),
  ]).toEqual(['tb:A_Keep', 'jd:i_Keep', 'jd:Keep', 'pdd:Keep']);
});
