// @couli/ui-tokens: design tokens for H5 and admin (规划/03 §10.1), from the snapshot in
// contracts/design-tokens.json.
//   `.`              TS theme object (var() references) and the pure generators
//   `./tokens.css`   CSS variables      -> src/tokens.gen.css   (generated)
//   `./tailwind.css` Tailwind 4 @theme  -> src/tailwind.gen.css (generated, needs tokens.css)
// Regenerate all three: node packages/ui-tokens/scripts/generate.ts

export { tokenTheme } from './theme.gen.ts';
export {
  generateTokensCss,
  generateTailwindCss,
  themeFromTokens,
  generateThemeTs,
} from './generate.ts';
export type { DesignTokens, TokenTheme } from './generate.ts';
