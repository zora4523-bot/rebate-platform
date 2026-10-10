// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createAntdTheme } from '../../../../apps/admin/src/theme.ts';

it('[AC-F1-06r-MENU-TOKENS#1] Menu 项高不超过 36，选中底色随 CSS 令牌变化', () => {
  const tokenFile = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../packages/ui-tokens/src/tokens.gen.css',
  );
  const variables = Array.from(
    readFileSync(tokenFile, 'utf8').matchAll(/(--color-[\w-]+)\s*:/g),
    (match) => match[1]!,
  );
  expect(variables.length).toBeGreaterThan(0);
  const root = document.documentElement;
  const originalStyle = root.getAttribute('style');
  try {
    // Unique synthetic values make a literal production colour or a derived default fail.
    // The task does not prescribe a token name: accept a resolved design colour token.
    for (const [index, variable] of variables.entries())
      root.style.setProperty(variable, `#${(0x123400 + index).toString(16)}`);
    const menu = createAntdTheme().components?.Menu;
    expect(menu).toBeDefined();
    expect(typeof menu?.itemHeight).toBe('number');
    expect(menu?.itemHeight).toBeLessThanOrEqual(36);
    expect(typeof menu?.itemSelectedBg).toBe('string');
    expect(menu?.itemSelectedBg?.trim()).not.toBe('');
    const resolved = getComputedStyle(root);
    const selectedVariable = variables.find(
      (variable) => resolved.getPropertyValue(variable).trim() === menu?.itemSelectedBg,
    );
    expect(selectedVariable, 'itemSelectedBg must equal a resolved CSS colour token').toBeDefined();
    root.style.setProperty(selectedVariable!, '#abcdef');
    expect(createAntdTheme().components?.Menu?.itemSelectedBg).toBe(
      getComputedStyle(root).getPropertyValue(selectedVariable!).trim(),
    );
  } finally {
    if (originalStyle === null) root.removeAttribute('style');
    else root.setAttribute('style', originalStyle);
  }
});
