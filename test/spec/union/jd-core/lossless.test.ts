import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { unwrapJdResponse } from '../../../../apps/api/src/modules/union/infra/jd/response.ts';
import { holdsRawText, keys, method, rawText, setup, wrapped } from './kit.ts';

// The inner result is decoded without passing through a JS number: every JSON number stays its
// exact source text. Conversion to fen is not part of this task.

it.each([
  ['2^53 - 1', '9007199254740991'],
  ['2^53', '9007199254740992'],
  ['2^53 + 1', '9007199254740993'],
  ['16 digits past 2^53', '9999999999999999'],
  ['19 digits', '1234567890123456789'],
  ['19 digits at the int64 limit', '9223372036854775807'],
  ['a small count', '7'],
])('[AC-B1-04za#45] the integer %s stays its source text', async (_label, text) => {
  const body = `{"code":200,"orderId":${text},"rows":[{"parentId":${text}}]}`;
  const direct = unwrapJdResponse(method, keys, wrapped(body));
  expect(rawText(direct.orderId)).toBe(text);

  const { adapter, transport } = setup();
  transport.mockResolvedValue(wrapped(body));
  const inner = await adapter.request(method, {}, keys);
  expect(rawText(inner.orderId)).toBe(text);
  expect(rawText((inner.rows as readonly { parentId: unknown }[])[0]?.parentId)).toBe(text);
});

it('[AC-B1-04za#46] 2^53 + 1 survives where a JS number could not hold it', () => {
  const text = '9007199254740993';
  const inner = unwrapJdResponse(method, keys, wrapped(`{"code":200,"orderId":${text}}`));
  expect(rawText(inner.orderId)).toBe(text);
  expect(BigInt(rawText(inner.orderId))).toBe(2n ** 53n + 1n);
  expect(BigInt(Number(text))).not.toBe(BigInt(text));
});

it.each([
  '12.30',
  '0.1',
  '0.2',
  '0.30',
  '0.30000000000000004',
  '100.00',
  '-1.50',
  '0.10000000000000000001',
  '1.50e3',
])('[AC-B1-04za#47] the decimal %s stays its source text', async (text) => {
  const body = `{"code":200,"actualFee":${text}}`;
  expect(rawText(unwrapJdResponse(method, keys, wrapped(body)).actualFee)).toBe(text);

  const { adapter, transport } = setup();
  transport.mockResolvedValue(wrapped(body));
  expect(rawText((await adapter.request(method, {}, keys)).actualFee)).toBe(text);
});

it('[AC-B1-04za#48] numbers keep their text at any depth, next to the other JSON values', () => {
  const inner = unwrapJdResponse(
    method,
    keys,
    wrapped(
      '{"code":200,"hasMore":true,"none":null,"data":[{"orderId":9007199254740993,"skuList":[{"actualFee":12.30,"ratios":[0.10,50.00]}]}]}',
    ),
  );
  expect(inner).toMatchObject({ hasMore: true, none: null });
  const [row] = inner.data as readonly {
    orderId: unknown;
    skuList: readonly { actualFee: unknown; ratios: readonly unknown[] }[];
  }[];
  expect(rawText(row?.orderId)).toBe('9007199254740993');
  const sku = row?.skuList[0];
  expect(rawText(sku?.actualFee)).toBe('12.30');
  expect(rawText(sku?.ratios[0])).toBe('0.10');
  expect(rawText(sku?.ratios[1])).toBe('50.00');
});

it('[AC-B1-04za#49] strings stay strings, even when they hold number-like or JSON-like text', () => {
  const values = {
    id: '1234567890123456789',
    price: '12.30',
    nested: '{"orderId":9007199254740993,"actualFee":12.30}',
    quoted: 'a"b:1.50,"c":2',
    escaped: 'line\nbreak \\ 汉字',
    empty: '',
  };
  const inner = unwrapJdResponse(method, keys, wrapped(JSON.stringify({ code: 200, ...values })));
  expect(inner).toMatchObject(values);
});

it('[AC-B1-04za#50] any integer keeps its text exactly', () => {
  const text = fc.bigInt({ min: 0n, max: 10n ** 30n }).map((value) => value.toString());
  expect(() =>
    fc.assert(
      fc.property(text, (value) => {
        const inner = unwrapJdResponse(
          method,
          keys,
          wrapped(`{"code":200,"value":${value},"list":[${value}]}`),
        );
        return (
          holdsRawText(inner.value, value) &&
          holdsRawText((inner.list as readonly unknown[])[0], value)
        );
      }),
      propParams(),
    ),
  ).not.toThrow();
});

it('[AC-B1-04za#51] any decimal keeps its text exactly, trailing zeros included', () => {
  const text = fc
    .tuple(
      fc.boolean(),
      fc.bigInt({ min: 0n, max: 10n ** 18n }),
      fc.stringMatching(/^[0-9]{1,20}$/),
    )
    .map(([negative, whole, fraction]) => `${negative ? '-' : ''}${whole}.${fraction}`);
  expect(() =>
    fc.assert(
      fc.property(text, (value) => {
        const inner = unwrapJdResponse(method, keys, wrapped(`{"code":200,"value":${value}}`));
        return holdsRawText(inner.value, value);
      }),
      propParams(),
    ),
  ).not.toThrow();
});
