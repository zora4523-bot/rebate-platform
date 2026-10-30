// 「异常收款」页签：GET /admin/v1/pay-anomalies（渠道筛选，页码分页）；证据不返回、不显示。
// F1-13b：持 pay.refund 时每行有【退款】（原路退回，CT-21e createAdminPayAnomalyRefund，不设二次验证，
// 可退金额按收款金额减已退成功先查，成功后提示退款中并重新读取列表）。
// TODO(规划/11 §7): 异常收款的退款记录与单笔退款详情 — blocked on pay-refunds 读接口未实现
import { Alert, Button, Card, Flex, Form, Select, Tag, Typography, theme } from 'antd';
import type { TableColumnsType } from 'antd';
import { useId, useRef, useState, type ReactElement } from 'react';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { payOrdersTexts } from '../../texts/pay-orders.ts';
import { DictName } from './DictName.tsx';
import {
  ANOMALIES_URL,
  CHANNELS,
  anomalyParams,
  anomalyRefundUrl,
  anomalyRefundable,
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
import { useRefund } from './useRefund.tsx';

const t = payOrdersTexts.anomalies;

interface Notice {
  readonly id: number;
  readonly type: 'success' | 'warning' | 'error';
  readonly text: string;
}

export interface AnomaliesTabProps {
  readonly access: AccessControl;
}

export function AnomaliesTab({ access }: AnomaliesTabProps): ReactElement {
  const { token } = theme.useToken();
  const channelId = useId();
  const [draft, setDraft] = useState<PayChannel>();
  const [filters, setFilters] = useState<AnomalyFilters>({});
  const read = usePagedRead<PayAnomaly>(ANOMALIES_URL, anomalyParams(filters));
  const canRefund = access.can('pay.refund');

  const notices = useRef(0);
  const [notice, setNotice] = useState<Notice>();
  const tell = (type: Notice['type'], text: string) => {
    notices.current += 1;
    setNotice({ id: notices.current, type, text });
  };
  const refund = useRefund({
    onAccepted: (created) => {
      tell('success', t.accepted(money(created.amount_fen)));
      read.reload();
    },
    onConflict: () => {
      tell('warning', t.conflict);
      read.reload();
    },
    onMissing: () => {
      tell('error', payOrdersTexts.refund.missingAnomaly);
      read.reload();
    },
    onUncertainClose: () => {
      read.reload();
    },
  });
  const startRefund = (row: PayAnomaly) => {
    const refundable = anomalyRefundable(row);
    if (!canRefund || refundable <= 0n) return;
    setNotice(undefined);
    refund.start({
      url: anomalyRefundUrl(row.pay_anomaly_id),
      label: t.refundTarget(row.channel_trade_no),
      refundable,
      refundableNote: t.refundableNote,
    });
  };

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
    ...(canRefund
      ? [
          {
            key: 'actions',
            title: t.columns.actions,
            render: (_: unknown, row: PayAnomaly) => (
              <Button
                size="small"
                danger
                autoInsertSpace={false}
                disabled={anomalyRefundable(row) <= 0n}
                onClick={() => startRefund(row)}
              >
                {t.refundEntry}
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <Flex vertical gap={16}>
      <Typography.Text type="secondary">{t.note}</Typography.Text>
      {notice === undefined ? null : (
        <Alert
          key={notice.id}
          type={notice.type}
          showIcon
          closable
          role={notice.type === 'success' ? 'status' : 'alert'}
          message={notice.text}
          onClose={() => setNotice(undefined)}
        />
      )}
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
      {refund.modal}
    </Flex>
  );
}
