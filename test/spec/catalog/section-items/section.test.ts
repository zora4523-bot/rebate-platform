// B1-05o: which section is read (contract listPageSectionItems: the viewer's app and device pick the
// version as in getPage) and when the use case answers 30701: no such section, or a data source
// that is not union_material. A malformed union_material source is not covered: the page save
// schema refuses it.
import { expect, it } from 'vitest';
import { CatalogError } from '../../../../apps/api/src/modules/catalog/domain/rules.ts';
import { APP, candidate, rejection } from '../hot-rank/kit.ts';
import { PAGE_KEY, SECTION_ID, TB, sectionFixture, title, titlesOf } from './kit.ts';

it('[AC-B1-05o#1] 用当前 app 与设备读已发布页面的这张卡片，union_material 数据源照常出卡', async () => {
  const f = sectionFixture({ channels: [TB] });
  f.answer(TB, 1, [candidate('only')]);

  const data = await f.run();

  expect(f.sections).toEqual([
    { appId: APP, pageKey: PAGE_KEY, sectionId: SECTION_ID, deviceId: 'synthetic-device' },
  ]);
  expect(titlesOf(data)).toEqual([title('only')]);
});

it('[AC-B1-05o#2] 没带设备的请求按 deviceId=null 读（基础模式取全量发布版本）', async () => {
  const f = sectionFixture({ channels: [TB], deviceId: null });
  f.answer(TB, 1, [candidate('only')]);

  await f.run();

  expect(f.sections).toEqual([
    { appId: APP, pageKey: PAGE_KEY, sectionId: SECTION_ID, deviceId: null },
  ]);
});

const NOT_MATERIAL = [
  { label: '卡片不存在', section: null },
  { label: 'product_pool 数据源', section: { dataSource: { kind: 'product_pool' } } },
  { label: 'api 数据源', section: { dataSource: { kind: 'api' } } },
  { label: '没有 kind', section: { dataSource: { channels: [TB] } } },
  { label: '卡片没有数据源', section: { dataSource: undefined } },
  { label: '数据源为 null', section: { dataSource: null } },
];

it.each(NOT_MATERIAL)(
  '[AC-B1-05o#3] $label → CatalogError(30701)，不向上游取数、不出卡',
  async ({ section }) => {
    const f = sectionFixture({ channels: [TB] });
    f.answer(TB, 1, [candidate('only')]);
    f.setSection(section);

    const error = await rejection(() => f.run());

    expect(error).toMatchObject({ code: 30701 });
    expect(error).toBeInstanceOf(CatalogError);
    expect(f.calls).toEqual([]);
    expect(f.assemble).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
  },
);
