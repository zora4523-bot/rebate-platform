// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { BridgeContract } from '@couli/bridge-sdk';
import { createAppRoutes } from '../../../../apps/h5/src/entries/app/routes.ts';
import { requiredText } from './kit.ts';

afterEach(cleanup);

it('[AC-F1-01c-ROUTE#1] App 路径恰好等于生成契约全部 h5 路由，不含原生资金操作', () => {
  const actual = createAppRoutes();
  const expected = Object.values(BridgeContract.routes)
    .filter((route) => route.kind === 'h5')
    .map((route) => route.h5_path)
    .sort();
  expect(actual.map((route) => route.path).sort()).toEqual(expected);
  expect(new Set(actual.map((route) => route.path)).size).toBe(expected.length);
  expect(actual.every((route) => typeof route.lazy === 'function')).toBe(true);
  expect(actual.every((route) => !('element' in route) && !('Component' in route))).toBe(true);
});

it('[AC-F1-01c-ROUTE#2] 懒加载路由模块返回可渲染的非空占位页，不自绘标题栏', async () => {
  const routes = createAppRoutes();
  expect(routes.length).toBeGreaterThan(0);
  for (const route of routes) {
    const module = await route.lazy();
    expect(typeof module.Component).toBe('function');
    const page = render(createElement(module.Component));
    expect(page.container.textContent?.trim().length).toBeGreaterThan(0);
    expect(page.queryByRole('banner')).toBeNull();
    expect(page.queryByRole('navigation')).toBeNull();
    cleanup();
  }
});

it('[AC-F1-01c-ROUTE#3] 固定路由接线读取生成路由，并保留动态 import 分包', () => {
  createAppRoutes();
  const source = requiredText('apps/h5/src/entries/app/routes.ts');
  expect(source).toMatch(/@couli\/contracts-ts/);
  expect(source).toMatch(/\broutes\b/);
  expect(source).toMatch(/\bimport\s*\(/);
  for (const route of Object.values(BridgeContract.routes).filter((item) => item.kind === 'h5')) {
    expect(source).not.toMatch(new RegExp(`['"\x60]${route.h5_path}['"\x60]`));
  }
});
