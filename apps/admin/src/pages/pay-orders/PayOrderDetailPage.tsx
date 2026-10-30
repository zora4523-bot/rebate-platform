// 支付单详情（pay-orders/{pay_order_id}；画板 AdmPayOrderDetail，F1-13a 第一段只读）：
// GET /admin/v1/pay-orders/{pay_order_id} 的基本信息与金额、退款记录、近期渠道请求摘要（只有类型、
// 结果与时间）。不存在或他 app 的支付单（20001）显示未找到。持 pay.view 可看；不显示渠道侧用户标识。
// TODO(规划/11 §7): 【立即查询】【发起退款】【处置】、渠道通知记录、状态历史与收款凭证 — blocked on 写接口 / 读接口契约未出
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Flex,
  Result,
  Table,
  Tag,
  Typography,
  theme,
  type TableColumnsType,
} from 'antd';
import { useEffect, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { PlannedPage, usePlanned } from '../../components/planned/index.ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { payOrdersTexts } from '../../texts/pay-orders.ts';
import { DictName } from './DictName.tsx';
import {
  attemptKindLabel,
  attemptResultLabel,
  beijingTime,
  bizTypeLabel,
  channelLabel,
  codeOf,
  money,
  orDash,
  orderStatusLabel,
  orderUrl,
  refundReasonLabel,
  refundState,
  refundStatusLabel,
  type PayOrderDetail,
  type PayRefund,
  type QueryAttempt,
} from './model.ts';
import { PayForbidden, PayTitle, canReadPayOrders } from './PayOrdersPage.tsx';

const t = payOrdersTexts.detail;

type DetailState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: PayOrderDetail }
  | { readonly status: 'missing' }
  | { readonly status: 'failed' }
  | { readonly status: 'forbidden' };

export interface PayOrderDetailPageProps {
  readonly access: AccessControl;
  readonly payOrderId: string;
}

export function PayOrderDetailPage({ access, payOrderId }: PayOrderDetailPageProps): ReactElement {
  const planned = usePlanned('getAdminPayOrder');
  if (planned) return <PlannedPage title={payOrdersTexts.title} />;
  if (!canReadPayOrders(access)) return <PayForbidden />;
  return <DetailContent payOrderId={payOrderId} />;
}

function DetailContent({ payOrderId }: { readonly payOrderId: string }): ReactElement {
  const getProvider = useDataProvider();
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DetailState>({ status: 'loading' });

  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<PayOrderDetail>({ url: orderUrl(payOrderId), method: 'get' }).then(
      (response) => {
        if (current) setState({ status: 'ready', data: response.data });
      },
      (cause: unknown) => {
        if (!current) return;
        const code = codeOf(cause);
        setState({
          status: code === 20001 ? 'missing' : code === 10403 ? 'forbidden' : 'failed',
        });
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, payOrderId, attempt]);

  const retry = () => {
    setState({ status: 'loading' });
    setAttempt((value) => value + 1);
  };

  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const amount = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;
  const nowrap = { whiteSpace: 'nowrap' } as const;

  const refundColumns: TableColumnsType<PayRefund> = [
    {
      key: 'outRefundNo',
      title: t.refundColumns.outRefundNo,
      render: (_, row) => <span style={code}>{row.out_refund_no}</span>,
    },
    {
      key: 'amount',
      title: t.refundColumns.amount,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.amount_fen)}</span>,
    },
    {
      key: 'reason',
      title: t.refundColumns.reason,
      render: (_, row) => <DictName>{refundReasonLabel(row.reason_code)}</DictName>,
    },
    {
      key: 'status',
      title: t.refundColumns.status,
      render: (_, row) => (
        <Tag style={{ marginInlineEnd: 0 }}>
          <DictName>{refundStatusLabel(row.status)}</DictName>
        </Tag>
      ),
    },
    {
      key: 'channelRefundNo',
      title: t.refundColumns.channelRefundNo,
      render: (_, row) => <span style={code}>{orDash(row.channel_refund_no)}</span>,
    },
    {
      key: 'operator',
      title: t.refundColumns.operator,
      render: (_, row) => (
        <span style={{ ...code, fontSize: token.fontSizeSM }}>{orDash(row.operator)}</span>
      ),
    },
    {
      key: 'created',
      title: t.refundColumns.created,
      render: (_, row) => <span style={nowrap}>{beijingTime(row.created_at)}</span>,
    },
    {
      key: 'succeeded',
      title: t.refundColumns.succeeded,
      render: (_, row) => <span style={nowrap}>{beijingTime(row.succeeded_at)}</span>,
    },
  ];

  const attemptColumns: TableColumnsType<QueryAttempt> = [
    {
      key: 'at',
      title: t.attemptColumns.at,
      render: (_, row) => <span style={nowrap}>{beijingTime(row.at)}</span>,
    },
    {
      key: 'kind',
      title: t.attemptColumns.kind,
      render: (_, row) => <DictName>{attemptKindLabel(row.kind)}</DictName>,
    },
    {
      key: 'result',
      title: t.attemptColumns.result,
      render: (_, row) => <DictName>{attemptResultLabel(row.result)}</DictName>,
    },
  ];

  let body: ReactElement;
  if (state.status === 'loading') {
    body = (
      <Card>
        <Typography.Text type="secondary" role="status">
          {t.loading}
        </Typography.Text>
      </Card>
    );
  } else if (state.status === 'forbidden') {
    body = (
      <Card>
        <Result
          status="403"
          title={payOrdersTexts.forbiddenTitle}
          subTitle={payOrdersTexts.forbiddenDescription}
        />
      </Card>
    );
  } else if (state.status === 'missing' || state.status === 'failed') {
    body = (
      <Card>
        <Result
          status={state.status === 'missing' ? 'warning' : 'error'}
          title={state.status === 'missing' ? t.missing : t.failed}
          extra={
            state.status === 'missing' ? undefined : (
              <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={retry}>
                {payOrdersTexts.retry}
              </Button>
            )
          }
        />
      </Card>
    );
  } else {
    const { pay_order: order, refunds, query_attempts: attempts } = state.data;
    const refunded = refundState(order);
    const f = t.fields;
    // Only contract fields are read one by one: anything else the server sends is never shown.
    body = (
      <Flex vertical gap={16}>
        <Card title={t.basic}>
          <Descriptions
            column={{ xs: 1, md: 2, xl: 3 }}
            items={[
              {
                key: 'outTradeNo',
                label: f.outTradeNo,
                children: <span style={code}>{order.out_trade_no}</span>,
              },
              {
                key: 'channelTradeNo',
                label: f.channelTradeNo,
                children: <span style={code}>{orDash(order.channel_trade_no)}</span>,
              },
              {
                key: 'status',
                label: f.status,
                children: (
                  <Flex wrap gap={4}>
                    <Tag style={{ marginInlineEnd: 0 }}>
                      <DictName>{orderStatusLabel(order.status)}</DictName>
                    </Tag>
                    {refunded === 'none' ? null : (
                      <Tag color="success" style={{ marginInlineEnd: 0 }}>
                        {refunded === 'fully'
                          ? payOrdersTexts.orders.fullyRefunded
                          : payOrdersTexts.orders.partlyRefunded}
                      </Tag>
                    )}
                    {order.closing ? (
                      <Tag color="processing" style={{ marginInlineEnd: 0 }}>
                        {payOrdersTexts.orders.closing}
                      </Tag>
                    ) : null}
                    {order.needs_manual ? (
                      <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                        {payOrdersTexts.orders.manual}
                      </Tag>
                    ) : null}
                  </Flex>
                ),
              },
              {
                key: 'channel',
                label: f.channel,
                children: <DictName>{channelLabel(order.pay_channel)}</DictName>,
              },
              {
                key: 'biz',
                label: f.biz,
                children: <DictName>{bizTypeLabel(order.biz_type)}</DictName>,
              },
              {
                key: 'bizRef',
                label: f.bizRef,
                children: (
                  <span style={{ ...code, fontSize: token.fontSizeSM }}>{order.biz_ref}</span>
                ),
              },
              {
                key: 'user',
                label: f.user,
                children: (
                  <span style={{ ...code, fontSize: token.fontSizeSM }}>{order.user_id}</span>
                ),
              },
              {
                key: 'amount',
                label: f.amount,
                children: <span style={amount}>{money(order.amount_fen)}</span>,
              },
              {
                key: 'refunded',
                label: f.refunded,
                children: <span style={amount}>{money(order.refunded_fen)}</span>,
              },
              {
                key: 'created',
                label: f.created,
                children: <span style={nowrap}>{beijingTime(order.created_at)}</span>,
              },
              {
                key: 'expire',
                label: f.expire,
                children: <span style={nowrap}>{beijingTime(order.expire_at)}</span>,
              },
              {
                key: 'paid',
                label: f.paid,
                children: <span style={nowrap}>{beijingTime(order.paid_at)}</span>,
              },
              {
                key: 'closed',
                label: f.closed,
                children: <span style={nowrap}>{beijingTime(order.closed_at)}</span>,
              },
            ]}
          />
        </Card>
        <Card
          title={t.refundsTitle}
          extra={<Typography.Text type="secondary">{t.refundsHint}</Typography.Text>}
          styles={{ body: { padding: 0 } }}
        >
          <Table<PayRefund>
            rowKey="pay_refund_id"
            columns={refundColumns}
            dataSource={refunds as PayRefund[]}
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: t.refundsEmpty }}
          />
        </Card>
        <Card
          title={t.attemptsTitle}
          extra={<Typography.Text type="secondary">{t.attemptsHint}</Typography.Text>}
          styles={{ body: { padding: 0 } }}
        >
          <Table<QueryAttempt>
            rowKey={(row) => `${row.at}:${row.kind}:${row.result}`}
            columns={attemptColumns}
            dataSource={attempts as QueryAttempt[]}
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: t.attemptsEmpty }}
          />
        </Card>
      </Flex>
    );
  }

  return (
    <Flex vertical gap={16}>
      <Flex align="center" gap={12} wrap>
        <Button
          icon={<ArrowLeftOutlined aria-hidden />}
          onClick={() => void navigate('/pay-orders')}
        >
          {t.back}
        </Button>
        <PayTitle>{t.title}</PayTitle>
      </Flex>
      <Alert type="info" showIcon role="note" message={payOrdersTexts.balanceNotice} />
      {body}
    </Flex>
  );
}
