// B1-28b: the opaque keyset cursor of GET /v1/me/favorites (orchestrator semantics B.3: encodes
// created_at + id of the last row; the next page is (created_at, id) < cursor). That the list
// really pages by it is proven in list.int.test.ts.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  decodeFavoritesCursor,
  encodeFavoritesCursor,
} from '../../../../apps/api/src/modules/catalog/index.ts';

it('[AC-B1-28b#9] 游标往返：编码后解码得到同一时刻（毫秒）与同一 id；游标是非空字符串', () => {
  const cursor = {
    createdAt: new Date('2031-05-20T08:00:00.123+08:00'),
    id: '019a0000-0000-7000-8000-00000000c001',
  };
  const encoded = encodeFavoritesCursor(cursor);
  expect(typeof encoded).toBe('string');
  expect(encoded.length).toBeGreaterThan(0);
  const decoded = decodeFavoritesCursor(encoded);
  expect(decoded).not.toBeNull();
  expect(decoded?.id).toBe('019a0000-0000-7000-8000-00000000c001');
  expect(decoded?.createdAt.getTime()).toBe(Date.parse('2031-05-20T00:00:00.123Z'));
}, 10_000);

it.each(['', 'not-a-cursor', '%%%', '{"createdAt":1}', 'null', 'AAAA', '0'])(
  '[AC-B1-28b#10] 不是本编码产生的串 %j → 解码为 null（不抛）',
  (value) => {
    expect(decodeFavoritesCursor(value)).toBeNull();
  },
  10_000,
);

const instantArb = fc
  .integer({ min: Date.parse('2000-01-01T00:00:00Z'), max: Date.parse('2099-12-31T23:59:59.999Z') })
  .map((ms) => new Date(ms));

it('[AC-B1-28b#11] 属性：任意时刻（毫秒精度）与任意 UUID 往返不变，不同 (时刻, id) 编出不同游标', () => {
  let checked = 0;
  fc.assert(
    fc.property(instantArb, fc.uuid(), instantArb, fc.uuid(), (t1, id1, t2, id2) => {
      const a = encodeFavoritesCursor({ createdAt: t1, id: id1 });
      const decoded = decodeFavoritesCursor(a);
      expect(decoded?.createdAt.getTime()).toBe(t1.getTime());
      expect(decoded?.id).toBe(id1);
      if (t1.getTime() !== t2.getTime() || id1 !== id2) {
        expect(encodeFavoritesCursor({ createdAt: t2, id: id2 })).not.toBe(a);
      }
      checked += 1;
    }),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 120_000);

it('[AC-B1-28b#12] 属性：任意字符串解码不抛，结果要么 null，要么是有效时刻加 UUID', () => {
  let checked = 0;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  fc.assert(
    fc.property(fc.string({ maxLength: 80 }), (value) => {
      const decoded = decodeFavoritesCursor(value);
      if (decoded !== null) {
        expect(Number.isFinite(decoded.createdAt.getTime())).toBe(true);
        expect(decoded.id).toMatch(uuidPattern);
      } else {
        expect(decoded).toBeNull();
      }
      checked += 1;
    }),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 120_000);
