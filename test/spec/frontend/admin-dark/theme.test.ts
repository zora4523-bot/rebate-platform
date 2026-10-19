// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createAntdTheme } from '../../../../apps/admin/src/theme.ts';
import { color, emulateSystemDark, mapping } from './fixtures.ts';

const moduleUrl = import.meta.url;
// Vite's jsdom CSS handling can turn a .css?raw import into an empty module.
const tokenCss = readFileSync(
  new URL('../../../../packages/ui-tokens/src/tokens.gen.css', moduleUrl),
  'utf8',
);
// antd belongs to the admin package; resolve its installed copy without adding a test dependency.
const { theme } = createRequire(new URL('../../../../apps/admin/package.json', moduleUrl))(
  'antd',
) as { theme: { darkAlgorithm: unknown } };
const sheets: HTMLStyleElement[] = [];
let oldTheme: string | null;
let oldStyle: string | null;

beforeEach(() => {
  oldTheme = document.documentElement.getAttribute('data-theme');
  oldStyle = document.documentElement.getAttribute('style');
  document.documentElement.removeAttribute('data-theme');
  expect(tokenCss.trim()).not.toBe('');
  const sheet = document.createElement('style');
  sheet.textContent = tokenCss;
  document.head.append(sheet);
  sheets.push(sheet);
});
afterEach(() => {
  for (const sheet of sheets.splice(0)) sheet.remove();
  for (const [name, value] of [
    ['data-theme', oldTheme],
    ['style', oldStyle],
  ] as const) {
    if (value === null) document.documentElement.removeAttribute(name);
    else document.documentElement.setAttribute(name, value);
  }
});

function check(mode: 'light' | 'dark', root: Element = document.documentElement): void {
  const result = createAntdTheme(root);
  const algorithms = Array.isArray(result.algorithm) ? result.algorithm : [result.algorithm];
  if (mode === 'dark') expect(algorithms).toContain(theme.darkAlgorithm);
  else expect(algorithms).not.toContain(theme.darkAlgorithm);
  const key = mode === 'dark' ? 'dark' : 'value';
  const style = getComputedStyle(root);
  for (const [name, variable, leaf] of mapping) {
    expect(style.getPropertyValue(variable).trim(), variable).toBe(leaf[key]);
    expect(result.token?.[name], name).toBe(leaf[key]);
  }
  expect(result.components?.Menu?.itemSelectedBg).toBe(color.brand.subtle[key]);
  expect(result.components?.Menu?.itemSelectedColor).toBe(color.brand.primary[key]);
  expect(result.components?.Layout?.headerBg).toBe(color.background.surface[key]);
  expect(result.components?.Layout?.bodyBg).toBe(color.background['admin-canvas'][key]);
}

it('[AC-F1-06zl-THEME#1] 显式深色使用 darkAlgorithm 与完整深色映射，切回浅色恢复原映射', () => {
  document.documentElement.setAttribute('data-theme', 'light');
  check('light');
  document.documentElement.setAttribute('data-theme', 'dark');
  check('dark');
  document.documentElement.setAttribute('data-theme', 'light');
  check('light');
});

it('[AC-F1-06zl-THEME#2] 无 data-theme 时跟随系统 CSS，强制浅色优先，移除强制后回深色', () => {
  check('light');
  const systemSheet = emulateSystemDark(tokenCss);
  sheets.push(systemSheet);
  expect(systemSheet.textContent).toContain(':root:not([data-theme="light"])');
  document.documentElement.setAttribute('data-theme', 'light');
  check('light');
  document.documentElement.removeAttribute('data-theme');
  check('dark');
  document.documentElement.setAttribute('data-theme', 'light');
  check('light');
});

it('[AC-F1-06zl-THEME#3] 以传入 root 的生效 CSS 为准，深色颜色仍从变量读取而非硬编码表', () => {
  document.documentElement.setAttribute('data-theme', 'light');
  const root = document.createElement('section');
  document.body.append(root);
  try {
    root.style.colorScheme = 'dark';
    for (const [, variable, leaf] of mapping) root.style.setProperty(variable, leaf.dark);
    root.style.setProperty('--color-brand-subtle', color.brand.subtle.dark);
    check('dark', root);
    // Use other contract colours as sentinels; no extra production palette is invented.
    for (const [name, variable] of mapping) {
      root.style.setProperty(variable, color.brand.subtle.dark);
      expect(createAntdTheme(root).token?.[name], variable).toBe(color.brand.subtle.dark);
    }
  } finally {
    root.remove();
  }
});
