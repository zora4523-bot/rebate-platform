// Users (design-hifi AdmUsers, AdmUserDetail; 规划/04 §11.1, F1-07): the user list (user.list:
// GET /admin/v1/users page by page, optional risk_state filter, non-sensitive fields only), the
// lookup by UID or full phone number (user.lookup: GET /admin/v1/users/lookup, exactly one
// parameter) and the detail view. Without user.list the page shows only the lookup and never
// reads the list; without both it shows no permission and sends nothing. The list query and the
// page read last stay in this component, so 【返回】 from a detail shows the same page and filter.
import type { Schema } from '@couli/contracts-ts';
import { SearchOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Button,
  Card,
  Empty,
  Flex,
  Input,
  Result,
  Select,
  Table,
  Tag,
  Typography,
  type TableColumnsType,
  type TablePaginationConfig,
} from 'antd';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { usersTexts as t } from '../../texts/users.ts';
import {
  PAGE_SIZE,
  RISK_STATES,
  beijingTime,
  lookupErrorText,
  lookupQuery,
  riskLabel,
  riskTagColor,
  type RiskState,
  type UserDetail,
  type UserRow,
} from './model.ts';
import { UserDetailView } from './UserDetailView.tsx';

export interface UsersPageProps {
  readonly access: AccessControl;
}

type RiskFilter = RiskState | 'all';

interface ListQuery {
  readonly page: number;
  readonly risk: RiskFilter;
}

type ListStatus = 'loading' | 'ready' | 'failed' | 'forbidden';

interface ListData {
  readonly items: readonly UserRow[];
  readonly total: number;
}

type View =
  | { readonly kind: 'list' }
  | {
      readonly kind: 'detail';
      readonly userId: string;
      readonly initial?: UserDetail | undefined;
      /** Distinguishes two openings of the same user (each starts afresh). */
      readonly opening: number;
    };

const USERS_URL = '/admin/v1/users';
const LOOKUP_URL = `${USERS_URL}/lookup`;

export function UsersPage({ access }: UsersPageProps): ReactElement {
  const canList = access.can('user.list');
  const canLookup = access.can('user.lookup');
  const canReveal = access.can('pii.reveal_phone');
  if (!canList && !canLookup) {
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
  return <UsersContent canList={canList} canLookup={canLookup} canReveal={canReveal} />;
}

interface UsersContentProps {
  readonly canList: boolean;
  readonly canLookup: boolean;
  readonly canReveal: boolean;
}

function UsersContent({ canList, canLookup, canReveal }: UsersContentProps): ReactElement {
  const getProvider = useDataProvider();
  const [query, setQuery] = useState<ListQuery>({ page: 1, risk: 'all' });
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ListStatus>('loading');
  const [data, setData] = useState<ListData>();
  const [view, setView] = useState<View>({ kind: 'list' });
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const [lookupError, setLookupError] = useState<string>();
  const searchingRef = useRef(false);
  const openings = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!canList) return;
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<Schema<'AdminUserPage'>>({
      url: USERS_URL,
      method: 'get',
      query: {
        page: query.page,
        page_size: PAGE_SIZE,
        ...(query.risk === 'all' ? {} : { risk_state: query.risk }),
      },
    }).then(
      (response) => {
        if (!current) return;
        setData({ items: response.data.items, total: response.data.total });
        setStatus('ready');
      },
      (cause: unknown) => {
        if (!current) return;
        setStatus(cause instanceof AdminApiError && cause.code === 10403 ? 'forbidden' : 'failed');
      },
    );
    return () => {
      // A newer query (or leaving the page) drops this answer.
      current = false;
    };
  }, [getProvider, canList, query, attempt]);

  const retry = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  const changeRisk = (risk: RiskFilter) => {
    if (risk === query.risk) return;
    setStatus('loading');
    setQuery({ page: 1, risk });
  };

  const changePage = useCallback(
    (pagination: TablePaginationConfig) => {
      if (pagination.current === undefined || pagination.current === query.page) return;
      setStatus('loading');
      setQuery({ ...query, page: pagination.current });
    },
    [query],
  );

  const open = (userId: string, initial?: UserDetail) => {
    openings.current += 1;
    setView({ kind: 'detail', userId, initial, opening: openings.current });
  };

  const submitLookup = async () => {
    if (searchingRef.current) return;
    const value = search.trim();
    if (value === '') {
      setLookupError(t.lookup.empty);
      return;
    }
    searchingRef.current = true;
    setSearching(true);
    setLookupError(undefined);
    try {
      const custom = getProvider().custom;
      if (custom === undefined) throw new Error('Missing custom data provider');
      const response = await custom<UserDetail>({
        url: LOOKUP_URL,
        method: 'get',
        query: lookupQuery(value),
      });
      if (!alive.current) return;
      open(response.data.user_id, response.data);
    } catch (cause) {
      if (!alive.current) return;
      setLookupError(lookupErrorText(cause));
    } finally {
      searchingRef.current = false;
      if (alive.current) setSearching(false);
    }
  };

  if (view.kind === 'detail') {
    return (
      <UserDetailView
        key={`${view.userId}:${view.opening}`}
        userId={view.userId}
        initial={view.initial}
        canReveal={canReveal}
        onBack={() => setView({ kind: 'list' })}
        onOpenUser={(userId) => open(userId)}
      />
    );
  }

  const columns: TableColumnsType<UserRow> = [
    {
      key: 'uid',
      title: t.columns.uid,
      render: (_, row) => (
        <span style={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{row.user_id}</span>
      ),
    },
    { key: 'nickname', title: t.columns.nickname, dataIndex: 'nickname', ellipsis: true },
    {
      key: 'phone',
      title: t.columns.phone,
      width: 140,
      render: (_, row) => row.phone_masked ?? t.dash,
    },
    { key: 'level', title: t.columns.level, dataIndex: 'level', width: 80 },
    {
      key: 'risk',
      title: t.columns.risk,
      width: 120,
      render: (_, row) => (
        <Tag color={riskTagColor(row.risk_state)}>{riskLabel(row.risk_state)}</Tag>
      ),
    },
    {
      key: 'createdAt',
      title: t.columns.createdAt,
      width: 170,
      render: (_, row) => beijingTime(row.created_at),
    },
    {
      key: 'actions',
      title: t.columns.actions,
      width: 90,
      render: (_, row) => (
        <Button
          type="link"
          size="small"
          style={{ paddingInline: 0 }}
          onClick={() => open(row.user_id)}
        >
          {t.detailAction}
        </Button>
      ),
    },
  ];

  const lookupBox = canLookup ? (
    <Flex vertical gap={6}>
      <Flex align="center" gap={8} wrap>
        <Input
          allowClear
          prefix={<SearchOutlined aria-hidden />}
          aria-label={t.lookup.label}
          placeholder={t.lookup.placeholder}
          value={search}
          status={lookupError === undefined ? '' : 'error'}
          onChange={(event) => setSearch(event.target.value)}
          onPressEnter={() => void submitLookup()}
          style={{ width: 360 }}
        />
        <Button type="primary" loading={searching} onClick={() => void submitLookup()}>
          {t.lookup.submit}
        </Button>
      </Flex>
      {lookupError === undefined ? (
        <Typography.Text type="secondary">{t.lookup.hint}</Typography.Text>
      ) : (
        <Typography.Text type="danger" role="status">
          {lookupError}
        </Typography.Text>
      )}
    </Flex>
  ) : null;

  const filter = canList ? (
    <Select<RiskFilter>
      aria-label={t.riskFilterLabel}
      prefix={t.riskFilterLabel}
      value={query.risk}
      onChange={changeRisk}
      style={{ width: 200 }}
      options={[
        { value: 'all', label: t.riskFilterAll },
        ...RISK_STATES.map((state) => ({ value: state, label: riskLabel(state) })),
      ]}
    />
  ) : null;

  let body: ReactElement | null = null;
  if (!canList) {
    body = null;
  } else if (status === 'forbidden') {
    body = (
      <Card>
        <Result status="403" title={t.forbiddenTitle} subTitle={t.listForbiddenDescription} />
      </Card>
    );
  } else if (status === 'failed') {
    body = (
      <Card>
        <Result
          status="error"
          title={t.loadFailedTitle}
          subTitle={t.loadFailedDescription}
          extra={<Button onClick={retry}>{t.retry}</Button>}
        />
      </Card>
    );
  } else if (data === undefined) {
    body = (
      <Card>
        <Typography.Text type="secondary" role="status">
          {t.loading}
        </Typography.Text>
      </Card>
    );
  } else {
    body = (
      <Card styles={{ body: { padding: 0 } }}>
        <Table<UserRow>
          rowKey="user_id"
          columns={columns}
          dataSource={data.items as UserRow[]}
          loading={status === 'loading'}
          scroll={{ x: 'max-content' }}
          locale={{
            emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t.empty} />,
          }}
          pagination={{
            current: query.page,
            pageSize: PAGE_SIZE,
            total: data.total,
            showSizeChanger: false,
            showTotal: (total) => t.total(total),
            style: { paddingInline: 16 },
          }}
          onChange={changePage}
        />
      </Card>
    );
  }

  return (
    <Flex vertical gap={16}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t.title}
      </Typography.Title>
      <Card>
        <Flex align="flex-start" gap={16} wrap>
          {lookupBox}
          {filter}
        </Flex>
      </Card>
      {body}
    </Flex>
  );
}
