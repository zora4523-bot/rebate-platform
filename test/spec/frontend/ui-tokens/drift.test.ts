import * as entry from '@couli/ui-tokens';
import {
  generateTailwindCss,
  generateThemeTs,
  generateTokensCss,
  themeFromTokens,
} from '@couli/ui-tokens';
import { format } from 'prettier';
import { expect, it } from 'vitest';
import { baseline, record, requiredText, snapshot } from './kit.ts';

it('[AC-CT-11a#10] tokens.gen.css 与契约重新生成的文本逐字一致', () => {
  expect(requiredText('packages/ui-tokens/src/tokens.gen.css')).toBe(generateTokensCss(snapshot()));
});

it('[AC-CT-11a#11] tailwind.gen.css 与契约重新生成的文本逐字一致', () => {
  expect(requiredText('packages/ui-tokens/src/tailwind.gen.css')).toBe(
    generateTailwindCss(snapshot()),
  );
});

it('[AC-CT-11a#12] theme.gen.ts 与契约重新生成的文本逐字一致且已定型', async () => {
  const actual = requiredText('packages/ui-tokens/src/theme.gen.ts');
  expect(actual).toBe(generateThemeTs(snapshot()));
  expect(actual).toBe(
    await format(actual, {
      parser: 'typescript',
      singleQuote: true,
      trailingComma: 'all',
      printWidth: 100,
    }),
  );
});

it('[AC-CT-11a#13] 包主入口暴露生成主题且两个 CSS 子路径可消费', () => {
  const expected = themeFromTokens(baseline());
  // The public symbol name is deliberately unconstrained; the theme object must be exported.
  expect(Object.values(entry)).toContainEqual(expected);
  const pkg = record(JSON.parse(requiredText('packages/ui-tokens/package.json')));
  const exports = record(pkg.exports);
  expect(exports['./tokens.css']).toBe('./src/tokens.gen.css');
  expect(exports['./tailwind.css']).toBe('./src/tailwind.gen.css');
  expect(requiredText('packages/ui-tokens/src/tokens.gen.css')).not.toBe('');
  expect(requiredText('packages/ui-tokens/src/tailwind.gen.css')).not.toBe('');
});

it('[AC-CT-11a#14] TS 序列化使用入参，重复生成稳定且不改写输入', () => {
  const input = baseline();
  const before = structuredClone(input);
  const original = generateThemeTs(input);
  expect(generateThemeTs(input)).toBe(original);
  expect(input).toEqual(before);
  record(record(input.tokens.color).brand).probe = { type: 'color', value: '#ABCDEF' };
  const changed = generateThemeTs(input);
  expect(changed).not.toBe(original);
  expect(changed).toContain('var(--color-brand-probe)');
  expect(changed).not.toContain('#ABCDEF');
});
