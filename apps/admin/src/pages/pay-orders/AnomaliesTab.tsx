// 「异常收款」页签：GET /admin/v1/pay-anomalies（渠道筛选，页码分页）。只读；证据不返回、不显示。
// TODO(规划/11 §7): 异常收款的【原路退款】 — blocked on 写接口未接入（本段只读）
import { Button, Card, Flex, Form, Select, Tag, Typography, theme } from 'antd';
import type { TableColumnsType } from 'antd';
import { useId, useState, type ReactElement } from 'react';
import { payOrdersTexts } from '../../texts/pay-orders.ts';
import { DictName } from './DictName.tsx';
import {
  ANOMALIES_URL,
  CHANNELS,
  anomalyParams,
  anomalyStatusLabel,
  beijingTime,
  channelLabel,
  money,
  orDash,
  type AnomalyFilters,
  type PayAnomaly,
  type PayChannel,
} from './model.ts';
import { PagedTable, usePagedRead } from './PagedList.tsx';

const t = payOrdersTexts.anomalies;

export function AnomaliesTab(): ReactElement {
  const { token } = theme.useToken();
  const channelId = useId();
  const [draft, setDraft] = useState<PayChannel>();
  const [filters, setFilters] = useState<AnomalyFilters>({});
  const read = usePagedRead<PayAnomaly>(ANOMALIES_URL, anomalyParams(filters));

  const runQuery = () => {
    setFilters(draft === undefined ? {} : { payChannel: draft });
    read.restart();
  };
  const reset = () => {
    setDraft(undefined);
    setFilters({});
    read.restart();
  };

  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const amount = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;
  const columns: TableColumnsType<PayAnomaly> = [
    {
      key: 'tradeNo',
      title: t.columns.tradeNo,
      render: (_, row) => <span style={code}>{row.channel_trade_no}</span>,
    },
    {
      key: 'channel',
      title: t.columns.channel,
      render: (_, row) => (
        <span style={{ whiteSpace: 'nowrap' }}>
          <DictName>{channelLabel(row.pay_channel)}</DictName>
        </span>
      ),
    },
    {
      key: 'outTradeNo',
      title: t.columns.outTradeNo,
      render: (_, row) => <span style={code}>{orDash(row.out_trade_no)}</span>,
    },
    {
      key: 'amount',
      title: t.columns.amount,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.amount_fen)}</span>,
    },
    {
      key: 'refunded',
      title: t.columns.refunded,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.refunded_fen)}</span>,
    },
    {
      key: 'received',
      title: t.columns.received,
      render: (_, row) => (
        <span style={{ whiteSpace: 'nowrap' }}>{beijingTime(row.created_at)}</span>
      ),
    },
    {
      key: 'status',
      title: t.columns.status,
      render: (_, row) => (
        <Tag style={{ marginInlineEnd: 0 }}>
          <DictName>{anomalyStatusLabel(row.status)}</DictName>
        </Tag>
      ),
    },
  ];

  return (
    <Flex vertical gap={16}>
      <Typography.Text type="secondary">{t.note}</Typography.Text>
      <Card>
        <Form layout="vertical" component="div">
          <Flex wrap gap={16} align="flex-end">
            <Form.Item label={t.filter.channel} htmlFor={channelId} style={{ marginBottom: 0 }}>
              <Select<PayChannel>
                id={channelId}
                value={draft ?? null}
                allowClear
                virtual={false}
                placeholder={payOrdersTexts.all}
                style={{ width: 200 }}
                options={CHANNELS.map((item) => ({ value: item, label: channelLabel(item) }))}
                onChange={(value: PayChannel | undefined) => setDraft(value ?? undefined)}
              />
            </Form.Item>
            <Flex gap={8}>
              <Button onClick={reset}>{payOrdersTexts.reset}</Button>
              <Button type="primary" onClick={runQuery}>
                {payOrdersTexts.query}
              </Button>
            </Flex>
          </Flex>
        </Form>
      </Card>
      <PagedTable<PayAnomaly>
        read={read}
        title={t.listTitle}
        rowKey="pay_anomaly_id"
        columns={columns}
        loadingText={t.loading}
        failedText={t.failed}
        emptyText={t.empty}
      />
    </Flex>
  );
}
