import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { debugOnlyRoutes } from '../../../../infra/release-scan/residue/index.ts';

// 03 §3.6：Release 的路由表生成物不含 debug_only 路由；扫描所用的 debug_only 名单只取 contracts/routes.json
// （只读，contracts/README「debug_only 的路由只在 debug / staging 包里能打开」）。读不通即失败（fail-closed）。

const ROUTES_URL = new URL('../../../../contracts/routes.json', import.meta.url);

it('[03 §3.6 debug_only 路由#1] 仓库 contracts/routes.json 当前的 debug_only 路由只有 HomePreview', () => {
  expect(debugOnlyRoutes(readFileSync(ROUTES_URL, 'utf8'))).toEqual(['HomePreview']);
});

it('[03 §3.6 debug_only 路由#2] 只收 debug_only 为 true 的路由，按码点升序', () => {
  const json = JSON.stringify({
    version: '1',
    routes: {
      Zeta: { kind: 'native', debug_only: true },
      Alpha: { kind: 'native', debug_only: true },
      Home: { kind: 'native', debug_only: false },
      Search: { kind: 'native' },
    },
  });
  expect(debugOnlyRoutes(json)).toEqual(['Alpha', 'Zeta']);
  expect(debugOnlyRoutes(JSON.stringify({ version: '1', routes: { Home: {} } }))).toEqual([]);
});

it.each<[string, string]>([
  ['不是 JSON', '{"routes":'],
  ['缺 routes', '{"version":"1"}'],
  ['routes 不是对象', '{"version":"1","routes":[]}'],
  ['debug_only 为字符串', '{"version":"1","routes":{"A":{"debug_only":"true"}}}'],
  ['debug_only 为数字', '{"version":"1","routes":{"A":{"debug_only":1}}}'],
  ['路由条目不是对象', '{"version":"1","routes":{"A":true}}'],
])('[03 §3.6 debug_only 路由#3] %s：抛出校验错误（不是 NotImplemented）', (_label, json) => {
  let error: unknown;
  try {
    debugOnlyRoutes(json);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(Error);
  expect(String((error as Error).message)).not.toMatch(/NotImplemented/);
});
