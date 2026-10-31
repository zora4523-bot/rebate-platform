// Tabs of the user detail (design-hifi AdmUserDetail; design/specs/admin-user-detail.md §1–§5,
// F1-07jb): 「概览」 (the existing detail) first, then by permission the read-only lists 「订单」
// (adminListOrders), 「找回」 (adminListClaims) and 「提现」 (listAdminWithdrawals), each read with
// this user's user_id only when its tab is opened. A tab the account may not read is left out.
// Rows open the existing order / claim / withdrawal detail pages; nothing here writes.
import { Button, Tabs, Tag, Typography, theme, type TableColumnsType } from 'antd';
import { useState, type ReactElement, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { AccessControl } from '../../../providers/access-control/index.ts';
import { usersTexts } from '../../../texts/users.ts';
import type { ClaimRow } from '../../claims/model.ts';
import { evidenceText } from '../../claims/model.ts';
import type { OrderRow } from '../../orders/model.ts';
import type { WithdrawalRow } from '../../withdrawals/model.ts';
import { detailRoute, reviewModeLabel } from '../../withdrawals/model.ts';
import { beijingTime, platformLabel } from '../model.ts';
import { TabList } from './TabList.tsx';
import { adminMoney, canOpen, dictLabel, type ListKey, type TabKey } from './model.ts';

const t = usersTexts.tabs;
const ORDER_LIST_URL = '/admin/v1/orders';
const CLAIM_LIST_URL = '/admin/v1/claims';
const WITHDRAWAL_LIST_URL = '/admin/v1/withdrawals';

export interface UserTabsProps {
  readonly userId: string;
  readonly access: AccessControl;
  /** Content of 「概览」 (the existing detail cards). */
  readonly overview: ReactNode;
}

export function UserTabs({ userId, access, overview }: UserTabsProps): ReactElement {
  const [active, setActive] = useState<TabKey>('overview');
  // A list tab mounts (and reads) the first time it is opened, then stays as it was.
  const [opened, setOpened] = useState<ReadonlySet<ListKey>>(() => new Set());

  const select = (key: string) => {
    const next = key as TabKey;
    setActive(next);
    if (next !== 'overview' && !opened.has(next)) setOpened(new Set([...opened, next]));
  };

  const listTab = (key: ListKey, label: string, content: () => ReactNode) =>
    canOpen(access, key) ? [{ key, label, children: opened.has(key) ? content() : null }] : [];

  const items = [
    { key: 'overview', label: t.overview, children: overview },
    ...listTab('tabOrderList', t.orderTab, () => (
      <OrderTab userId={userId} canOpenRow={access.can('order.view')} />
    )),
    ...listTab('claimList', t.claimTab, () => (
      <ClaimTab userId={userId} canOpenRow={access.can('order.claim')} />
    )),
    ...listTab('withdrawalList', t.withdrawalTab, () => <WithdrawalTab userId={userId} />),
  ];

  return <Tabs activeKey={active} onChange={select} items={items} />;
}

interface ListTabProps {
  readonly userId: string;
  readonly canOpenRow: boolean;
}

function useCode() {
  const { token } = theme.useToken();
  return { fontFamily: token.fontFamilyCode, whiteSpace: 'nowrap' } as const;
}

function OpenButton({ no, onClick }: { no: string; onClick: () => void }): ReactElement {
  return (
    <Button type="link" size="small" aria-label={t.openName(no)} onClick={onClick}>
      {t.open}
    </Button>
  );
}

function OrderTab({ userId, canOpenRow }: ListTabProps): ReactElement {
  const navigate = useNavigate();
  const code = useCode();
  const c = t.orderList.columns;
  const nowrap = { whiteSpace: 'nowrap' } as const;
  const columns: TableColumnsType<OrderRow> = [
    {
      key: 'orderNo',
      title: c.orderNo,
      render: (_, row) => <span style={code}>{row.sub_order_id}</span>,
    },
    {
      key: 'platform',
      title: c.platform,
      render: (_, row) => (
        <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
          {platformLabel(row.platform)}
        </Tag>
      ),
    },
    {
      key: 'product',
      title: c.product,
      width: 200,
      render: (_, row) => (
        <Typography.Text ellipsis={{ tooltip: row.title ?? undefined }} style={{ maxWidth: 200 }}>
          {row.title ?? usersTexts.dash}
        </Typography.Text>
      ),
    },
    {
      key: 'paidAt',
      title: c.paidAt,
      render: (_, row) => <span style={nowrap}>{beijingTime(row.paid_at)}</span>,
    },
    {
      key: 'payAmount',
      title: c.payAmount,
      align: 'right',
      render: (_, row) => <span style={nowrap}>{adminMoney(row.pay_amount_fen)}</span>,
    },
    {
      key: 'estCommission',
      title: c.estCommission,
      align: 'right',
      render: (_, row) => <span style={nowrap}>{adminMoney(row.est_commission_fen)}</span>,
    },
    {
      key: 'platformStatus',
      title: c.platformStatus,
      render: (_, row) => <Tag>{dictLabel('platform_status', row.platform_status)}</Tag>,
    },
    {
      key: 'rebateStatus',
      title: c.rebateStatus,
      render: (_, row) => <Tag>{dictLabel('rebate_status', row.rebate_status)}</Tag>,
    },
    ...(canOpenRow
      ? [
          {
            key: 'actions',
            title: c.actions,
            render: (_: unknown, row: OrderRow) => (
              <OpenButton
                no={row.sub_order_id}
                onClick={() => void navigate(`/orders/${encodeURIComponent(row.order_id)}`)}
              />
            ),
          },
        ]
      : []),
  ];
  return (
    <TabList<OrderRow>
      url={ORDER_LIST_URL}
      userId={userId}
      copy={t.orderList}
      columns={columns}
      rowKey={(row) => row.order_id}
    />
  );
}

function ClaimTab({ userId, canOpenRow }: ListTabProps): ReactElement {
  const navigate = useNavigate();
  const code = useCode();
  const c = t.claimList.columns;
  const columns: TableColumnsType<ClaimRow> = [
    {
      key: 'claimNo',
      title: c.claimNo,
      render: (_, row) => <span style={code}>{row.claim_id}</span>,
    },
    {
      key: 'orderNo',
      title: c.orderNo,
      render: (_, row) => <span style={code}>{row.order_no}</span>,
    },
    {
      key: 'platform',
      title: c.platform,
      render: (_, row) => (
        <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
          {platformLabel(row.platform)}
        </Tag>
      ),
    },
    { key: 'paidDate', title: c.paidDate, render: (_, row) => row.paid_date },
    {
      key: 'submittedAt',
      title: c.submittedAt,
      render: (_, row) => (
        <span style={{ whiteSpace: 'nowrap' }}>{beijingTime(row.submitted_at)}</span>
      ),
    },
    { key: 'evidence', title: c.evidence, render: (_, row) => evidenceText(row.evidence_level) },
    {
      key: 'status',
      title: c.status,
      render: (_, row) => <Tag>{dictLabel('claim_status', row.status)}</Tag>,
    },
    ...(canOpenRow
      ? [
          {
            key: 'actions',
            title: c.actions,
            render: (_: unknown, row: ClaimRow) => (
              <OpenButton
                no={row.claim_id}
                onClick={() => void navigate(`/claims/${encodeURIComponent(row.claim_id)}`)}
              />
            ),
          },
        ]
      : []),
  ];
  return (
    <TabList<ClaimRow>
      url={CLAIM_LIST_URL}
      userId={userId}
      copy={t.claimList}
      columns={columns}
      rowKey={(row) => row.claim_id}
    />
  );
}

function WithdrawalTab({ userId }: { userId: string }): ReactElement {
  const navigate = useNavigate();
  const code = useCode();
  const c = t.withdrawalList.columns;
  const nowrap = { whiteSpace: 'nowrap' } as const;
  const columns: TableColumnsType<WithdrawalRow> = [
    {
      key: 'outBizNo',
      title: c.outBizNo,
      render: (_, row) => <span style={code}>{row.out_biz_no}</span>,
    },
    {
      key: 'createdAt',
      title: c.createdAt,
      render: (_, row) => <span style={nowrap}>{beijingTime(row.created_at)}</span>,
    },
    {
      key: 'amount',
      title: c.amount,
      align: 'right',
      render: (_, row) => <span style={nowrap}>{adminMoney(row.amount_fen)}</span>,
    },
    {
      key: 'reviewMode',
      title: c.reviewMode,
      render: (_, row) =>
        row.review_mode === null ? usersTexts.dash : reviewModeLabel(row.review_mode),
    },
    {
      key: 'reviewedAt',
      title: c.reviewedAt,
      render: (_, row) => <span style={nowrap}>{beijingTime(row.reviewed_at)}</span>,
    },
    {
      key: 'status',
      title: c.status,
      render: (_, row) => <Tag>{dictLabel('withdrawal_status', row.status)}</Tag>,
    },
    {
      key: 'actions',
      title: c.actions,
      render: (_, row) => (
        <OpenButton
          no={row.out_biz_no}
          onClick={() => void navigate(detailRoute(row.withdrawal_id))}
        />
      ),
    },
  ];
  return (
    <TabList<WithdrawalRow>
      url={WITHDRAWAL_LIST_URL}
      userId={userId}
      copy={t.withdrawalList}
      columns={columns}
      rowKey={(row) => row.withdrawal_id}
    />
  );
}
