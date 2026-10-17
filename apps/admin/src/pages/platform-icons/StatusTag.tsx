import { CheckCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { Tag, theme } from 'antd';
import type { ReactNode } from 'react';

export function StatusTag({
  tone = 'neutral',
  children,
}: {
  readonly tone?: 'neutral' | 'success' | 'warning' | 'error';
  readonly children: ReactNode;
}) {
  const { token } = theme.useToken();
  return (
    <Tag
      bordered={false}
      icon={
        tone === 'success' ? (
          <CheckCircleOutlined aria-hidden />
        ) : tone === 'warning' || tone === 'error' ? (
          <WarningOutlined aria-hidden />
        ) : undefined
      }
      style={{
        color:
          tone === 'success'
            ? token.colorSuccess
            : tone === 'warning'
              ? token.colorWarning
              : tone === 'error'
                ? token.colorError
                : token.colorTextSecondary,
        background:
          tone === 'success'
            ? 'var(--color-status-success-background)'
            : tone === 'warning'
              ? 'var(--color-status-warning-background)'
              : tone === 'error'
                ? 'var(--color-status-error-background)'
                : token.colorInfoBg,
        borderRadius: token.borderRadiusSM * 4,
      }}
    >
      {children}
    </Tag>
  );
}
