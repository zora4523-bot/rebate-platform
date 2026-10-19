import tokenSource from '../../../../contracts/design-tokens.json?raw';

interface ColorLeaf {
  value: string;
  dark: string;
}

const { tokens } = JSON.parse(tokenSource) as {
  tokens: {
    color: {
      brand: Record<'primary' | 'subtle', ColorLeaf>;
      text: Record<'primary' | 'secondary' | 'link', ColorLeaf>;
      background: Record<'admin-canvas' | 'surface' | 'muted', ColorLeaf>;
      border: Record<'control' | 'subtle', ColorLeaf>;
      status: Record<'success' | 'warning' | 'error', { text: ColorLeaf }>;
    };
  };
};
export const color = tokens.color;

// Independent acceptance mapping: expectations come from the contract, never theme.ts.
export const mapping = [
  ['colorPrimary', '--color-brand-primary', color.brand.primary],
  ['colorLink', '--color-text-link', color.text.link],
  ['colorText', '--color-text-primary', color.text.primary],
  ['colorTextSecondary', '--color-text-secondary', color.text.secondary],
  ['colorBorder', '--color-border-control', color.border.control],
  ['colorBorderSecondary', '--color-border-subtle', color.border.subtle],
  ['colorBgLayout', '--color-background-admin-canvas', color.background['admin-canvas']],
  ['colorBgContainer', '--color-background-surface', color.background.surface],
  ['colorSuccess', '--color-status-success-text', color.status.success.text],
  ['colorWarning', '--color-status-warning-text', color.status.warning.text],
  ['colorError', '--color-status-error-text', color.status.error.text],
  ['colorInfo', '--color-text-secondary', color.text.secondary],
  ['colorInfoHover', '--color-text-secondary', color.text.secondary],
  ['colorInfoText', '--color-text-secondary', color.text.secondary],
  ['colorInfoBg', '--color-background-muted', color.background.muted],
  ['colorInfoBorder', '--color-background-muted', color.background.muted],
  ['colorInfoBorderHover', '--color-background-muted', color.background.muted],
] as const;

/** Same CSS rules as the system media block, only the media condition is removed.
 * This does not paint antd components or provide a replacement application theme.
 */
export function emulateSystemDark(tokenCss: string): HTMLStyleElement {
  const sheet = document.createElement('style');
  sheet.textContent =
    tokenCss.match(
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*([^{}]+\{[^{}]*\})\s*\}/,
    )?.[1] ?? '';
  document.head.append(sheet);
  return sheet;
}
