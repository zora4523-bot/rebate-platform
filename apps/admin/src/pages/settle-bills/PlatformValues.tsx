// 按平台的账单合计（子订单数、联盟结算佣金）：照契约逐个平台显示，不在页面上求和；出账中（null）
// 显示短横。平台只以编码标识。
import { Flex, Typography } from 'antd';
import type { ReactElement } from 'react';
import { settleBillsTexts as t } from '../../texts/settle-bills.ts';

export interface PlatformValuesProps {
  readonly entries: readonly (readonly [string, number])[];
  readonly format: (value: number) => string;
}

export function PlatformValues({ entries, format }: PlatformValuesProps): ReactElement {
  if (entries.length === 0) return <span>{t.dash}</span>;
  return (
    <Flex vertical gap={2}>
      {entries.map(([platform, value]) => (
        <span key={platform} style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          <Typography.Text type="secondary">{platform}</Typography.Text>{' '}
          <span>{format(value)}</span>
        </span>
      ))}
    </Flex>
  );
}
