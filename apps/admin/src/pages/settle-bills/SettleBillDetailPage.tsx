// 月结账单详情（settle-bills/{bill_id}；F1-08d 第一段只读）：GET /admin/v1/settle-bills/{bill_id}
// 的账单状态、账单日统计（只作展示）与结算批次表；每个批次【明细】打开批次明细抽屉。不存在的
// 账单（20001）显示未找到。持 settle.bill 或 fund.view 可看。
// TODO(规划/11 §7): 【确认立即执行】【定时执行】【驳回】【继续执行】【撤销定时】【发起补充批次】与一致性校验结果表 — blocked on 契约未出
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Flex,
  Result,
  Table,
  Tag,
  Typography,
  theme,
  type TableColumnsType,
} from 'antd';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { PlannedPage, usePlanned } from '../../components/planned/index.ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { settleBillsTexts } from '../../texts/settle-bills.ts';
import { BatchItemsDrawer } from './BatchItemsDrawer.tsx';
import { DictName } from './DictName.tsx';
import {
  batchKindLabel,
  batchStatusLabel,
  beijingTime,
  billStatusLabel,
  billUrl,
  codeOf,
  count,
  money,
  platformEntries,
  settleModeLabel,
  type SettleBatch,
  type SettleBillDetail,
} from './model.ts';
import { PlatformValues } from './PlatformValues.tsx';
import { SettleForbidden, canReadSettleBills } from './SettleBillsPage.tsx';

const t = settleBillsTexts.detail;

type DetailState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: SettleBillDetail }
  | { readonly status: 'missing' }
  | { readonly status: 'failed' }
  | { readonly status: 'forbidden' };

/** The open items drawer: which batch, and a counter so every 【明细】 reads it again. */
interface ItemsTarget {
  readonly batch: SettleBatch;
  readonly read: number;
}

export interface SettleBillDetailPageProps {
  readonly access: AccessControl;
  readonly billId: string;
}

export function SettleBillDetailPage({ access, billId }: SettleBillDetailPageProps): ReactElement {
  const planned = usePlanned('getAdminSettleBill');
  if (planned) return <PlannedPage title={settleBillsTexts.title} />;
  if (!canReadSettleBills(access)) return <SettleForbidden />;
  return <DetailContent billId={billId} />;
}

function Stat({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  const { token } = theme.useToken();
  return (
    <Card size="small" style={{ minWidth: 160, flex: '1 1 160px' }}>
      <Flex vertical gap={4}>
        <Typography.Text type="secondary">{label}</Typography.Text>
        <div style={{ fontSize: token.fontSizeLG, fontVariantNumeric: 'tabular-nums' }}>
          {children}
        </div>
      </Flex>
    </Card>
  );
}

function DetailContent({ billId }: { readonly billId: string }): ReactElement {
  const getProvider = useDataProvider();
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DetailState>({ status: 'loading' });
  const [items, setItems] = useState<ItemsTarget>();

  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<SettleBillDetail>({ url: billUrl(billId), method: 'get' }).then(
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
  }, [getProvider, billId, attempt]);

  const retry = () => {
    setState({ status: 'loading' });
    setAttempt((value) => value + 1);
  };

  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const secondary = { fontSize: token.fontSizeSM, color: token.colorTextSecondary } as const;

  const columns: TableColumnsType<SettleBatch> = [
    {
      key: 'id',
      title: t.batchColumns.id,
      width: 150,
      render: (_, row) => (
        <span style={{ ...code, fontSize: token.fontSizeSM }}>{row.batch_id}</span>
      ),
    },
    { key: 'platform', title: t.batchColumns.platform, render: (_, row) => row.platform },
    {
      key: 'kind',
      title: t.batchColumns.kind,
      render: (_, row) => <DictName>{batchKindLabel(row.kind)}</DictName>,
    },
    {
      key: 'orders',
      title: t.batchColumns.orders,
      align: 'right',
      render: (_, row) => row.order_count,
    },
    {
      key: 'status',
      title: t.batchColumns.status,
      render: (_, row) => (
        <Flex vertical gap={2}>
          <Tag style={{ marginInlineEnd: 0, alignSelf: 'flex-start' }}>
            <DictName>{batchStatusLabel(row.status)}</DictName>
          </Tag>
          {row.paused_by_switch_at === null ? null : (
            <span style={secondary}>{t.pausedAt(beijingTime(row.paused_by_switch_at))}</span>
          )}
          {row.cancelled_reason === null ? null : (
            <span style={secondary}>{t.cancelledReason(row.cancelled_reason)}</span>
          )}
        </Flex>
      ),
    },
    {
      key: 'mode',
      title: t.batchColumns.mode,
      render: (_, row) => (
        <Flex vertical gap={2}>
          <span style={{ whiteSpace: 'nowrap' }}>
            <DictName>{settleModeLabel(row.settle_mode)}</DictName>
          </span>
          {row.scheduled_at === null ? null : (
            <span style={{ ...secondary, whiteSpace: 'nowrap' }}>
              {beijingTime(row.scheduled_at)}
            </span>
          )}
        </Flex>
      ),
    },
    {
      key: 'confirmer',
      title: t.batchColumns.confirmer,
      render: (_, row) =>
        row.confirmed_by === null ? (
          settleBillsTexts.dash
        ) : (
          <span style={{ ...code, fontSize: token.fontSizeSM }}>{row.confirmed_by}</span>
        ),
    },
    {
      key: 'confirmedAt',
      title: t.batchColumns.confirmedAt,
      render: (_, row) => (
        <span style={{ whiteSpace: 'nowrap' }}>{beijingTime(row.confirmed_at)}</span>
      ),
    },
    {
      key: 'actions',
      title: t.batchColumns.actions,
      width: 80,
      render: (_, row) => (
        <Button
          size="small"
          onClick={() => setItems((previous) => ({ batch: row, read: (previous?.read ?? 0) + 1 }))}
        >
          {t.itemsEntry}
        </Button>
      ),
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
          title={settleBillsTexts.forbiddenTitle}
          subTitle={settleBillsTexts.forbiddenDescription}
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
                {t.retry}
              </Button>
            )
          }
        />
      </Card>
    );
  } else {
    const bill = state.data;
    body = (
      <Flex vertical gap={16}>
        <Flex wrap gap={16} align="center">
          <Tag style={{ marginInlineEnd: 0 }}>
            <DictName>{billStatusLabel(bill.status)}</DictName>
          </Tag>
          <Typography.Text type="secondary">
            {t.generationStarted} {beijingTime(bill.generation_started_at)}
          </Typography.Text>
          <Typography.Text type="secondary">
            {t.generated} {beijingTime(bill.generated_at)}
          </Typography.Text>
        </Flex>
        <Alert type="info" role="note" message={settleBillsTexts.totalsNotice} />
        <Flex wrap gap={12}>
          <Stat label={t.stats.orders}>
            <PlatformValues
              entries={platformEntries(bill.platform_order_counts)}
              format={(value) => count(value)}
            />
          </Stat>
          <Stat label={t.stats.commission}>
            <PlatformValues
              entries={platformEntries(bill.platform_settle_commission_totals)}
              format={(value) => money(value)}
            />
          </Stat>
          <Stat label={t.stats.beneficiary}>{money(bill.beneficiary_total_fen)}</Stat>
          <Stat label={t.stats.retained}>{money(bill.platform_retained_fen)}</Stat>
          <Stat label={t.stats.errors}>{count(bill.error_count)}</Stat>
          <Stat label={t.stats.held}>{count(bill.held_count)}</Stat>
        </Flex>
        <Card title={t.batchesTitle} styles={{ body: { padding: 0 } }}>
          <Table<SettleBatch>
            rowKey="batch_id"
            columns={columns}
            dataSource={bill.batches as SettleBatch[]}
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: t.batchesEmpty }}
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
          onClick={() => void navigate('/settle-bills')}
        >
          {t.back}
        </Button>
        <Typography.Title level={4} className="admin-page-title" style={{ margin: 0 }}>
          {t.title(billId)}
        </Typography.Title>
      </Flex>
      <Alert type="info" showIcon role="note" message={settleBillsTexts.readOnlyNotice} />
      {body}
      {items === undefined ? null : (
        <BatchItemsDrawer
          key={`${items.batch.batch_id}:${items.read}`}
          batch={items.batch}
          onClose={() => setItems(undefined)}
        />
      )}
    </Flex>
  );
}
