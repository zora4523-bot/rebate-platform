import { expect, it } from 'vitest';
import { validatePageSections } from '../../../../apps/api/src/modules/content/domain/pages/validate/index.ts';
import { ACTION_PATH, context, withAction } from './kit.ts';

const FUNDS_ROUTES = ['Withdraw', 'PayoutAccount', 'LaborAgreement', 'RealName'];

// BR-WDR-01：任一参数键均拒绝，并非只拒绝 amount。
it.each(
  FUNDS_ROUTES.flatMap((route) =>
    [{ amount: 1 }, { arbitrary: null }, { token: '' }].map((params) => ({ route, params })),
  ),
)('[AC-F1-09c#11] $route 携带参数 $params 定位 params', ({ route, params }) => {
  expect(validatePageSections(withAction({ route, params }), context())).toStrictEqual([
    `${ACTION_PATH}.params`,
  ]);
});

it.each(FUNDS_ROUTES)('[AC-F1-09c#12] %s 的空参数对象与缺省参数均放行', (route) => {
  expect(validatePageSections(withAction({ route, params: {} }), context())).toStrictEqual([]);
  expect(validatePageSections(withAction({ route }), context())).toStrictEqual([]);
});

it.each(['Help', 'Notice'])('[AC-F1-09c#13] 普通已登记路由 %s 可携带参数', (route) => {
  expect(
    validatePageSections(withAction({ route, params: { article_id: 'article_demo' } }), context()),
  ).toStrictEqual([]);
});

it.each(['UnregisteredRoute', 'withdraw', '', 42, null, false, {}, []].map((route) => ({ route })))(
  '[AC-F1-09c#14] 未登记或非字符串 route=$route 定位 route',
  ({ route }) => {
    expect(validatePageSections(withAction({ route }), context())).toStrictEqual([
      `${ACTION_PATH}.route`,
    ]);
  },
);

it.each([null, [], ['value'], '', 'params', 1, false].map((params) => ({ params })))(
  '[AC-F1-09c#15] params=$params 不是对象时拒绝（数组也不是契约对象）',
  ({ params }) => {
    expect(validatePageSections(withAction({ route: 'Help', params }), context())).toStrictEqual([
      `${ACTION_PATH}.params`,
    ]);
  },
);

it('[AC-F1-09c#16] 同一目标的 route 和 params 都无效时收集两个字段', () => {
  expect(
    validatePageSections(withAction({ route: 'UnregisteredRoute', params: null }), context()),
  ).toStrictEqual([`${ACTION_PATH}.route`, `${ACTION_PATH}.params`]);
});

it('[AC-F1-09c#17] 路由登记以本次注入的 routeNames 为准', () => {
  const sections = withAction({ route: 'Help', params: {} });
  expect(validatePageSections(sections, context({ routeNames: new Set() }))).toStrictEqual([
    `${ACTION_PATH}.route`,
  ]);
  expect(validatePageSections(sections, context({ routeNames: new Set(['Help']) }))).toStrictEqual(
    [],
  );
});

it('[AC-F1-09c#18] 外链拦截开关关闭不放松资金路由和登记校验', () => {
  const sections = [
    { props: { action: { route: 'Withdraw', params: { amount: 1 } } } },
    { props: { action: { route: 'UnregisteredRoute' } } },
  ];
  expect(validatePageSections(sections, context({ unionHostBlock: false }))).toStrictEqual([
    'sections.0.props.action.params',
    'sections.1.props.action.route',
  ]);
});
