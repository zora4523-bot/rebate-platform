import { expect, it } from 'vitest';
import { validatePageSections } from '../../../../apps/api/src/modules/content/domain/pages/validate/index.ts';
import { context, URL_PATH, withUrl } from './kit.ts';

it.each([undefined, null, {}, { sections: [] }, 'sections', 1, false])(
  '[AC-F1-09c#27] sections 不是数组（%j）只返回根字段',
  (sections) => {
    expect(validatePageSections(sections, context())).toStrictEqual(['sections']);
  },
);

it('[AC-F1-09c#28] 空页面没有本任务的违规字段', () => {
  expect(validatePageSections([], context())).toStrictEqual([]);
});

it('[AC-F1-09c#29] 递归覆盖 items.action、公告 target、props 中按钮及任意嵌套目标', () => {
  const sections = [
    {
      type: 'banner',
      data_source: {
        kind: 'static',
        items: [
          { action: { route: 'Help' } },
          { action: { route: 'ExternalPage', params: { url: 'https://union-a.test/' } } },
        ],
      },
    },
    {
      type: 'notice_bar',
      data_source: {
        kind: 'static',
        items: [{ target: { route: 'ExternalPage', params: { url: 'https://brand.test/{uid}' } } }],
      },
    },
    {
      props: {
        buttons: [{ action: { route: 'Withdraw', params: { amount: 1 } } }],
        arbitrary: [null, { wrapper: { route: 'UnknownRoute' } }],
      },
    },
    {
      props: {
        action: { route: 'Help', params: { nested: { route: 'RealName', params: { id: 'x' } } } },
      },
    },
  ];
  const expected = [
    'sections.0.data_source.items.1.action.params.url',
    'sections.1.data_source.items.0.target.params.url',
    'sections.2.props.buttons.0.action.params',
    'sections.2.props.arbitrary.1.wrapper.route',
    'sections.3.props.action.params.nested.params',
  ];
  expect(validatePageSections(sections, context())).toStrictEqual(expected);
  expect(validatePageSections(sections, context())).toStrictEqual(expected);
});

it('[AC-F1-09c#30] 同一 url 命中联盟主机和占位只返回一次字段，仍继续后面的目标', () => {
  const sections = [
    {
      props: {
        first: { route: 'ExternalPage', params: { url: 'https://union-a.test/?id={uid}' } },
        second: { route: 'ExternalPage', params: { url: 'https://union-a.test/?id={uid}' } },
      },
    },
    { type: 'product_grid', data_source: { kind: 'api' } },
  ];
  expect(validatePageSections(sections, context())).toStrictEqual([
    'sections.0.props.first.params.url',
    'sections.0.props.second.params.url',
    'sections.1.data_source',
  ]);
});

it('[AC-F1-09c#31] 遍历顺序使用数组次序（下标 10 不排到 2 前）', () => {
  const sections = Array.from({ length: 12 }, () => ({ props: { route: 'UnknownRoute' } }));
  expect(validatePageSections(sections, context())).toStrictEqual([
    'sections.0.props.route',
    'sections.1.props.route',
    'sections.2.props.route',
    'sections.3.props.route',
    'sections.4.props.route',
    'sections.5.props.route',
    'sections.6.props.route',
    'sections.7.props.route',
    'sections.8.props.route',
    'sections.9.props.route',
    'sections.10.props.route',
    'sections.11.props.route',
  ]);
});

it('[AC-F1-09c#32] 没有 route 键的普通数据不被当成跳转目标', () => {
  const sections = [
    {
      type: 'banner',
      props: {
        title: 'demo',
        params: { url: 'https://union-a.test/{uid}' },
        other: [null, 0, false],
      },
      data_source: { kind: 'static', items: [{ title: 'demo' }] },
    },
  ];
  expect(validatePageSections(sections, context())).toStrictEqual([]);
});

it('[AC-F1-09c#33] 校验不改写页面或注入上下文，结果取决于每次传入的表与开关', () => {
  const sections = withUrl('https://UNION-A.TEST.:8443/x');
  const ctx = context();
  const originalSections = structuredClone(sections);
  const originalContext = structuredClone(ctx);
  expect(validatePageSections(sections, ctx)).toStrictEqual([URL_PATH]);
  expect(validatePageSections(sections, { ...ctx, unionHostBlock: false })).toStrictEqual([]);
  expect(
    validatePageSections(sections, { ...ctx, linkPatterns: { version: 't', rules: [] } }),
  ).toStrictEqual([]);
  expect(validatePageSections(sections, ctx)).toStrictEqual([URL_PATH]);
  expect(sections).toStrictEqual(originalSections);
  expect(ctx).toStrictEqual(originalContext);
});

it('[AC-F1-09c#34] 只有自有 route 键才识别为目标，继承的 route 不触发校验', () => {
  const inherited = {};
  Object.setPrototypeOf(inherited, { route: 'UnknownRoute' });
  const own = { route: 'UnknownRoute' };
  Object.setPrototypeOf(own, { route: 'Help' });
  expect(validatePageSections([{ props: { inherited, own } }], context())).toStrictEqual([
    'sections.0.props.own.route',
  ]);
});
