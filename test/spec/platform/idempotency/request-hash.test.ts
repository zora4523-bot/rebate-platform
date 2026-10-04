// Rule tests for the request-body hash (BR-WDR-07: 请求体哈希 = sha256(键名排序、无空白的规范化
// JSON); contract section 3 of apps/api/src/modules/platform/idempotency/index.ts). Every expected
// canonical text is written out by hand; the expected hash is SHA-256 of that text computed here.
// No database. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  canonicalJson,
  requestHashOf,
} from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import { outcomeSync, sha256Hex } from './kit.ts';

it('[BR-WDR-07] 规范化 JSON：键名逐层排序、无空白、数组保序、null 值的键不丢；哈希是规范化文本 UTF-8 字节的 SHA-256 小写十六进制', () => {
  const body = {
    zeta: [3, { y: 2, x: [true, null] }, 'a b'],
    alpha: { gamma: null, beta: -0, delta: 1.0 },
    mid: '',
  };
  const canonical =
    '{"alpha":{"beta":0,"delta":1,"gamma":null},"mid":"","zeta":[3,{"x":[true,null],"y":2},"a b"]}';
  expect(outcomeSync(() => canonicalJson(body))).toBe(canonical);
  expect(outcomeSync(() => requestHashOf(body))).toBe(sha256Hex(canonical));
  expect(sha256Hex(canonical)).toMatch(/^[0-9a-f]{64}$/);
});

it('[BR-WDR-07] 同一内容不同键顺序、不同嵌套键顺序得到同一哈希；任何一个字段的值、键名、数组顺序变了哈希就不同', () => {
  const base = { amount_fen: 10000, meta: { a: 1, b: [1, 2] } };
  const reordered = { meta: { b: [1, 2], a: 1 }, amount_fen: 10000 };
  const variants: unknown[] = [
    { amount_fen: 10001, meta: { a: 1, b: [1, 2] } },
    { amount_fen: 10000, meta: { a: 1, b: [2, 1] } },
    { amount_fen: 10000, meta: { a: 1, b: [1, 2], c: null } },
    { amount_fen: 10000, meta: { a: 1 } },
    { amount_fen: '10000', meta: { a: 1, b: [1, 2] } },
    { amount_fen: 10000, meta: { A: 1, b: [1, 2] } },
    { amount_fen: 10000 },
  ];
  const hashes = [base, reordered, ...variants].map((value) =>
    outcomeSync(() => requestHashOf(value)),
  );
  expect(hashes[0]).toBe(sha256Hex('{"amount_fen":10000,"meta":{"a":1,"b":[1,2]}}'));
  expect(hashes[1]).toBe(hashes[0]);
  expect(new Set(hashes.slice(1)).size).toBe(variants.length + 1);
});

it('[BR-WDR-07] 键名按 UTF-16 码元排序（RFC 8785 的顺序，不是码点顺序）；字符串按 JSON.stringify 转义', () => {
  const body = {
    '\uFF01': 1,
    '\u{1F600}': 2,
    é: 3,
    z: 4,
    Z: 5,
    '': 6,
    'a"b\\c\n': 7,
    'x\u2028': '\u0001\u00e9',
  };
  const canonical =
    '{"":6,"Z":5,"a\\"b\\\\c\\n":7,"x\u2028":"\\u0001é","z":4,"é":3,"\u{1F600}":2,"\uFF01":1}';
  expect(outcomeSync(() => canonicalJson(body))).toBe(canonical);
  expect(outcomeSync(() => requestHashOf(body))).toBe(sha256Hex(canonical));
});

it('[BR-WDR-07] 没有请求体（undefined）规范化为空串，与 null、{}、[]、"" 各不相同', () => {
  const cases: [unknown, string][] = [
    [undefined, ''],
    [null, 'null'],
    [{}, '{}'],
    [[], '[]'],
    ['', '""'],
    [0, '0'],
    [false, 'false'],
  ];
  for (const [value, text] of cases) {
    expect(outcomeSync(() => canonicalJson(value))).toBe(text);
    expect(outcomeSync(() => requestHashOf(value))).toBe(sha256Hex(text));
  }
  expect(new Set(cases.map(([value]) => outcomeSync(() => requestHashOf(value)))).size).toBe(
    cases.length,
  );
});

it('[BR-WDR-07] 原型为 null 的对象按普通对象规范化；只认自有可枚举字符串键', () => {
  const bare = Object.assign(Object.create(null) as Record<string, unknown>, { b: 1, a: 2 });
  expect(outcomeSync(() => canonicalJson(bare))).toBe('{"a":2,"b":1}');
  const withHidden = { b: 1, a: 2 };
  Object.defineProperty(withHidden, 'hidden', { value: 3, enumerable: false });
  Object.defineProperty(withHidden, Symbol('s'), { value: 4, enumerable: true });
  expect(outcomeSync(() => canonicalJson(withHidden))).toBe('{"a":2,"b":1}');
});

it('[BR-WDR-07] 不是 JSON 值的输入（任何深度）一律 IdempotencyError invalid_request，不静默丢弃', () => {
  class Box {
    v = 1;
  }
  const bad: unknown[] = [
    { a: undefined },
    [1, undefined],
    { a: { b: Number.NaN } },
    Number.POSITIVE_INFINITY,
    [Number.NEGATIVE_INFINITY],
    { a: 1n },
    { a: Symbol('x') },
    { a: () => 1 },
    { a: new Date(0) },
    { a: new Map() },
    { a: Buffer.from('x') },
    new Box(),
    [[{ deep: [undefined] }]],
  ];
  for (const value of bad) {
    expect(outcomeSync(() => canonicalJson(value))).toEqual({
      error: 'IdempotencyError invalid_request',
    });
    expect(outcomeSync(() => requestHashOf(value))).toEqual({
      error: 'IdempotencyError invalid_request',
    });
  }
});

it('[BR-WDR-07] 大请求体与深嵌套照样规范化（1000 个键、深 50 层）', () => {
  const wide: Record<string, number> = {};
  const keys: string[] = [];
  for (let i = 999; i >= 0; i -= 1) {
    const key = `k${String(i)}`;
    wide[key] = i;
    keys.push(key);
  }
  keys.sort();
  const wideText = `{${keys.map((key) => `"${key}":${key.slice(1)}`).join(',')}}`;
  expect(outcomeSync(() => canonicalJson(wide))).toBe(wideText);
  let deep: unknown = { z: 1, a: 0 };
  let deepText = '{"a":0,"z":1}';
  for (let i = 0; i < 50; i += 1) {
    deep = { y: [deep], b: i };
    deepText = `{"b":${String(i)},"y":[${deepText}]}`;
  }
  expect(outcomeSync(() => canonicalJson(deep))).toBe(deepText);
  expect(outcomeSync(() => requestHashOf(deep))).toBe(sha256Hex(deepText));
});
