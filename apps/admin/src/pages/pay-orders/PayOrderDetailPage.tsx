// 支付单详情（pay-orders/{pay_order_id}；画板 AdmPayOrderDetail，F1-13a 第一段只读）：
// GET /admin/v1/pay-orders/{pay_order_id} 的基本信息与金额、退款记录、近期渠道请求摘要（只有类型、
// 结果与时间）。不存在或他 app 的支付单（20001）显示未找到。持 pay.view 可看；不显示渠道侧用户标识。
// F1-13b 第二段写操作：持 pay.refund 时已支付的单有【发起退款】（原路退款，CT-21e createAdminPayRefund，
// 不设二次验证，成功后提示退款中并重新读取详情）；持 pay.resolve 时待支付且需人工处理的单有【立即查询】
// （resolveAdminPayOrder：totp 动态码、固定请求体、无 Idempotency-Key，按结果提示并重新读取详情）。
// TODO(规划/11 §7): 单笔退款详情与退款单列表 — blocked on pay-refunds 读接口未实现
// TODO(规划/11 §7): 【处置】、渠道通知记录、状态历史与收款凭证 — blocked on 写接口 / 读接口契约未出
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
import { useEffect, useRef, useState, type ReactElement } from 'react';
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
  isNetwork,
  money,
  orDash,
  orderRefundUrl,
  orderRefundable,
  orderResolveUrl,
  orderStatusLabel,
  orderUrl,
  RESOLVE_BODY,
  refundReasonLabel,
  refundState,
  refundStatusLabel,
  type PayOrder,
  type PayOrderDetail,
  type PayOrderResolveResult,
  type PayRefund,
  type QueryAttempt,
} from './model.ts';
import { PayForbidden, PayTitle, canReadPayOrders } from './PayOrdersPage.tsx';
import { useRefund } from './useRefund.tsx';
import { useStepUp } from './useStepUp.tsx';

const t = payOrdersTexts.detail;
const r = payOrdersTexts.resolve;

interface Notice {
  readonly id: number;
  readonly type: 'success' | 'info' | 'warning' | 'error';
  readonly text: string;
}

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
  return <DetailContent access={access} payOrderId={payOrderId} />;
}

/** 【发起退款】: pay.refund and a PAID pay order (BR-PAY-06 ①). */
function mayRefund(access: AccessControl, order: PayOrder): boolean {
  return access.can('pay.refund') && order.status === 'PAID';
}
/** 【立即查询】: pay.resolve and a PENDING pay order with needs_manual (BR-PAY-05 ③). */
function mayResolve(access: AccessControl, order: PayOrder): boolean {
  return access.can('pay.resolve') && order.status === 'PENDING' && order.needs_manual;
}

function DetailContent({ access, payOrderId }: PayOrderDetailPageProps): ReactElement {
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
  /** Reads the detail again, keeping the current one on screen until the answer. */
  const reload = () => setAttempt((value) => value + 1);

  const notices = useRef(0);
  const [notice, setNotice] = useState<Notice>();
  const tell = (type: Notice['type'], text: string) => {
    notices.current += 1;
    setNotice({ id: notices.current, type, text });
  };

  const refund = useRefund({
    onAccepted: (created) => {
      tell('success', t.accepted(money(created.amount_fen)));
      reload();
    },
    onConflict: () => {
      tell('warning', t.conflict);
      reload();
    },
    onMissing: () => {
      tell('error', payOrdersTexts.refund.missingOrder);
      reload();
    },
    onUncertainClose: () => {
      reload();
    },
  });

  const stepUp = useStepUp();
  const resolving = useRef(false);
  const [resolveBusy, setResolveBusy] = useState(false);

  const sendResolve = async (outTradeNo: string, stepUpToken: string) => {
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    resolving.current = true;
    setResolveBusy(true);
    try {
      const response = await custom<PayOrderResolveResult>({
        url: orderResolveUrl(payOrderId),
        method: 'post',
        payload: RESOLVE_BODY,
        meta: { stepUpToken },
      });
      const status = response.data.pay_order.status;
      if (status === 'PAID') tell('success', r.paid);
      else if (status === 'CLOSED') tell('success', r.closed);
      else tell('warning', r.unchanged);
      reload();
    } catch (cause) {
      const code = codeOf(cause);
      if (code === 10003) {
        // The verification was not accepted: ask for a new code, never resend on its own.
        askResolve(outTradeNo, true);
      } else if (code === 20902) {
        tell('warning', r.conflict);
        reload();
      } else if (code === 20001) {
        tell('error', r.missing);
        reload();
      } else if (code === 10403) {
        tell('error', r.forbidden);
      } else if (isNetwork(cause)) {
        tell('error', r.network);
        reload();
      } else {
        tell('error', r.failed);
      }
    } finally {
      resolving.current = false;
      setResolveBusy(false);
    }
  };

  function askResolve(outTradeNo: string, again = false): void {
    stepUp.ask({
      operation: r.operation,
      details: [t.refundTarget(outTradeNo)],
      again,
      run: (stepUpToken) => void sendResolve(outTradeNo, stepUpToken),
    });
  }

  const startResolve = (order: PayOrder) => {
    if (resolving.current || stepUp.open || !mayResolve(access, order)) return;
    setNotice(undefined);
    askResolve(order.out_trade_no);
  };

  const startRefund = (order: PayOrder, refundable: bigint) => {
    if (!mayRefund(access, order) || refundable <= 0n) return;
    setNotice(undefined);
    refund.start({
      url: orderRefundUrl(payOrderId),
      label: t.refundTarget(order.out_trade_no),
      refundable,
      refundableNote: t.refundableNote,
    });
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
    const refundable = orderRefundable(order, refunds);
    // Two attempts may share time, kind and result: their position keeps the keys unique.
    const attemptKeys = new Map(
      attempts.map((row, index): [QueryAttempt, string] => [row, `${index}`]),
    );
    const f = t.fields;
    const actions = (
      <Flex gap={8} wrap>
        {mayResolve(access, order) ? (
          <Button autoInsertSpace={false} loading={resolveBusy} onClick={() => startResolve(order)}>
            {t.resolveEntry}
          </Button>
        ) : null}
        {mayRefund(access, order) ? (
          <Button
            type="primary"
            danger
            autoInsertSpace={false}
            disabled={refundable <= 0n}
            title={refundable <= 0n ? t.nothingRefundable : undefined}
            onClick={() => startRefund(order, refundable)}
          >
            {t.refundEntry}
          </Button>
        ) : null}
      </Flex>
    );
    // Only contract fields are read one by one: anything else the server sends is never shown.
    body = (
      <Flex vertical gap={16}>
        <Card title={t.basic} extra={actions}>
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
            rowKey={(row) => attemptKeys.get(row) ?? `${row.at}:${row.kind}:${row.result}`}
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
      {notice === undefined ? null : (
        <Alert
          key={notice.id}
          type={notice.type}
          showIcon
          closable
          role={notice.type === 'error' || notice.type === 'warning' ? 'alert' : 'status'}
          message={notice.text}
          onClose={() => setNotice(undefined)}
        />
      )}
      {body}
      {refund.modal}
      {stepUp.modal}
    </Flex>
  );
}
