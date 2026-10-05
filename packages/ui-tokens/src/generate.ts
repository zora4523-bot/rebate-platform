/** Input is the complete contracts/design-tokens.json document, including metadata. */
export interface DesignTokens {
  schemaVersion: string;
  metadata: {
    version: string;
    cssFontBase: number;
    [key: string]: unknown;
  };
  tokens: Record<string, unknown>;
}

export interface TokenTheme {
  [key: string]: string | TokenTheme;
}

/** Token paths map to --<path joined with hyphens>; output is formatted CSS. */
export function generateTokensCss(tokens: DesignTokens): string {
  void tokens;
  throw new Error('NotImplemented: generateTokensCss');
}

/** Tailwind 4 theme aliases reference the canonical CSS variables. */
export function generateTailwindCss(tokens: DesignTokens): string {
  void tokens;
  throw new Error('NotImplemented: generateTailwindCss');
}

/** Every theme leaf references a canonical CSS variable, without literal values. */
export function themeFromTokens(tokens: DesignTokens): TokenTheme {
  void tokens;
  throw new Error('NotImplemented: themeFromTokens');
}

/** Pure serializer shared by the writing shell and the byte-for-byte drift check. */
export function generateThemeTs(tokens: DesignTokens): string {
  void tokens;
  throw new Error('NotImplemented: generateThemeTs');
}
