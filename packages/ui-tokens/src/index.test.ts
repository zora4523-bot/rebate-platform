// Unit tests for the generator edge cases; the contract-level rules live in test/spec/frontend/ui-tokens.
import { expect, it } from 'vitest';
import type { DesignTokens } from './index.ts';
import {
  generateTailwindCss,
  generateThemeTs,
  generateTokensCss,
  themeFromTokens,
  tokenTheme,
} from './index.ts';

function doc(tokens: Record<string, unknown>, cssFontBase = 16): DesignTokens {
  return { schemaVersion: 'couli.tokens.v1', metadata: { version: '0.0.0', cssFontBase }, tokens };
}

const dimension = (value: number) => ({ type: 'dimension', value, unit: 'logical' });

it('exports the generated theme object with var() leaves', () => {
  expect(tokenTheme.color.background.canvas).toBe('var(--color-background-canvas)');
  expect(tokenTheme.space['4']).toBe('var(--space-4)');
});

it('spells numbers without exponents or trailing zeros', () => {
  const css = generateTokensCss(
    doc({
      space: { tiny: dimension(1e-7), big: dimension(1e21), half: dimension(0.5) },
      font: { size: { body: { type: 'fontSize', value: 17, unit: 'logical' } } },
    }),
  );
  expect(css).toContain('--space-tiny: 0.0000001px;');
  expect(css).toContain('--space-big: 1000000000000000000000px;');
  expect(css).toContain('--space-half: 0.5px;');
  expect(css).toContain('--font-size-body: 1.0625rem;');
});

it('quotes font families that are not bare identifiers', () => {
  const css = generateTokensCss(
    doc({ font: { family: { ui: { type: 'fontFamily', value: ['a-b', 'Say "hi"', 'x\\y'] } } } }),
  );
  expect(css).toContain('--font-family-ui: a-b, "Say \\"hi\\"", "x\\\\y";');
});

it('renders multi-layer and empty shadows', () => {
  const layer = { x: -1, y: 2, blur: 3, spread: 0, color: '#0A0B0C', opacity: 0.5 };
  const css = generateTokensCss(
    doc({
      shadow: {
        none: { type: 'shadow', value: [] },
        two: { type: 'shadow', value: [layer, { ...layer, opacity: 1 }] },
      },
    }),
  );
  expect(css).toContain('--shadow-none: none;');
  expect(css).toContain(
    '--shadow-two: -1px 2px 3px 0px rgba(10, 11, 12, 0.5), -1px 2px 3px 0px rgba(10, 11, 12, 1);',
  );
});

it('rejects invalid tokens instead of emitting them', () => {
  const bad: Record<string, unknown>[] = [
    { color: { a: { type: 'color', value: '#abcdef' } } },
    { color: { a: { type: 'color' } } },
    { color: { Bad: { type: 'color', value: '#ABCDEF' } } },
    { color: {} },
    { space: { a: { type: 'dimension', value: 4 } } },
    { space: { a: dimension(-1) } },
    { x: { a: { type: 'gradient', value: 'x' } } },
    { shadow: { a: { type: 'shadow', value: [{ x: 0, y: 0, blur: 0, color: '#000000' }] } } },
    { a: { b: dimension(1) }, 'a-b': dimension(1) },
  ];
  for (const tokens of bad) {
    expect(() => generateTokensCss(doc(tokens)), JSON.stringify(tokens)).toThrow(/design tokens/);
  }
  expect(() => generateTokensCss(doc({ space: { a: dimension(1) } }, 0))).toThrow(/cssFontBase/);
});

it('maps Tailwind namespaces without self references and rejects alias collisions', () => {
  const css = generateTailwindCss(
    doc({
      radius: { card: dimension(16) },
      focus: { width: dimension(2) },
      font: { weight: { bold: { type: 'fontWeight', value: 700 } } },
    }),
  );
  expect(css).toContain('  --radius-couli-card: var(--radius-card);');
  expect(css).toContain('  --spacing-couli-focus-width: var(--focus-width);');
  expect(css).toContain('  --font-weight-couli-bold: var(--font-weight-bold);');
  expect(() =>
    generateTailwindCss(
      doc({ space: { 'focus-width': dimension(1) }, focus: { width: dimension(2) } }),
    ),
  ).toThrow(/duplicate Tailwind alias/);
});

it('serializes the theme with quoted keys only where needed', () => {
  const tokens = doc({ space: { '0': dimension(0), 'x-y': dimension(1), z: dimension(2) } });
  expect(themeFromTokens(tokens)).toEqual({
    space: { '0': 'var(--space-0)', 'x-y': 'var(--space-x-y)', z: 'var(--space-z)' },
  });
  expect(generateThemeTs(tokens)).toContain(
    "  space: {\n    '0': 'var(--space-0)',\n    'x-y': 'var(--space-x-y)',\n    z: 'var(--space-z)',\n  },\n",
  );
});
