// Order list (design-hifi AdmOrders, AdmOrdersStates; design/specs/admin-orders.md; 01 F-ADM-05,
// F1-07e): filters (platform, platform_status, rebate_status, flag, order number, user, paid
// days in Beijing time) applied with 【查询】, the contract's columns in the server's order
// (paid_at descending) and server-side pages. Everything is read through the data provider
// (GET /admin/v1/orders). Read only: the write buttons of the board (manual sync, sync records,
// rights import, export) come with a later contract and are not rendered. The applied conditions
// live in this component (not the address); they travel to the detail subpage in router state,
// so 【返回】 restores them.
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  InboxOutlined,
  ReloadOutlined,
  SearchOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Button,
  Card,
  ConfigProvider,
  DatePicker,
  Empty,
  Flex,
  Form,
  Input,
  Result,
  Select,
  Skeleton,
  Table,
  Tag,
  Typography,
  theme,
  type TableColumnsType,
  type TablePaginationConfig,
  type ThemeConfig,
} from 'antd';
import dayjs from 'dayjs';
import { useEffect, useId, useState, type CSSProperties, type ReactElement } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { ordersTexts as t } from '../../texts/orders.ts';
import { FlagTags, StatusTag } from './parts.tsx';
import {
  FIRST_PAGE,
  FLAGS,
  ORDERS_URL,
  PAGE_SIZE,
  PLATFORMS,
  PLATFORM_STATUSES,
  QUERY_MAX,
  REBATE_STATUSES,
  backQueryOf,
  beijingClock,
  beijingDate,
  codeLabel,
  failureOf,
  hasConditions,
  money,
  platformLabel,
  requestQuery,
  type OrderFlag,
  type OrderPage,
  type OrderQuery,
  type OrderRow,
  type OrdersBackState,
} from './model.ts';

export interface OrdersPageProps {
  readonly access: AccessControl;
}

type ListStatus = 'loading' | 'ready' | 'failed' | 'invalid' | 'forbidden';

interface Draft {
  readonly platform: string | undefined;
  readonly platformStatus: string | undefined;
  readonly rebateStatus: string | undefined;
  readonly flag: string | undefined;
  readonly q: string;
  readonly userId: string;
  readonly paidFrom: string | undefined;
  readonly paidTo: string | undefined;
}

const ALL = 'all';
const DAY_FORMAT = 'YYYY-MM-DD';

// Filter card (AdmOrders): 36 high controls, small labels above them, four per line.
const FILTER_THEME: ThemeConfig = {
  components: {
    Input: { controlHeight: 36 },
    Select: { controlHeight: 36 },
    DatePicker: { controlHeight: 36 },
    Button: { controlHeight: 36 },
    Form: { labelFontSize: 12, verticalLabelPadding: '0 0 4px' },
  },
};

// Visually hidden label of each date input (the group label stays visible above them).
const HIDDEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
};

const FLAG_LABELS: Readonly<Record<OrderFlag, string>> = {
  locked: t.flags.locked,
  status_locked: t.flags.statusLocked,
  rights_pending: t.flags.rightsPending,
  hold: t.flags.hold,
};

function draftOf(query: OrderQuery): Draft {
  return {
    platform: query.platform,
    platformStatus: query.platformStatus,
    rebateStatus: query.rebateStatus,
    flag: query.flag,
    q: query.q ?? '',
    userId: query.userId ?? '',
    paidFrom: query.paidFrom,
    paidTo: query.paidTo,
  };
}

function blank(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function OrdersPage({ access }: OrdersPageProps): ReactElement {
  if (!access.can('order.view')) {
    return (
      <Flex vertical gap={16}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t.title}
        </Typography.Title>
        <Card>
          <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
        </Card>
      </Flex>
    );
  }
  return <OrdersList />;
}

function OrdersList(): ReactElement {
  const getProvider = useDataProvider();
  const navigate = useNavigate();
  const location = useLocation();
  const { token } = theme.useToken();
  const ids = {
    platform: useId(),
    platformStatus: useId(),
    rebateStatus: useId(),
    flag: useId(),
    q: useId(),
    user: useId(),
    from: useId(),
    to: useId(),
  };
  const [query, setQuery] = useState<OrderQuery>(() => backQueryOf(location.state) ?? FIRST_PAGE);
  const [draft, setDraft] = useState<Draft>(() => draftOf(query));
  const [rangeError, setRangeError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ListStatus>('loading');
  const [data, setData] = useState<OrderPage>();

  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<OrderPage>({ url: ORDERS_URL, method: 'get', query: requestQuery(query) }).then(
      (response) => {
        if (!current) return;
        setData(response.data);
        setStatus('ready');
      },
      (cause: unknown) => {
        if (!current) return;
        // A failed read never leaves the previous rows, amounts or detail entries on screen.
        setData(undefined);
        const kind = failureOf(cause);
        setStatus(kind);
      },
    );
    return () => {
      // A newer query (or leaving the page) drops this answer.
      current = false;
    };
  }, [getProvider, query, attempt]);

  const load = (next: OrderQuery) => {
    setStatus('loading');
    setData(undefined);
    setQuery(next);
  };

  const retry = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  const submit = () => {
    if (
      draft.paidFrom !== undefined &&
      draft.paidTo !== undefined &&
      draft.paidFrom > draft.paidTo
    ) {
      setRangeError(true);
      return;
    }
    setRangeError(false);
    // A fresh query object: 【查询】 reads again even when nothing changed.
    load({
      page: 1,
      platform: PLATFORMS.find((code) => code === draft.platform),
      platformStatus: PLATFORM_STATUSES.find((code) => code === draft.platformStatus),
      rebateStatus: REBATE_STATUSES.find((code) => code === draft.rebateStatus),
      flag: FLAGS.find((code) => code === draft.flag),
      q: blank(draft.q)?.replace(/\s/g, ''),
      userId: blank(draft.userId),
      paidFrom: draft.paidFrom,
      paidTo: draft.paidTo,
    });
  };

  const reset = () => {
    setDraft(draftOf(FIRST_PAGE));
    setRangeError(false);
    load({ page: 1 });
  };

  const changePage = (pagination: TablePaginationConfig) => {
    if (pagination.current === undefined || pagination.current === query.page) return;
    load({ ...query, page: pagination.current });
  };

  const open = (orderId: string) => {
    const state: OrdersBackState = { ordersQuery: query };
    void navigate(`/orders/${encodeURIComponent(orderId)}`, { state });
  };

  const code = { fontFamily: token.fontFamilyCode } as const;
  const secondary = { color: token.colorTextSecondary, fontSize: token.fontSizeSM } as const;
  const nowrap = { whiteSpace: 'nowrap' } as const;

  const columns: TableColumnsType<OrderRow> = [
    {
      key: 'orderNo',
      title: t.columns.orderNo,
      render: (_, row) => (
        <span style={{ ...code, ...nowrap, color: token.colorPrimary }}>{row.sub_order_id}</span>
      ),
    },
    {
      key: 'platform',
      title: t.columns.platform,
      render: (_, row) => (
        <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
          {platformLabel(row.platform)}
        </Tag>
      ),
    },
    {
      key: 'product',
      title: t.columns.product,
      width: 200,
      render: (_, row) => (
        <Typography.Text ellipsis={{ tooltip: row.title ?? undefined }} style={{ maxWidth: 200 }}>
          {row.title ?? t.dash}
        </Typography.Text>
      ),
    },
    {
      key: 'user',
      title: t.columns.user,
      width: 150,
      render: (_, row) =>
        row.user === null ? (
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {t.noUser}
          </Typography.Text>
        ) : (
          <Flex vertical gap={2}>
            <span style={{ ...code, fontSize: token.fontSizeSM, wordBreak: 'break-all' }}>
              {row.user.user_id}
            </span>
            <span style={{ ...code, ...secondary }}>{row.user.phone_masked ?? t.dash}</span>
          </Flex>
        ),
    },
    {
      key: 'paidAt',
      title: t.columns.paidAt,
      render: (_, row) =>
        row.paid_at === null ? (
          t.dash
        ) : (
          <Flex vertical style={nowrap}>
            <span>{beijingDate(row.paid_at)}</span>
            <span>{beijingClock(row.paid_at)}</span>
          </Flex>
        ),
    },
    {
      key: 'payAmount',
      title: t.columns.payAmount,
      align: 'right',
      render: (_, row) => <span style={nowrap}>{money(row.pay_amount_fen)}</span>,
    },
    {
      key: 'commission',
      title: t.columns.commission,
      align: 'right',
      render: (_, row) => (
        <Flex vertical align="flex-end" style={nowrap}>
          <span>{money(row.est_commission_fen)}</span>
          {row.settle_commission_fen === null ? null : (
            <span style={secondary}>{t.settledCommission(money(row.settle_commission_fen))}</span>
          )}
        </Flex>
      ),
    },
    {
      key: 'platformStatus',
      title: t.columns.platformStatus,
      render: (_, row) => <StatusTag kind="platform_status" code={row.platform_status} stacked />,
    },
    {
      key: 'rebateStatus',
      title: t.columns.rebateStatus,
      render: (_, row) => <StatusTag kind="rebate_status" code={row.rebate_status} stacked />,
    },
    {
      key: 'flags',
      title: t.columns.flags,
      render: (_, row) => <FlagTags flags={row.flags} holdReason={row.hold_reason} />,
    },
    {
      key: 'actions',
      title: t.columns.actions,
      fixed: 'right',
      render: (_, row) => (
        <Button
          type="link"
          size="small"
          aria-label={t.detailActionName(row.sub_order_id)}
          style={{ paddingInline: 0 }}
          onClick={() => open(row.order_id)}
        >
          {t.detailAction}
        </Button>
      ),
    },
  ];

  const labels = t.conditionLabels;
  const paidText =
    query.paidFrom === undefined && query.paidTo === undefined
      ? undefined
      : t.range(query.paidFrom ?? t.dash, query.paidTo ?? t.dash);
  const conditions = [
    query.platform === undefined
      ? undefined
      : t.condition(labels.platform, platformLabel(query.platform)),
    query.platformStatus === undefined
      ? undefined
      : t.condition(labels.platformStatus, codeLabel('platform_status', query.platformStatus)),
    query.rebateStatus === undefined
      ? undefined
      : t.condition(labels.rebateStatus, codeLabel('rebate_status', query.rebateStatus)),
    query.flag === undefined ? undefined : t.condition(labels.flag, FLAG_LABELS[query.flag]),
    query.q === undefined ? undefined : t.condition(labels.query, query.q),
    query.userId === undefined ? undefined : t.condition(labels.user, query.userId),
    paidText === undefined ? undefined : t.condition(labels.paidAt, paidText),
  ].filter((value): value is string => value !== undefined);
  const conditionText = conditions.join(t.conditionSeparator);

  const inner = {
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: token.borderRadiusLG,
    overflow: 'hidden',
  } as const;

  const iconCircle = (background: string) =>
    ({
      width: 56,
      height: 56,
      marginInline: 'auto',
      borderRadius: '50%',
      background,
    }) as const;

  let body: ReactElement;
  if (status === 'failed' || status === 'invalid') {
    body = (
      <div style={inner}>
        <Result
          status="warning"
          icon={
            <Flex align="center" justify="center" style={iconCircle(token.colorErrorBg)}>
              <WarningOutlined aria-hidden style={{ fontSize: 24, color: token.colorError }} />
            </Flex>
          }
          title={
            <Typography.Text type="danger" strong style={{ fontSize: token.fontSize }}>
              {t.loadFailedTitle}
            </Typography.Text>
          }
          subTitle={status === 'invalid' ? t.invalidQueryDescription : t.loadFailedDescription}
          extra={
            <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={retry}>
              {t.retry}
            </Button>
          }
        />
      </div>
    );
  } else if (status === 'loading' || data === undefined) {
    body = (
      <div style={inner}>
        <Flex
          align="center"
          gap={8}
          style={{ padding: '12px 16px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}
        >
          <ClockCircleOutlined aria-hidden style={{ color: token.colorTextTertiary }} />
          <Typography.Text type="secondary" role="status">
            {t.loading}
          </Typography.Text>
        </Flex>
        <div style={{ padding: 16 }}>
          <Skeleton active title={false} paragraph={{ rows: 4 }} />
        </div>
      </div>
    );
  } else if (data.items.length === 0) {
    body = (
      <div style={{ ...inner, padding: '40px 24px' }}>
        <Empty
          image={
            <InboxOutlined aria-hidden style={{ fontSize: 28, color: token.colorTextTertiary }} />
          }
          styles={{
            image: {
              height: 56,
              width: 56,
              marginInline: 'auto',
              marginBottom: 16,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: token.colorFillTertiary,
            },
          }}
          description={
            <Flex vertical align="center" gap={8}>
              <Typography.Text strong>{t.empty}</Typography.Text>
              {conditions.length === 0 ? null : (
                <Typography.Text type="secondary">
                  {t.emptyConditions(conditionText)}
                </Typography.Text>
              )}
            </Flex>
          }
        >
          {hasConditions(query) ? <Button onClick={reset}>{t.resetConditions}</Button> : null}
        </Empty>
      </div>
    );
  } else {
    body = (
      <Table<OrderRow>
        rowKey="order_id"
        size="middle"
        columns={columns}
        dataSource={data.items}
        scroll={{ x: 'max-content' }}
        pagination={{
          current: query.page,
          pageSize: PAGE_SIZE,
          total: data.total,
          showSizeChanger: false,
          showTotal: (total) => t.total(total),
        }}
        onChange={changePage}
      />
    );
  }

  // Shown with a settled answer for applied conditions; names them and the server's total.
  const applied =
    status === 'ready' && data !== undefined && conditions.length > 0 ? (
      <Flex align="center" gap={12} wrap aria-live="polite">
        <Tag icon={<CheckCircleOutlined aria-hidden />} style={{ marginInlineEnd: 0 }}>
          {t.applied}
        </Tag>
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          {conditionText}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          {t.total(data.total)}
        </Typography.Text>
      </Flex>
    ) : null;

  const statusOptions = (kind: 'platform_status' | 'rebate_status', codes: readonly string[]) => [
    { value: ALL, label: t.filters.all },
    ...codes.map((value) => ({ value, label: codeLabel(kind, value) })),
  ];
  const pick = (value: string | undefined) => (value === ALL ? undefined : value);
  const cell = { marginBottom: 0, flex: '1 1 220px', minWidth: 200 } as const;

  return (
    <Flex vertical gap={16}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t.title}
      </Typography.Title>
      <Card>
        <ConfigProvider theme={FILTER_THEME}>
          {/* Each Select also carries its label as aria-label: the browser would otherwise read the
              label's generated colon into the accessible name. */}
          <Form layout="vertical" component="div" colon={false}>
            <Flex vertical gap={12}>
              <Flex gap={16} wrap>
                <Form.Item label={t.filters.platform} htmlFor={ids.platform} style={cell}>
                  <Select<string | undefined>
                    id={ids.platform}
                    aria-label={t.filters.platform}
                    value={draft.platform}
                    placeholder={<Typography.Text>{t.filters.platformAll}</Typography.Text>}
                    onChange={(value) => setDraft({ ...draft, platform: pick(value) })}
                    options={[
                      { value: ALL, label: t.filters.platformAll },
                      ...PLATFORMS.map((value) => ({ value, label: platformLabel(value) })),
                    ]}
                  />
                </Form.Item>
                <Form.Item
                  label={t.filters.platformStatus}
                  htmlFor={ids.platformStatus}
                  style={cell}
                >
                  <Select<string | undefined>
                    id={ids.platformStatus}
                    aria-label={t.filters.platformStatus}
                    value={draft.platformStatus}
                    placeholder={<Typography.Text>{t.filters.all}</Typography.Text>}
                    onChange={(value) => setDraft({ ...draft, platformStatus: pick(value) })}
                    options={statusOptions('platform_status', PLATFORM_STATUSES)}
                  />
                </Form.Item>
                <Form.Item label={t.filters.rebateStatus} htmlFor={ids.rebateStatus} style={cell}>
                  <Select<string | undefined>
                    id={ids.rebateStatus}
                    aria-label={t.filters.rebateStatus}
                    value={draft.rebateStatus}
                    placeholder={<Typography.Text>{t.filters.all}</Typography.Text>}
                    onChange={(value) => setDraft({ ...draft, rebateStatus: pick(value) })}
                    options={statusOptions('rebate_status', REBATE_STATUSES)}
                  />
                </Form.Item>
                <Form.Item label={t.filters.query} htmlFor={ids.q} style={cell}>
                  <Input
                    id={ids.q}
                    allowClear
                    maxLength={QUERY_MAX}
                    placeholder={t.filters.queryPlaceholder}
                    value={draft.q}
                    onChange={(event) => setDraft({ ...draft, q: event.target.value })}
                    onPressEnter={submit}
                    style={code}
                  />
                </Form.Item>
              </Flex>
              <Flex gap={16} wrap align="flex-end">
                <Form.Item label={t.filters.user} htmlFor={ids.user} style={cell}>
                  <Input
                    id={ids.user}
                    allowClear
                    placeholder={t.filters.userPlaceholder}
                    value={draft.userId}
                    onChange={(event) => setDraft({ ...draft, userId: event.target.value })}
                    onPressEnter={submit}
                  />
                </Form.Item>
                <Form.Item
                  label={t.filters.paidAt}
                  style={cell}
                  validateStatus={rangeError ? 'error' : ''}
                  {...(rangeError ? { help: t.filters.rangeInvalid } : {})}
                >
                  <Flex gap={8}>
                    <label htmlFor={ids.from} style={HIDDEN}>
                      {t.filters.paidFrom}
                    </label>
                    <DatePicker
                      id={ids.from}
                      format={DAY_FORMAT}
                      placeholder={t.filters.paidFromPlaceholder}
                      value={draft.paidFrom === undefined ? null : dayjs(draft.paidFrom)}
                      onChange={(value) =>
                        setDraft({ ...draft, paidFrom: value?.format(DAY_FORMAT) ?? undefined })
                      }
                      style={{ flex: 1, minWidth: 0 }}
                    />
                    <label htmlFor={ids.to} style={HIDDEN}>
                      {t.filters.paidTo}
                    </label>
                    <DatePicker
                      id={ids.to}
                      format={DAY_FORMAT}
                      placeholder={t.filters.paidToPlaceholder}
                      value={draft.paidTo === undefined ? null : dayjs(draft.paidTo)}
                      onChange={(value) =>
                        setDraft({ ...draft, paidTo: value?.format(DAY_FORMAT) ?? undefined })
                      }
                      style={{ flex: 1, minWidth: 0 }}
                    />
                  </Flex>
                </Form.Item>
                <Form.Item label={t.filters.flag} htmlFor={ids.flag} style={cell}>
                  <Select<string | undefined>
                    id={ids.flag}
                    aria-label={t.filters.flag}
                    value={draft.flag}
                    placeholder={<Typography.Text>{t.filters.all}</Typography.Text>}
                    onChange={(value) => setDraft({ ...draft, flag: pick(value) })}
                    options={[
                      { value: ALL, label: t.filters.all },
                      ...FLAGS.map((value) => ({ value, label: FLAG_LABELS[value] })),
                    ]}
                  />
                </Form.Item>
                <Flex gap={12} style={{ flex: '1 1 220px', minWidth: 200 }}>
                  <Button type="primary" icon={<SearchOutlined aria-hidden />} onClick={submit}>
                    {t.filters.submit}
                  </Button>
                  <Button onClick={reset}>{t.filters.reset}</Button>
                </Flex>
              </Flex>
            </Flex>
          </Form>
        </ConfigProvider>
      </Card>
      {status === 'forbidden' ? (
        <Card>
          <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
        </Card>
      ) : (
        <Card>
          <Flex vertical gap={12}>
            {applied}
            {body}
          </Flex>
        </Card>
      )}
    </Flex>
  );
}
