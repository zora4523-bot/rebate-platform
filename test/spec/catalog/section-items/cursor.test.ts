// B1-05o: the cursor is base64url JSON of exactly page_key, section_id and pages (one next upstream
// page per channel of the data source, 0 = that channel is finished). Anything that cannot be
// decoded, has other keys, belongs elsewhere or no longer fits the channels is 20001 with
// data.fields=[cursor] (contract listPageSectionItems; 编排补充说明 D10-452).
import { expect, it } from 'vitest';
import { CatalogError } from '../../../../apps/api/src/modules/catalog/domain/rules.ts';
import { candidate, dataOf, rejection, series } from '../hot-rank/kit.ts';
import {
  JD,
  PAGE_KEY,
  PDD,
  SECTION_ID,
  TB,
  decodeCursor,
  encodeCursor,
  entryOf,
  materialSource,
  names,
  pagesCursor,
  sectionFixture,
  titlesOf,
} from './kit.ts';

const CLAIMS = { page_key: PAGE_KEY, section_id: SECTION_ID, pages: [2, 2] };

const TAMPERED = [
  { label: '空串', cursor: '' },
  { label: '非 base64url 字符', cursor: '!!!!' },
  { label: '解不出 JSON', cursor: 'synthetic-not-a-cursor' },
  { label: 'base64url 的普通文本', cursor: Buffer.from('not json').toString('base64url') },
  { label: 'JSON null', cursor: encodeCursor(null) },
  { label: 'JSON 数字', cursor: encodeCursor(2) },
  { label: 'JSON 字符串', cursor: encodeCursor('pages') },
  { label: 'JSON 数组', cursor: encodeCursor([2, 2]) },
  { label: '空对象', cursor: encodeCursor({}) },
  { label: '缺 page_key', cursor: encodeCursor({ section_id: SECTION_ID, pages: [2, 2] }) },
  { label: '缺 section_id', cursor: encodeCursor({ page_key: PAGE_KEY, pages: [2, 2] }) },
  { label: '缺 pages', cursor: encodeCursor({ page_key: PAGE_KEY, section_id: SECTION_ID }) },
  { label: '多一个键', cursor: encodeCursor({ ...CLAIMS, offset: 3 }) },
  { label: '别的页面', cursor: encodeCursor({ ...CLAIMS, page_key: 'synthetic_other' }) },
  { label: '别的卡片', cursor: encodeCursor({ ...CLAIMS, section_id: 'synthetic_other' }) },
  { label: 'pages 不是数组', cursor: encodeCursor({ ...CLAIMS, pages: { 0: 2, 1: 2 } }) },
  { label: 'pages 是数字', cursor: encodeCursor({ ...CLAIMS, pages: 2 }) },
  { label: 'pages 是 null', cursor: encodeCursor({ ...CLAIMS, pages: null }) },
  { label: 'pages 比频道少', cursor: encodeCursor({ ...CLAIMS, pages: [2] }) },
  { label: 'pages 比频道多', cursor: encodeCursor({ ...CLAIMS, pages: [2, 2, 2] }) },
  { label: 'pages 为空', cursor: encodeCursor({ ...CLAIMS, pages: [] }) },
  { label: '页码为负', cursor: encodeCursor({ ...CLAIMS, pages: [2, -1] }) },
  { label: '页码是小数', cursor: encodeCursor({ ...CLAIMS, pages: [1.5, 2] }) },
  { label: '页码是字符串', cursor: encodeCursor({ ...CLAIMS, pages: ['2', 2] }) },
  { label: '页码是 null', cursor: encodeCursor({ ...CLAIMS, pages: [2, null] }) },
  { label: '页码是布尔', cursor: encodeCursor({ ...CLAIMS, pages: [true, 2] }) },
];

it('[AC-B1-05o#4] 没有 cursor 时每个频道都从第 1 页取', async () => {
  const f = sectionFixture({ channels: [TB, JD, PDD] });
  f.answer(TB, 1, [candidate('tb')]);
  f.answer(JD, 1, [candidate('jd', { platform: 'jd' })]);
  f.answer(PDD, 1, [candidate('pdd', { platform: 'pdd' })]);

  const data = await f.run();

  expect(f.pageNos(TB)).toEqual([1]);
  expect(f.pageNos(JD)).toEqual([1]);
  expect(f.pageNos(PDD)).toEqual([1]);
  expect(data.items).toHaveLength(3);
});

it('[AC-B1-05o#5] next_cursor 恰有 page_key、section_id、pages 三个键，带回去取各频道记下的上游页', async () => {
  const f = sectionFixture();
  f.answer(TB, 1, series('tb', 10), true);
  f.answer(JD, 1, series('jd', 10, 1, 'jd'), true);
  f.answer(TB, 2, series('tb', 1, 11));
  f.answer(JD, 2, series('jd', 1, 11, 'jd'));

  const first = await f.run();

  expect(typeof first.next_cursor).toBe('string');
  expect(decodeCursor(first.next_cursor!)).toEqual({
    page_key: PAGE_KEY,
    section_id: SECTION_ID,
    pages: [2, 2],
  });

  const second = await f.run({ cursor: first.next_cursor! });

  expect(f.pageNos(TB)).toEqual([1, 2]);
  expect(f.pageNos(JD)).toEqual([1, 2]);
  expect(titlesOf(second)).toEqual([...names('tb', 1, 11), ...names('jd', 1, 11)]);
});

it.each(TAMPERED)(
  '[AC-B1-05o#6] 游标$label → CatalogError(20001)、data.fields=[cursor]，不向上游取数、不出卡',
  async ({ cursor }) => {
    const f = sectionFixture();
    f.answer(TB, 2, series('tb', 2));
    f.answer(JD, 2, series('jd', 2, 1, 'jd'));

    const error = await rejection(() => f.run({ cursor }));

    expect(error).toMatchObject({ code: 20001 });
    expect(error).toBeInstanceOf(CatalogError);
    expect(dataOf(error)).toMatchObject({ fields: ['cursor'] });
    expect(f.calls).toEqual([]);
    expect(f.assemble).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
  },
);

it('[AC-B1-05o#7] 运营改了频道数后，旧游标的 pages 与当前 channels 不等长 → 20001，不按旧页码取数', async () => {
  for (const edited of [[TB], [TB, JD, PDD]]) {
    const f = sectionFixture();
    f.answer(TB, 1, series('tb', 10), true);
    f.answer(JD, 1, series('jd', 10, 1, 'jd'), true);
    const first = await f.run();
    const calls = f.calls.length;

    f.setChannels(edited.map(entryOf));
    f.setSection({ dataSource: materialSource(edited) });
    const error = await rejection(() => f.run({ cursor: first.next_cursor! }));

    expect(error).toMatchObject({ code: 20001 });
    expect(dataOf(error)).toMatchObject({ fields: ['cursor'] });
    expect(f.calls.length).toBe(calls);
  }
});

it('[AC-B1-05o#8] 游标在一次请求里不被改写：同一游标再发一次，取同样的上游页、下发同样的卡', async () => {
  const f = sectionFixture();
  f.answer(TB, 3, series('tb', 2, 21));
  f.answer(JD, 3, series('jd', 2, 21, 'jd'));
  const cursor = pagesCursor([3, 3]);

  const once = await f.run({ cursor });
  const again = await f.run({ cursor });

  expect(f.pageNos(TB)).toEqual([3, 3]);
  expect(titlesOf(again)).toEqual(titlesOf(once));
  expect(titlesOf(once)).toHaveLength(4);
});
