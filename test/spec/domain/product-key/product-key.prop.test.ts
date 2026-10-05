// Kept under the task's spec glob so verify-container --red accounts for this file too.
import { deriveProductKey, splitProductKey, validateProductKey } from '@couli/domain';
import { createPropStats, propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { failureOf, jdItem, jdSku, pdd, platforms, taobao } from './kit.ts';

const allowedChars = Array.from({ length: 94 }, (_, index) =>
  String.fromCharCode(index + 33),
).filter((char) => !['#', '/', '?'].includes(char));
const stableId = fc
  .array(fc.constantFrom(...allowedChars), { minLength: 1, maxLength: 124 })
  .map((chars) => chars.join(''));
const segment = fc
  .array(fc.constantFrom(...allowedChars.filter((char) => !['-', '_'].includes(char))), {
    minLength: 1,
    maxLength: 122,
  })
  .map((chars) => chars.join(''));

it('[AC-B1-05b-23] [BR-PROD-02] 属性：合法字符域内校验通过且拆分后逐字节往返', () => {
  const params = propParams();
  const stats = createPropStats('product-key:validate-split');
  fc.assert(
    fc.property(stableId, fc.constantFrom(...platforms.slice(0, 3)), (id, row) => {
      stats.hit(row.platform);
      const key = `${row.keyPrefix}:${id}`;
      validateProductKey(key, platforms, row.platform);
      const parts = splitProductKey(key, platforms, row.platform);
      return (
        parts.platform === row.platform &&
        parts.keyPrefix === row.keyPrefix &&
        parts.stableId === id &&
        `${parts.keyPrefix}:${parts.stableId}` === key
      );
    }),
    params,
  );
  expect(Object.values(stats.flush().hits).reduce((sum, count) => sum + count, 0)).toBe(
    params.numRuns,
  );
});

it('[AC-B1-05b-24] [BR-PROD-03] 属性：四种派生路径确定，原串变动部分不改变 key 且不修改载荷', () => {
  const params = propParams();
  const stats = createPropStats('product-key:determinism');
  fc.assert(
    fc.property(segment, segment, segment, (id, first, second) => {
      stats.hit(id.length === 122 ? 'max-item-segment' : 'other-length');
      const cases = [
        {
          config: taobao,
          a: { item_id: `${first}-${id}` },
          b: { item_id: `${second}-${id}` },
          key: `tb:${id}`,
        },
        {
          config: jdItem,
          a: { itemId: `${first}_${id}` },
          b: { itemId: `${second}_${id}` },
          key: `jd:i_${id}`,
        },
        { config: jdSku, a: { skuId: id }, b: { skuId: id }, key: `jd:${id}` },
        {
          config: pdd,
          a: { goods_id: id, goods_sign: first },
          b: { goods_id: id, goods_sign: second },
          key: `pdd:${id}`,
        },
      ];
      return cases.every(({ config, a, b, key }) => {
        const before = JSON.stringify([a, b]);
        Object.freeze(a);
        Object.freeze(b);
        const result = deriveProductKey(config, a);
        return (
          result === key &&
          deriveProductKey(config, a) === result &&
          deriveProductKey(config, b) === result &&
          JSON.stringify([a, b]) === before
        );
      });
    }),
    params,
  );
  expect(Object.values(stats.flush().hits).reduce((sum, count) => sum + count, 0)).toBe(
    params.numRuns,
  );
});

it('[AC-B1-05b-25] [BR-PROD-02/03] 属性：非法字符插入 stable_id 后校验和派生均失败', () => {
  const params = propParams();
  const stats = createPropStats('product-key:forbidden-char');
  const forbidden = fc.constantFrom(
    '#',
    '/',
    '?',
    ' ',
    '\t',
    '\n',
    '\r',
    '\u0000',
    '\u007f',
    'é',
    '中',
  );
  fc.assert(
    fc.property(segment, forbidden, fc.nat(), (id, char, offset) => {
      stats.hit(char.codePointAt(0)?.toString(16) ?? 'unknown');
      const position = offset % (id.length + 1);
      const invalid = id.slice(0, position) + char + id.slice(position);
      const validationErrors = [
        failureOf(() => validateProductKey(`tb:${invalid}`, platforms)),
        failureOf(() => splitProductKey(`tb:${invalid}`, platforms)),
      ];
      const derivationErrors = [
        failureOf(() => deriveProductKey(taobao, { item_id: `A-${invalid}` })),
        failureOf(() => deriveProductKey(jdItem, { itemId: `A_${invalid}` })),
        failureOf(() => deriveProductKey(jdSku, { skuId: invalid })),
        failureOf(() => deriveProductKey(pdd, { goods_id: invalid })),
      ];
      for (const error of validationErrors) {
        expect(error).toMatchObject({ code: 20001 });
      }
      for (const error of derivationErrors) {
        expect(error).toMatchObject({ code: 'PRODUCT_KEY_UNDERIVABLE' });
      }
      return true;
    }),
    params,
  );
  expect(Object.values(stats.flush().hits).reduce((sum, count) => sum + count, 0)).toBe(
    params.numRuns,
  );
});
