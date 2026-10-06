// Ant Design theme mapped onto the @couli/ui-tokens CSS variables. antd derives hover and active
// shades in JavaScript, so colour tokens need resolved values: they are read from the variables
// at runtime and left at antd's defaults when the variables are absent (no stylesheet loaded).
import type { ThemeConfig } from 'antd';

type ColorToken =
  | 'colorPrimary'
  | 'colorLink'
  | 'colorText'
  | 'colorTextSecondary'
  | 'colorBorder'
  | 'colorBorderSecondary'
  | 'colorBgLayout'
  | 'colorBgContainer'
  | 'colorSuccess'
  | 'colorWarning'
  | 'colorError';

const COLOR_VARIABLES: readonly (readonly [ColorToken, string])[] = [
  ['colorPrimary', '--color-brand-primary'],
  ['colorLink', '--color-text-link'],
  ['colorText', '--color-text-primary'],
  ['colorTextSecondary', '--color-text-secondary'],
  ['colorBorder', '--color-border-control'],
  ['colorBorderSecondary', '--color-border-subtle'],
  ['colorBgLayout', '--color-background-admin-canvas'],
  ['colorBgContainer', '--color-background-surface'],
  ['colorSuccess', '--color-status-success-text'],
  ['colorWarning', '--color-status-warning-text'],
  ['colorError', '--color-status-error-text'],
];

export function createAntdTheme(root: Element = document.documentElement): ThemeConfig {
  const style = getComputedStyle(root);
  const colors: Partial<Record<ColorToken, string>> = {};
  for (const [token, variable] of COLOR_VARIABLES) {
    const value = style.getPropertyValue(variable).trim();
    if (value !== '') colors[token] = value;
  }
  return {
    token: {
      ...colors,
      fontFamily: 'var(--font-family-system)',
      fontSize: 14,
      borderRadius: 8,
    },
    components: {
      Button: { controlHeight: 36, fontWeight: 600, paddingInline: 16 },
    },
  };
}
