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
  | 'colorError'
  | 'colorInfo'
  | 'colorInfoHover'
  | 'colorInfoText'
  | 'colorInfoBg'
  | 'colorInfoBorder'
  | 'colorInfoBorderHover';

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
  // Info is neutral on the boards (muted panel, no border, secondary icon), not antd blue.
  ['colorInfo', '--color-text-secondary'],
  ['colorInfoHover', '--color-text-secondary'],
  ['colorInfoText', '--color-text-secondary'],
  ['colorInfoBg', '--color-background-muted'],
  ['colorInfoBorder', '--color-background-muted'],
  ['colorInfoBorderHover', '--color-background-muted'],
];

export function createAntdTheme(root: Element = document.documentElement): ThemeConfig {
  const style = getComputedStyle(root);
  const colors: Partial<Record<ColorToken, string>> = {};
  for (const [token, variable] of COLOR_VARIABLES) {
    const value = style.getPropertyValue(variable).trim();
    if (value !== '') colors[token] = value;
  }
  const menuSelectedBg = style.getPropertyValue('--color-brand-subtle').trim();
  const menuSelectedColor = style.getPropertyValue('--color-brand-primary').trim();
  return {
    token: {
      ...colors,
      fontFamily: 'var(--font-family-system)',
      fontSize: 14,
      borderRadius: 8,
    },
    components: {
      Button: { controlHeight: 36, fontWeight: 600, paddingInline: 16 },
      Input: { controlHeight: 40 },
      Form: { itemMarginBottom: 20, verticalLabelPadding: '0 0 6px' },
      // Shell (design-hifi Adm* boards): 220 wide light sider, 56 high header on the surface.
      Layout: {
        headerHeight: 56,
        headerPadding: '0 24px',
        ...(colors.colorBgContainer === undefined ? {} : { headerBg: colors.colorBgContainer }),
        ...(colors.colorBgLayout === undefined ? {} : { bodyBg: colors.colorBgLayout }),
      },
      // Sider menu: 32 high items, 4 apart; the selected item uses the brand tint tokens.
      Menu: {
        itemHeight: 32,
        itemMarginBlock: 4,
        itemMarginInline: 8,
        groupTitleFontSize: 12,
        activeBarBorderWidth: 0,
        ...(menuSelectedBg === '' ? {} : { itemSelectedBg: menuSelectedBg }),
        ...(menuSelectedColor === '' ? {} : { itemSelectedColor: menuSelectedColor }),
      },
    },
  };
}
