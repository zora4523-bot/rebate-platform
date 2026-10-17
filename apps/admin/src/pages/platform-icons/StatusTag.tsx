import { CheckCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { Tag, theme } from 'antd';
import type { ReactNode } from 'react';

export function StatusTag({
  tone = 'neutral',
  children,
}: {
  readonly tone?: 'neutral' | 'success' | 'warning';
  readonly children: ReactNode;
}) {
  const { token } = theme.useToken();
  return (
    <Tag
      bordered={false}
      icon={
        tone === 'success' ? (
          <CheckCircleOutlined aria-hidden />
        ) : tone === 'warning' ? (
          <WarningOutlined aria-hidden />
        ) : undefined
      }
      style={{
        color:
          tone === 'success'
            ? token.colorSuccess
            : tone === 'warning'
              ? token.colorWarning
              : token.colorTextSecondary,
        background:
          tone === 'success'
            ? 'var(--color-status-success-background)'
            : tone === 'warning'
              ? 'var(--color-status-warning-background)'
              : token.colorInfoBg,
        borderRadius: token.borderRadiusSM * 4,
      }}
    >
      {children}
    </Tag>
  );
}
