// Page input bounds of the port (B1-22p brief): pageNo an integer ≥ 1, pageSize an integer
// 1..MAX_PAGE_SIZE, otherwise the union module's existing input error (UnionError invalid_dto)
// before the union is called; categoryId null is the whole list.
import { expect, it } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { MAX_PAGE_SIZE, TB_CHANNEL, fixture, pageInput, rejection } from './kit.ts';

it.each<[number, number, string | null]>([
  [1, 1, null],
  [1, MAX_PAGE_SIZE, null],
  [3, 20, 'synthetic-cat-a'],
  [12, 7, 'synthetic-cat-b'],
])(
  '[AC-B1-22p#7] pageNo=%s、pageSize=%s、categoryId=%s 合法：原样转给适配器，不多不少',
  async (pageNo, pageSize, categoryId) => {
    const f = fixture();
    const port = f.port();
    await port.page(pageInput({ pageNo, pageSize, categoryId }));
    const calls = f.fake('taobao').rankingCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.req).toEqual({ channelId: TB_CHANNEL, categoryId, pageNo, pageSize });
    expect(f.warnings).toEqual([]);
  },
);

it.each<[string, number]>([
  ['0', 0],
  ['负数', -1],
  ['小数', 1.5],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['字符串', '2' as unknown as number],
])('[AC-B1-22p#8] pageNo 为%s → UnionError invalid_dto，不调联盟', async (_case, pageNo) => {
  const f = fixture();
  const port = f.port();
  const error = await rejection(() => port.page(pageInput({ pageNo })));
  expect(error).toBeInstanceOf(UnionError);
  expect(error).toMatchObject({ code: 'invalid_dto' });
  expect(f.channelCalls()).toBe(0);
});

it.each<[string, number]>([
  ['0', 0],
  ['负数', -5],
  ['超过上限', MAX_PAGE_SIZE + 1],
  ['远超上限', 1000],
  ['小数', 2.5],
  ['NaN', Number.NaN],
  ['字符串', '20' as unknown as number],
])('[AC-B1-22p#9] pageSize 为%s → UnionError invalid_dto，不调联盟', async (_case, pageSize) => {
  const f = fixture();
  const port = f.port();
  const error = await rejection(() => port.page(pageInput({ pageSize })));
  expect(error).toBeInstanceOf(UnionError);
  expect(error).toMatchObject({ code: 'invalid_dto' });
  expect(f.channelCalls()).toBe(0);
});
