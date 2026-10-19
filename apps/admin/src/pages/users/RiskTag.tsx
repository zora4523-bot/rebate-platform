// Risk-state Tag (design-hifi AdmUsers, AdmUserDetail): antd preset status colour plus an icon;
// the text carries the meaning, the icon is decoration only.
import { CheckCircleOutlined, ClockCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { Tag } from 'antd';
import type { ReactElement } from 'react';
import { riskLabel, riskTagColor } from './model.ts';

function riskIcon(state: string): ReactElement | undefined {
  if (state === 'normal') return <CheckCircleOutlined aria-hidden />;
  if (state === 'appealing') return <ClockCircleOutlined aria-hidden />;
  if (state === 'frozen' || state === 'banned') return <WarningOutlined aria-hidden />;
  return undefined;
}

export function RiskTag({ state }: { readonly state: string }): ReactElement {
  return (
    <Tag color={riskTagColor(state)} icon={riskIcon(state)} style={{ marginInlineEnd: 0 }}>
      {riskLabel(state)}
    </Tag>
  );
}
