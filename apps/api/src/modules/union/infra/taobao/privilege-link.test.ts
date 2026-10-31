import { expect, it, vi } from 'vitest';
import { UnionError } from '../../domain/types.ts';
import { unwrapDataokeResponse } from '../dataoke/response.ts';
import {
  DATAOKE_PRIVILEGE_LINK_CODES,
  DATAOKE_PRIVILEGE_LINK_PATH,
  mapPrivilegeLink,
} from './privilege-link.ts';
import type { TaobaoWarning } from './response.ts';

const SHORT = 'https://s.click.taobao.com/UnitShort';
const AT = new Date('2026-11-01T00:00:00.000Z');
const PATH = DATAOKE_PRIVILEGE_LINK_PATH;

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof UnionError) return error.code;
    throw error;
  }
  throw new Error('expected a UnionError');
}

/** A success body with the two amounts written as literal JSON text (numbers stay unquoted). */
function wire(originalPrice: string, actualPrice: string) {
  return {
    status: 200,
    headers: {},
    body: `{"code":0,"msg":"ok","data":{"shortUrl":"${SHORT}","originalPrice":${originalPrice},"actualPrice":${actualPrice}}}`,
  };
}

/** Plain unwrap (JSON.parse), then map. */
function viaClient(originalPrice: string, actualPrice: string) {
  const warn = vi.fn<(event: TaobaoWarning) => void>();
  const data = unwrapDataokeResponse(PATH, wire(originalPrice, actualPrice));
  return { result: mapPrivilegeLink(data, AT, warn), warn };
}

const INVALID_WARNING = { method: PATH, code: 'invalid_amount' };

it.each([
  ['99.9', 9990n],
  ['39', 3900n],
  ['0.05', 5n],
  ['12.3', 1230n],
  // JSON 文本 12.30 解析后 String() 为 "12.3"（D10-525：数值型金额先转最短十进制字符串）。
  ['12.30', 1230n],
])('[AC-B1-04d-UNIT#1] JSON number %s → %s 分，不告警', (literal, fen) => {
  const { result, warn } = viaClient(literal, literal);
  expect(result).toMatchObject({ requote: { price_fen: fen, final_price_fen: fen } });
  expect(warn).not.toHaveBeenCalled();
});

it.each(['99.999', '1e21', '-1', '-0.01', '1e-7'])(
  '[AC-B1-04d-UNIT#2] JSON number %s 的最短十进制字符串不合法 → 省略 requote 并告警一次',
  (bad) => {
    for (const [original, actual] of [
      [bad, '8.8'],
      ['9.9', bad],
    ] as const) {
      const { result, warn } = viaClient(original, actual);
      expect(result).toEqual({ kind: 'url', url: SHORT, short_url: SHORT });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toEqual(INVALID_WARNING);
    }
  },
);

it.each(['19.999', '7.005', '-1', '1e2', ' 12'])(
  '[AC-B1-04d-UNIT#3] 字符串金额 %s 不合法 → 视为缺失：省略 requote 并告警一次',
  (bad) => {
    for (const field of ['originalPrice', 'actualPrice']) {
      const warn = vi.fn<(event: TaobaoWarning) => void>();
      const data = { shortUrl: SHORT, originalPrice: '9.90', actualPrice: '8.80', [field]: bad };
      expect(mapPrivilegeLink(data, AT, warn)).toEqual({
        kind: 'url',
        url: SHORT,
        short_url: SHORT,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toEqual(INVALID_WARNING);
    }
  },
);

it('[AC-B1-04d-UNIT#4] 两个金额都非法只告警一次；NaN / Infinity / 其他类型也算非法', () => {
  const both = vi.fn<(event: TaobaoWarning) => void>();
  mapPrivilegeLink({ shortUrl: SHORT, originalPrice: 'x', actualPrice: '-1' }, AT, both);
  expect(both).toHaveBeenCalledTimes(1);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, true, { value: '9.90' }]) {
    const warn = vi.fn<(event: TaobaoWarning) => void>();
    const data = { shortUrl: SHORT, originalPrice: bad, actualPrice: '8.80' };
    expect(mapPrivilegeLink(data, AT, warn)).not.toHaveProperty('requote');
    expect(warn).toHaveBeenCalledTimes(1);
  }
});

it('[AC-B1-04d-UNIT#5] 前导空白或带空白的 https 链接不算绝对 https', () => {
  for (const bad of [` ${SHORT}`, `${SHORT} `, 'https://', 'HTTPS:// x']) {
    expect(code(() => mapPrivilegeLink({ shortUrl: bad }, AT, undefined))).toBe(
      'upstream_unavailable',
    );
  }
});

it('[AC-B1-04d-UNIT#6] 外层细分表只覆盖表内 code：10031 → item_unavailable，表外 10071 仍是 upstream_rejected', () => {
  const reply = (outer: number) => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ code: outer, msg: 'unit', data: {} }),
  });
  const outerCodes = DATAOKE_PRIVILEGE_LINK_CODES;
  expect(code(() => unwrapDataokeResponse(PATH, reply(10031), undefined, { outerCodes }))).toBe(
    'item_unavailable',
  );
  expect(code(() => unwrapDataokeResponse(PATH, reply(10031)))).toBe('upstream_rejected');
  expect(code(() => unwrapDataokeResponse(PATH, reply(10071), undefined, { outerCodes }))).toBe(
    'upstream_rejected',
  );
});
