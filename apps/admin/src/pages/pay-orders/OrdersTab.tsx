// 「支付单」页签：GET /admin/v1/pay-orders（状态、渠道、需人工处理、商户单号、用户筛选，页码分页），
// 行的【详情】进 pay-orders/{pay_order_id}。只读：不显示渠道侧用户标识（契约不返回）。
// TODO(规划/11 §7): 【导出】、需人工处理单的【处置】、创建时间区间筛选 — blocked on 写接口 / 导出契约未出
import { Button, Card, Flex, Form, Input, Select, Tag, Typography, theme } from 'antd';
import type { TableColumnsType } from 'antd';
import { useId, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { payOrdersTexts } from '../../texts/pay-orders.ts';
import { DictName } from './DictName.tsx';
import {
  CHANNELS,
  EMPTY_ORDER_DRAFT,
  ORDERS_URL,
  ORDER_STATUSES,
  beijingTime,
  bizTypeLabel,
  channelLabel,
  checkOrderDraft,
  money,
  orderParams,
  orderStatusLabel,
  refundState,
  type OrderDraft,
  type OrderFilters,
  type PayChannel,
  type PayOrder,
  type PayOrderStatus,
} from './model.ts';
import { PagedTable, usePagedRead } from './PagedList.tsx';

const t = payOrdersTexts.orders;

export function OrdersTab(): ReactElement {
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const ids = {
    status: useId(),
    channel: useId(),
    manual: useId(),
    outTradeNo: useId(),
    user: useId(),
  };
  const [draft, setDraft] = useState<OrderDraft>(EMPTY_ORDER_DRAFT);
  const [userError, setUserError] = useState<string>();
  const [filters, setFilters] = useState<OrderFilters>({});
  const read = usePagedRead<PayOrder>(ORDERS_URL, orderParams(filters));

  const runQuery = () => {
    const checked = checkOrderDraft(draft);
    if ('userError' in checked) {
      setUserError(checked.userError);
      return;
    }
    setUserError(undefined);
    setFilters(checked.filters);
    read.restart();
  };
  const reset = () => {
    setDraft(EMPTY_ORDER_DRAFT);
    setUserError(undefined);
    setFilters({});
    read.restart();
  };

  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const amount = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;
  const columns: TableColumnsType<PayOrder> = [
    {
      key: 'outTradeNo',
      title: t.columns.outTradeNo,
      render: (_, row) => <span style={code}>{row.out_trade_no}</span>,
    },
    {
      key: 'user',
      title: t.columns.user,
      render: (_, row) => (
        <span style={{ ...code, fontSize: token.fontSizeSM }}>{row.user_id}</span>
      ),
    },
    {
      key: 'biz',
      title: t.columns.biz,
      render: (_, row) => <DictName>{bizTypeLabel(row.biz_type)}</DictName>,
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
      key: 'status',
      title: t.columns.status,
      render: (_, row) => {
        const refunds = refundState(row);
        return (
          <Flex wrap gap={4}>
            <Tag style={{ marginInlineEnd: 0 }}>
              <DictName>{orderStatusLabel(row.status)}</DictName>
            </Tag>
            {refunds === 'none' ? null : (
              <Tag color="success" style={{ marginInlineEnd: 0 }}>
                {refunds === 'fully' ? t.fullyRefunded : t.partlyRefunded}
              </Tag>
            )}
            {row.closing ? (
              <Tag color="processing" style={{ marginInlineEnd: 0 }}>
                {t.closing}
              </Tag>
            ) : null}
            {row.needs_manual ? (
              <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                {t.manual}
              </Tag>
            ) : null}
          </Flex>
        );
      },
    },
    {
      key: 'created',
      title: t.columns.created,
      render: (_, row) => (
        <span style={{ whiteSpace: 'nowrap' }}>{beijingTime(row.created_at)}</span>
      ),
    },
    {
      key: 'actions',
      title: t.columns.actions,
      width: 80,
      render: (_, row) => (
        <Button
          size="small"
          onClick={() => void navigate(`/pay-orders/${encodeURIComponent(row.pay_order_id)}`)}
        >
          {t.detailEntry}
        </Button>
      ),
    },
  ];

  return (
    <Flex vertical gap={16}>
      <Card>
        <Form layout="vertical" component="div">
          <Flex wrap gap={16} align="flex-start">
            <Form.Item label={t.filter.status} htmlFor={ids.status} style={{ marginBottom: 0 }}>
              <Select<PayOrderStatus>
                id={ids.status}
                value={draft.status ?? null}
                allowClear
                virtual={false}
                placeholder={payOrdersTexts.all}
                style={{ width: 140 }}
                options={ORDER_STATUSES.map((item) => ({
                  value: item,
                  label: orderStatusLabel(item),
                }))}
                onChange={(value: PayOrderStatus | undefined) =>
                  setDraft((previous) => ({ ...previous, status: value ?? undefined }))
                }
              />
            </Form.Item>
            <Form.Item label={t.filter.channel} htmlFor={ids.channel} style={{ marginBottom: 0 }}>
              <Select<PayChannel>
                id={ids.channel}
                value={draft.payChannel ?? null}
                allowClear
                virtual={false}
                placeholder={payOrdersTexts.all}
                style={{ width: 200 }}
                options={CHANNELS.map((item) => ({ value: item, label: channelLabel(item) }))}
                onChange={(value: PayChannel | undefined) =>
                  setDraft((previous) => ({ ...previous, payChannel: value ?? undefined }))
                }
              />
            </Form.Item>
            <Form.Item label={t.filter.manual} htmlFor={ids.manual} style={{ marginBottom: 0 }}>
              <Select<'true' | 'false'>
                id={ids.manual}
                value={
                  draft.needsManual === undefined ? null : draft.needsManual ? 'true' : 'false'
                }
                allowClear
                virtual={false}
                placeholder={payOrdersTexts.all}
                style={{ width: 120 }}
                options={[
                  { value: 'true', label: t.filter.manualYes },
                  { value: 'false', label: t.filter.manualNo },
                ]}
                onChange={(value: 'true' | 'false' | undefined) =>
                  setDraft((previous) => ({
                    ...previous,
                    needsManual:
                      value === undefined || value === null ? undefined : value === 'true',
                  }))
                }
              />
            </Form.Item>
            <Form.Item
              label={t.filter.outTradeNo}
              htmlFor={ids.outTradeNo}
              style={{ marginBottom: 0 }}
            >
              <Input
                id={ids.outTradeNo}
                value={draft.outTradeNo}
                placeholder={t.filter.outTradeNoPlaceholder}
                maxLength={64}
                style={{ width: 200 }}
                onChange={(event) => {
                  const value = event.target.value;
                  setDraft((previous) => ({ ...previous, outTradeNo: value }));
                }}
              />
            </Form.Item>
            <Form.Item
              label={t.filter.user}
              htmlFor={ids.user}
              validateStatus={userError === undefined ? '' : 'error'}
              help={userError}
              style={{ marginBottom: 0 }}
            >
              <Input
                id={ids.user}
                value={draft.userId}
                placeholder={t.filter.userPlaceholder}
                aria-invalid={userError === undefined ? undefined : true}
                style={{ width: 300 }}
                onChange={(event) => {
                  const value = event.target.value;
                  setDraft((previous) => ({ ...previous, userId: value }));
                }}
              />
            </Form.Item>
            <Flex gap={8} style={{ alignSelf: 'flex-end' }}>
              <Button onClick={reset}>{payOrdersTexts.reset}</Button>
              <Button type="primary" onClick={runQuery}>
                {payOrdersTexts.query}
              </Button>
            </Flex>
          </Flex>
        </Form>
      </Card>
      <PagedTable<PayOrder>
        read={read}
        title={t.listTitle}
        rowKey="pay_order_id"
        columns={columns}
        loadingText={t.loading}
        failedText={t.failed}
        emptyText={t.empty}
      />
      <Typography.Text type="secondary">{t.note}</Typography.Text>
    </Flex>
  );
}
