import { splitProductKey, validateProductKey, type ProductKeyPlatform } from '@couli/domain';
import { expect, it } from 'vitest';
import { failureOf, platforms } from './kit.ts';

it('[AC-B1-05b-13] [BR-PROD-02] 格式有效时通过，拆分结果保持原始大小写与前导零', () => {
  const cases = [
    { key: 'tb:7Kq9LmN3pQ', platform: 'taobao', keyPrefix: 'tb', stableId: '7Kq9LmN3pQ' },
    { key: 'jd:000123', platform: 'jd', keyPrefix: 'jd', stableId: '000123' },
    { key: 'pdd:a', platform: 'pdd', keyPrefix: 'pdd', stableId: 'a' },
  ];
  expect(
    cases.map(({ key, platform }) => [
      validateProductKey(key, platforms, platform),
      splitProductKey(key, platforms, platform),
    ]),
  ).toEqual(
    cases.map(({ platform, keyPrefix, stableId }) => [
      undefined,
      { platform, keyPrefix, stableId },
    ]),
  );
});

it('[AC-B1-05b-14] [BR-PROD-02] 所有允许的 ASCII 字符都能保留，冒号只按第一个拆分', () => {
  const allowed = Array.from({ length: 94 }, (_, index) => String.fromCharCode(33 + index)).filter(
    (char) => !['#', '/', '?'].includes(char),
  );
  const ids = [...allowed, allowed.join(''), ':AbC:deF:', '%2F%3F%23'];
  expect(
    ids.map((stableId) => [
      validateProductKey(`tb:${stableId}`, platforms),
      splitProductKey(`tb:${stableId}`, platforms),
    ]),
  ).toEqual(ids.map((stableId) => [undefined, { platform: 'taobao', keyPrefix: 'tb', stableId }]));
});

it('[AC-B1-05b-15] [BR-PROD-02] 124 字符 stable_id 有效，三字母前缀总长恰为 128', () => {
  const keys = [`tb:${'A'.repeat(124)}`, `jd:${'B'.repeat(124)}`, `pdd:${'C'.repeat(124)}`];
  expect(
    keys.map((key) => [validateProductKey(key, platforms), splitProductKey(key, platforms)]),
  ).toEqual([
    [undefined, { platform: 'taobao', keyPrefix: 'tb', stableId: 'A'.repeat(124) }],
    [undefined, { platform: 'jd', keyPrefix: 'jd', stableId: 'B'.repeat(124) }],
    [undefined, { platform: 'pdd', keyPrefix: 'pdd', stableId: 'C'.repeat(124) }],
  ]);
});

it('[AC-B1-05b-16] [BR-PROD-02] 格式非法、125 字符 stable_id、控制字符和非 ASCII 均报 20001', () => {
  const controls = Array.from({ length: 33 }, (_, index) =>
    String.fromCharCode(index === 32 ? 127 : index),
  );
  const keys: unknown[] = [
    '',
    'tb:',
    'tb',
    'tb:a/b',
    'tb:a?b',
    'tb:a#b',
    'tb:a b',
    'TB:abc',
    't:abc',
    'taobao:abc',
    't1:abc',
    ':abc',
    ' tb:abc',
    'tb:abc ',
    'tb:é',
    'tb:中文',
    'tb:😀',
    'tb:\u00a0',
    'tb:\u200b',
    'tb:abc\n',
    'tb:abc\r\n',
    'tb:abc\u2028',
    'tb:abc\u2029',
    'tb%3Aabc',
    `tb:${'x'.repeat(125)}`,
    `jd:${'x'.repeat(125)}`,
    `pdd:${'x'.repeat(125)}`,
    ...controls.map((char) => `tb:a${char}b`),
    null,
    undefined,
    123,
    true,
    {},
    ['tb:abc'],
  ];
  const errors = keys.flatMap((key) => [
    failureOf(() => validateProductKey(key, platforms)),
    failureOf(() => splitProductKey(key, platforms)),
  ]);
  expect(errors).toEqual(
    errors.map(() =>
      expect.objectContaining({
        code: 20001,
        data: { fields: ['product_key'] },
      }),
    ),
  );
});

it('[AC-B1-05b-17] [BR-PROD-02] 未登记前缀拒绝；登记后的新前缀无需改代码即可校验拆分', () => {
  const rows: readonly ProductKeyPlatform[] = Object.freeze([
    ...platforms,
    Object.freeze({
      platform: 'future',
      keyPrefix: 'xx',
      parseEnabled: true,
      searchEnabled: false,
    }),
  ]);
  expect([
    failureOf(() => validateProductKey('xx:AbC', platforms)),
    failureOf(() => splitProductKey('xx:AbC', platforms)),
    validateProductKey('xx:AbC', rows, 'future'),
    splitProductKey('xx:AbC', rows, 'future'),
  ]).toEqual([
    expect.objectContaining({ code: 20001, data: { fields: ['product_key'] } }),
    expect.objectContaining({ code: 20001, data: { fields: ['product_key'] } }),
    undefined,
    { platform: 'future', keyPrefix: 'xx', stableId: 'AbC' },
  ]);
});

it('[AC-B1-05b-18] [BR-PROD-02] 前缀映射取本次快照；原有 tb 前缀不在表内时不能硬编码放行', () => {
  const rows = Object.freeze([
    Object.freeze({
      platform: 'taobao',
      keyPrefix: 'abc',
      parseEnabled: false,
      searchEnabled: true,
    }),
  ]);
  expect([
    validateProductKey('abc:X', rows, 'taobao'),
    splitProductKey('abc:X', rows, 'taobao'),
    failureOf(() => validateProductKey('tb:X', rows)),
    failureOf(() => splitProductKey('tb:X', rows)),
    failureOf(() => validateProductKey('tb:X', [])),
  ]).toEqual([
    undefined,
    { platform: 'taobao', keyPrefix: 'abc', stableId: 'X' },
    expect.objectContaining({ code: 20001, data: { fields: ['product_key'] } }),
    expect.objectContaining({ code: 20001, data: { fields: ['product_key'] } }),
    expect.objectContaining({ code: 20001, data: { fields: ['product_key'] } }),
  ]);
});

it('[AC-B1-05b-19] [BR-PROD-02] 请求 platform 必须与前缀对应平台相同', () => {
  const requests = ['jd', 'pdd', 'tb', 'TAOBAO', 'unknown', ''];
  const errors = requests.flatMap((requested) => [
    failureOf(() => validateProductKey('tb:AbC', platforms, requested)),
    failureOf(() => splitProductKey('tb:AbC', platforms, requested)),
  ]);
  expect(errors).toEqual(
    errors.map(() =>
      expect.objectContaining({
        code: 20001,
        data: { fields: ['product_key'] },
      }),
    ),
  );
});

it('[AC-B1-05b-20] [BR-PROD-02] 搜索或解析有一个开启即可，两个都关闭才报 30131', () => {
  const modes = [
    { parseEnabled: true, searchEnabled: false },
    { parseEnabled: false, searchEnabled: true },
    { parseEnabled: true, searchEnabled: true },
  ];
  const results = modes.map((mode) => {
    const rows = [{ platform: 'taobao', keyPrefix: 'tb', ...mode }];
    return [validateProductKey('tb:AbC', rows), splitProductKey('tb:AbC', rows)];
  });
  const disabled = [
    { platform: 'taobao', keyPrefix: 'tb', parseEnabled: false, searchEnabled: false },
  ];
  expect([
    results,
    failureOf(() => validateProductKey('tb:AbC', disabled)),
    failureOf(() => splitProductKey('tb:AbC', disabled)),
  ]).toEqual([
    modes.map(() => [undefined, { platform: 'taobao', keyPrefix: 'tb', stableId: 'AbC' }]),
    expect.objectContaining({ code: 30131 }),
    expect.objectContaining({ code: 30131 }),
  ]);
});

it('[AC-B1-05b-21] [BR-PROD-02] 格式、前缀、platform 错误优先于能力关闭', () => {
  const disabled = platforms.map((row) => ({ ...row, parseEnabled: false, searchEnabled: false }));
  const cases = [
    { key: 'tb:a/b', platform: 'taobao' },
    { key: 'xx:a', platform: 'taobao' },
    { key: 'tb:a', platform: 'jd' },
  ];
  const errors = cases.flatMap(({ key, platform }) => [
    failureOf(() => validateProductKey(key, disabled, platform)),
    failureOf(() => splitProductKey(key, disabled, platform)),
  ]);
  expect(errors).toEqual(
    errors.map(() =>
      expect.objectContaining({
        code: 20001,
        data: { fields: ['product_key'] },
      }),
    ),
  );
});

it('[AC-B1-05b-22] [BR-PROD-02] 无商品前缀的行不形成字符串 null 或平台名的商品键', () => {
  const keys = ['null:x', 'eleme:x', ':x', 'el:x'];
  const errors = keys.flatMap((key) => [
    failureOf(() => validateProductKey(key, platforms, 'eleme')),
    failureOf(() => splitProductKey(key, platforms, 'eleme')),
  ]);
  expect(errors).toEqual(
    errors.map(() =>
      expect.objectContaining({
        code: 20001,
        data: { fields: ['product_key'] },
      }),
    ),
  );
});
