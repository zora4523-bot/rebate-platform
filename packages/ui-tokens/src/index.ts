// @couli/ui-tokens: design tokens for H5 and admin.
//   `.`              TS theme object (this file)
//   `./tokens.css`   CSS variables      -> src/tokens.gen.css   (generated)
//   `./tailwind.css` Tailwind 4 @theme  -> src/tailwind.gen.css (generated)
// TODO(规划/11 §2.3): the token snapshot, the theme object and both generated CSS files are implemented by CT-11a — blocked on CT-11a

/** Workspace package name; the only export until CT-11a lands. */
export const PACKAGE_NAME = '@couli/ui-tokens';

export {
  generateTokensCss,
  generateTailwindCss,
  themeFromTokens,
  generateThemeTs,
} from './generate.ts';
export type { DesignTokens, TokenTheme } from './generate.ts';
