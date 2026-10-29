// B1-05m: a keyword shortcut's target is checked against contracts/routes.json as a whole (编排裁定
// D10-419 (a) 2「route 必须是路由表里的路由名、params 按该路由的参数定义（必填、类型、无多余键）」;
// contracts RouteTarget). The table is read here as data, route by route: every route whose params
// require nothing opens with empty params and without params; a route with required params is
// refused with empty params; an undeclared param key is refused wherever the route forbids extra
// keys; a name the table does not have is refused. debug_only routes are left out (D10-419 says
// nothing about them).
import { expect, it } from 'vitest';
import { searchKeywordRoutesFit } from '../../../../apps/api/src/modules/catalog/hot-words/index.ts';
import { BLOCK_ON, routesTable, shortcut } from './kit.ts';

const fits = (target: unknown) => searchKeywordRoutesFit([shortcut('直达', target)], BLOCK_ON);
const table = Object.entries(routesTable()).filter(([, entry]) => entry.debug_only !== true);

it('[AC-B1-05m#18] routes.json 里不需要参数的路由，params 为 {} 或不带 params 都可存', () => {
  const open = table.filter(([, entry]) => entry.params.required.length === 0);
  expect(open.length).toBeGreaterThan(0);
  for (const [route] of open) {
    expect(fits({ route, params: {} }), route).toBe(true);
    expect(fits({ route }), `${route} without params`).toBe(true);
  }
});

it('[AC-B1-05m#19] routes.json 里有必填参数的路由，params 为 {} 拒绝', () => {
  const required = table.filter(([, entry]) => entry.params.required.length > 0);
  expect(required.map(([route]) => route)).toEqual(
    expect.arrayContaining(['ProductDetail', 'OrderDetail', 'ExternalPage']),
  );
  for (const [route] of required) {
    expect(fits({ route, params: {} }), route).toBe(false);
    expect(fits({ route }), `${route} without params`).toBe(false);
  }
});

it('[AC-B1-05m#20] 不允许多余键的路由，带一个 routes.json 未声明的参数拒绝', () => {
  const open = table.filter(([, entry]) => entry.params.required.length === 0);
  const closed = open.filter(([, entry]) => entry.params.additionalProperties === false);
  expect(closed.length).toBeGreaterThan(0);
  for (const [route, entry] of closed) {
    expect(Object.hasOwn(entry.params.properties, 'b105m_extra')).toBe(false);
    expect(fits({ route, params: { b105m_extra: 1 } }), route).toBe(false);
  }
});

it('[AC-B1-05m#21] 不在 routes.json 的名字一律拒绝（加后缀、改小写、改大写）', () => {
  const names = new Set(Object.keys(routesTable()));
  for (const [route] of table) {
    for (const name of [`${route}X`, route.toLowerCase(), route.toUpperCase()]) {
      if (names.has(name)) continue;
      expect(fits({ route: name, params: {} }), name).toBe(false);
    }
  }
});
