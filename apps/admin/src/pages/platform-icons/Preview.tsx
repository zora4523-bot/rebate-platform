import type { PlatformIconKey } from '@couli/contracts-ts';
import { Typography, theme } from 'antd';
import { platformIconsTexts as t } from '../../texts/platform-icons.ts';
import { builtinIconUrls } from './builtin.ts';

export interface PreviewRow {
  readonly label: string;
  readonly url: string;
}

export function builtinRow(key: PlatformIconKey, label: string = t.builtin): PreviewRow {
  return { label, url: builtinIconUrls[key] };
}

export function Preview({
  iconKey,
  rows,
  large = false,
}: {
  readonly iconKey: PlatformIconKey;
  readonly rows: readonly PreviewRow[];
  readonly large?: boolean;
}) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: large ? '120px 114px 114px' : '64px 106px 106px',
        gap: '6px 8px',
        alignItems: 'center',
        fontSize: 12,
      }}
    >
      <span />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t.light}
      </Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t.dark}
      </Typography.Text>
      {rows.map((row) => (
        <PreviewLine
          key={row.label}
          iconKey={iconKey}
          row={row}
          border={token.colorBorderSecondary}
          radius={token.borderRadius}
          light={token.colorBgContainer}
          dark={token.colorText}
          large={large}
        />
      ))}
    </div>
  );
}

function PreviewLine({
  iconKey,
  row,
  border,
  radius,
  light,
  dark,
  large,
}: {
  readonly iconKey: PlatformIconKey;
  readonly row: PreviewRow;
  readonly border: string;
  readonly radius: number;
  readonly light: string;
  readonly dark: string;
  readonly large: boolean;
}) {
  return (
    <>
      <span>{row.label}</span>
      {[t.light, t.dark].map((background) => (
        <div
          key={background}
          role="img"
          aria-label={t.previewName(t.names[iconKey], row.label, background)}
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            gap: 6,
            padding: large ? 10 : 6,
            height: large ? 54 : 46,
            boxSizing: 'border-box',
            background: background === t.light ? light : dark,
            border: `1px solid ${background === t.light ? border : dark}`,
            borderRadius: radius,
          }}
        >
          {[16, 24, 32].map((size) => (
            <img
              key={size}
              src={row.url}
              alt={t.names[iconKey]}
              width={size}
              height={size}
              style={{ objectFit: 'contain', flex: 'none' }}
            />
          ))}
        </div>
      ))}
    </>
  );
}
