import { expect, it } from 'vitest';
import { validatePageSections } from '../../../../apps/api/src/modules/content/domain/pages/validate/index.ts';
import { context } from './kit.ts';

// BR-TEXT-13 / BR-TEXT-17；kind=api 仅表示公告 CMS，不接受外部接口路径。
it('[AC-F1-09c#19] notice_bar 只含 kind 的 api 源放行', () => {
  expect(
    validatePageSections([{ type: 'notice_bar', data_source: { kind: 'api' } }], context()),
  ).toStrictEqual([]);
});

it.each([
  { path: '/v1/articles' },
  { path: '/v1/orders' },
  { url: 'https://brand.test/notices' },
  { path: '' },
  { extra: null },
])('[AC-F1-09c#20] notice_bar api 源不能携带额外字段 %j', (extra) => {
  expect(
    validatePageSections(
      [{ type: 'notice_bar', data_source: { kind: 'api', ...extra } }],
      context(),
    ),
  ).toStrictEqual(['sections.0.data_source']);
});

it.each(['product_grid', 'banner', 'feed_infinite', 'Notice_bar', undefined])(
  '[AC-F1-09c#21] 非 notice_bar section（type=%s）不允许 api 源',
  (type) => {
    expect(validatePageSections([{ type, data_source: { kind: 'api' } }], context())).toStrictEqual(
      ['sections.0.data_source'],
    );
  },
);

const SELECTABLE = { platform: 'taobao', channel_id: 'sales_a' };

it.each(['product_grid', 'product_scroll', 'feed_infinite'])(
  '[AC-F1-09c#22] %s 可选择白名单内多个可选频道',
  (type) => {
    expect(
      validatePageSections(
        [
          {
            type,
            data_source: {
              kind: 'union_material',
              channels: [SELECTABLE, { platform: 'jd', channel_id: 'popular_b' }],
            },
          },
        ],
        context(),
      ),
    ).toStrictEqual([]);
  },
);

it.each([
  { label: '缺 channels', source: { kind: 'union_material' } },
  { label: '空数组', source: { kind: 'union_material', channels: [] } },
  { label: 'null', source: { kind: 'union_material', channels: null } },
  { label: '对象', source: { kind: 'union_material', channels: SELECTABLE } },
  { label: '字符串', source: { kind: 'union_material', channels: 'sales_a' } },
])('[AC-F1-09c#23] union_material 拒绝 $label', ({ source }) => {
  expect(
    validatePageSections([{ type: 'product_grid', data_source: source }], context()),
  ).toStrictEqual(['sections.0.data_source']);
});

it.each([
  { label: '同编号但另一平台不可选', channel: { platform: 'jd', channel_id: 'sales_a' } },
  { label: '未登记编号', channel: { platform: 'taobao', channel_id: 'missing' } },
  { label: '另一平台独有编号', channel: { platform: 'taobao', channel_id: 'popular_b' } },
  { label: '未登记平台', channel: { platform: 'pdd', channel_id: 'sales_a' } },
  { label: '缺平台', channel: { channel_id: 'sales_a' } },
  { label: '缺编号', channel: { platform: 'taobao' } },
  { label: '错误编号类型', channel: { platform: 'taobao', channel_id: 1 } },
  { label: 'null 条目', channel: null },
  { label: '字符串条目', channel: 'sales_a' },
  { label: '数组条目', channel: ['taobao', 'sales_a'] },
])('[AC-F1-09c#24] 任一频道违规（$label）即拒绝整个源，不能只查第一项', ({ channel }) => {
  expect(
    validatePageSections(
      [
        {
          type: 'product_grid',
          data_source: { kind: 'union_material', channels: [SELECTABLE, channel] },
        },
      ],
      context(),
    ),
  ).toStrictEqual(['sections.0.data_source']);
});

it('[AC-F1-09c#25] 空频道表没有可选频道；多个非法频道只返回一次源路径', () => {
  expect(
    validatePageSections(
      [
        {
          type: 'product_grid',
          data_source: { kind: 'union_material', channels: [SELECTABLE, SELECTABLE] },
        },
      ],
      context({ materialChannels: { version: 'empty', channels: [] } }),
    ),
  ).toStrictEqual(['sections.0.data_source']);
});

it('[AC-F1-09c#26] unionHostBlock 关闭不放松两个数据源白名单', () => {
  expect(
    validatePageSections(
      [
        { type: 'product_grid', data_source: { kind: 'api' } },
        { type: 'product_grid', data_source: { kind: 'union_material', channels: [] } },
      ],
      context({ unionHostBlock: false }),
    ),
  ).toStrictEqual(['sections.0.data_source', 'sections.1.data_source']);
});
