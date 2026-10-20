// Claim review list (design-hifi AdmClaims, AdmClaimsStates; design/specs/admin-claims.md §2;
// 01 F-ADM-06, F1-07f): filters (platform, evidence level, order / claim number, user) applied
// with 【查询】, one tab per claim_status with the server's count, the contract's columns in the
// server's order (auto_matched first) and server-side pages. Everything is read through the data
// provider (GET /admin/v1/claims); the statistic cards and 【一键通过】 of the board are not built
// this release. The applied conditions come from the address (`?status=` deep links, 【返回】
// from a claim) and travel to the review page, so 【返回】 restores them.
import { InboxOutlined, ReloadOutlined, SearchOutlined, WarningOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfigProvider,
  Empty,
  Flex,
  Form,
  Input,
  Result,
  Select,
  Skeleton,
  Table,
  Tabs,
  Tag,
  Typography,
  theme,
  type TableColumnsType,
  type TablePaginationConfig,
  type ThemeConfig,
} from 'antd';
import { useEffect, useId, useState, type ReactElement } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { claimsTexts as t } from '../../texts/claims.ts';
import {
  CLAIMS_URL,
  EVIDENCE_LEVELS,
  PAGE_SIZE,
  PLATFORMS,
  QUERY_MAX,
  STATUSES,
  awaitsReview,
  beijingTime,
  evidenceLabel,
  evidenceTone,
  failureOf,
  platformLabel,
  queryFromSearch,
  requestQuery,
  searchOf,
  statusLabel,
  statusTone,
  type ClaimPage,
  type ClaimQuery,
  type ClaimRow,
  type ClaimStatus,
  type EvidenceLevel,
  type PlatformCode,
} from './model.ts';

export interface ClaimsPageProps {
  readonly access: AccessControl;
}

/** Router state handed to the review page: the list address 【返回】 goes back to. */
export interface ClaimsBackState {
  readonly claimsSearch: string;
}

type ListStatus = 'loading' | 'ready' | 'failed' | 'invalid' | 'forbidden';

interface Draft {
  readonly platform: PlatformCode | undefined;
  readonly evidence: EvidenceLevel | undefined;
  readonly q: string;
  readonly userId: string;
}

const ALL = 'all';

// Filter card (AdmClaims): 36 high controls, small labels above them.
const FILTER_THEME: ThemeConfig = {
  components: {
    Input: { controlHeight: 36 },
    Select: { controlHeight: 36 },
    Button: { controlHeight: 36 },
    Form: { labelFontSize: 12, verticalLabelPadding: '0 0 4px' },
  },
};

function draftOf(query: ClaimQuery): Draft {
  return {
    platform: query.platform,
    evidence: query.evidence,
    q: query.q ?? '',
    userId: query.userId ?? '',
  };
}

function blank(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function ClaimsPage({ access }: ClaimsPageProps): ReactElement {
  if (!access.can('order.claim')) {
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
  return <ClaimsList />;
}

function ClaimsList(): ReactElement {
  const getProvider = useDataProvider();
  const navigate = useNavigate();
  const location = useLocation();
  const { token } = theme.useToken();
  const platformId = useId();
  const evidenceId = useId();
  const queryId = useId();
  const userId = useId();
  const [query, setQuery] = useState<ClaimQuery>(() => queryFromSearch(location.search));
  const [draft, setDraft] = useState<Draft>(() => draftOf(query));
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ListStatus>('loading');
  const [data, setData] = useState<ClaimPage>();

  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<ClaimPage>({ url: CLAIMS_URL, method: 'get', query: requestQuery(query) }).then(
      (response) => {
        if (!current) return;
        setData(response.data);
        setStatus('ready');
      },
      (cause: unknown) => {
        if (!current) return;
        const kind = failureOf(cause);
        if (kind === 'forbidden') {
          // No old rows or counts stay on screen without the permission.
          setData(undefined);
          setStatus('forbidden');
        } else {
          setStatus(kind === 'invalid' ? 'invalid' : 'failed');
        }
      },
    );
    return () => {
      // A newer query (or leaving the page) drops this answer.
      current = false;
    };
  }, [getProvider, query, attempt]);

  const load = (next: ClaimQuery) => {
    setStatus('loading');
    setQuery(next);
  };

  const retry = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  const submit = () => {
    // A fresh query object: 【查询】 reads again even when nothing changed.
    load({
      page: 1,
      status: query.status,
      platform: draft.platform,
      evidence: draft.evidence,
      q: blank(draft.q)?.replace(/\s/g, ''),
      userId: blank(draft.userId),
    });
  };

  const reset = () => {
    setDraft(draftOf({ page: 1 }));
    load({ page: 1, status: query.status });
  };

  const changeTab = (key: string) => {
    const next = STATUSES.find((candidate) => candidate === key);
    if (next === query.status) return;
    load({ ...query, page: 1, status: next });
  };

  const changePage = (pagination: TablePaginationConfig) => {
    if (pagination.current === undefined || pagination.current === query.page) return;
    load({ ...query, page: pagination.current });
  };

  const open = (claimId: string) => {
    const state: ClaimsBackState = { claimsSearch: searchOf(query) };
    void navigate(`/claims/${encodeURIComponent(claimId)}`, { state });
  };

  const code = { fontFamily: token.fontFamilyCode, fontSize: token.fontSizeSM } as const;
  const secondary = { color: token.colorTextSecondary, fontSize: token.fontSizeSM } as const;

  const columns: TableColumnsType<ClaimRow> = [
    {
      key: 'claimId',
      title: t.columns.claimId,
      width: 150,
      // A claim's display number is its claim_id (a uuid): wrapped so every column fits.
      render: (_, row) => <span style={{ ...code, wordBreak: 'break-all' }}>{row.claim_id}</span>,
    },
    {
      key: 'orderNo',
      title: t.columns.orderNo,
      render: (_, row) => <span style={{ ...code, whiteSpace: 'nowrap' }}>{row.order_no}</span>,
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
      key: 'user',
      title: t.columns.user,
      width: 150,
      render: (_, row) => (
        <Flex vertical gap={2}>
          <span style={{ ...code, wordBreak: 'break-all' }}>{row.user.user_id}</span>
          <span style={{ ...code, ...secondary }}>{row.user.phone_masked ?? t.dash}</span>
        </Flex>
      ),
    },
    {
      key: 'paidDate',
      title: t.columns.paidDate,
      render: (_, row) => <span style={{ whiteSpace: 'nowrap' }}>{row.paid_date}</span>,
    },
    {
      key: 'submittedAt',
      title: t.columns.submittedAt,
      render: (_, row) => (
        <span style={{ whiteSpace: 'nowrap' }}>{beijingTime(row.submitted_at)}</span>
      ),
    },
    {
      key: 'evidence',
      title: t.columns.evidence,
      render: (_, row) => (
        <Tag color={evidenceTone(row.evidence_level)} style={{ marginInlineEnd: 0 }}>
          {`${evidenceLabel(row.evidence_level)} ${row.evidence_level}`}
        </Tag>
      ),
    },
    {
      key: 'status',
      title: t.columns.status,
      render: (_, row) => (
        <Tag color={statusTone(row.status)} style={{ marginInlineEnd: 0 }}>
          {statusLabel(row.status)}
        </Tag>
      ),
    },
    {
      key: 'actions',
      title: t.columns.actions,
      render: (_, row) => {
        const review = awaitsReview(row.status);
        return (
          <Button
            type="link"
            size="small"
            aria-label={review ? t.reviewActionName(row.claim_id) : t.viewActionName(row.claim_id)}
            style={{ paddingInline: 0 }}
            onClick={() => open(row.claim_id)}
          >
            {review ? t.reviewAction : t.viewAction}
          </Button>
        );
      },
    },
  ];

  const counts = data?.counts;
  const tabItems = [
    ...STATUSES.map((value: ClaimStatus) => {
      const count = counts?.[value] ?? 0;
      return {
        key: value,
        label: (
          <Flex align="center" gap={6}>
            {statusLabel(value)}
            {count > 0 ? (
              <Badge
                count={count}
                overflowCount={Number.MAX_SAFE_INTEGER}
                color={token.colorFillSecondary}
                style={{ color: token.colorTextSecondary, boxShadow: 'none' }}
              />
            ) : null}
          </Flex>
        ),
      };
    }),
    { key: ALL, label: t.tabAll },
  ];
  const tabName = query.status === undefined ? t.tabAll : statusLabel(query.status);

  const conditions = [
    query.platform === undefined
      ? undefined
      : t.condition(t.filters.platform, platformLabel(query.platform)),
    query.evidence === undefined
      ? undefined
      : t.condition(t.filters.evidence, evidenceLabel(query.evidence)),
    query.q === undefined ? undefined : t.condition(t.filters.query, query.q),
    query.userId === undefined ? undefined : t.condition(t.filters.user, query.userId),
  ].filter((value): value is string => value !== undefined);

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
              <Typography.Text type="secondary">
                {t.emptyConditions(
                  conditions.length === 0 ? t.dash : conditions.join(t.conditionSeparator),
                  tabName,
                )}
              </Typography.Text>
            </Flex>
          }
        >
          <Button onClick={reset}>{t.resetConditions}</Button>
        </Empty>
      </div>
    );
  } else {
    body = (
      <Table<ClaimRow>
        rowKey="claim_id"
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

  return (
    <Flex vertical gap={16}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t.title}
      </Typography.Title>
      <Card>
        <ConfigProvider theme={FILTER_THEME}>
          <Form layout="vertical" component="div">
            <Flex align="flex-end" gap={16} wrap>
              <Form.Item
                label={t.filters.platform}
                htmlFor={platformId}
                style={{ marginBottom: 0, width: 200 }}
              >
                <Select<string | undefined>
                  id={platformId}
                  value={draft.platform}
                  placeholder={<Typography.Text>{t.filters.platformAll}</Typography.Text>}
                  onChange={(value) =>
                    setDraft({ ...draft, platform: PLATFORMS.find((code) => code === value) })
                  }
                  options={[
                    { value: ALL, label: t.filters.platformAll },
                    ...PLATFORMS.map((value) => ({ value, label: platformLabel(value) })),
                  ]}
                />
              </Form.Item>
              <Form.Item
                label={t.filters.evidence}
                htmlFor={evidenceId}
                style={{ marginBottom: 0, width: 200 }}
              >
                <Select<string | undefined>
                  id={evidenceId}
                  value={draft.evidence}
                  placeholder={<Typography.Text>{t.filters.evidenceAll}</Typography.Text>}
                  onChange={(value) =>
                    setDraft({
                      ...draft,
                      evidence: EVIDENCE_LEVELS.find((level) => level === value),
                    })
                  }
                  options={[
                    { value: ALL, label: t.filters.evidenceAll },
                    ...EVIDENCE_LEVELS.map((value) => ({
                      value,
                      label: `${evidenceLabel(value)} ${value}`,
                    })),
                  ]}
                />
              </Form.Item>
              <Form.Item
                label={t.filters.query}
                htmlFor={queryId}
                style={{ marginBottom: 0, width: 240 }}
              >
                <Input
                  id={queryId}
                  allowClear
                  maxLength={QUERY_MAX}
                  placeholder={t.filters.queryPlaceholder}
                  value={draft.q}
                  onChange={(event) => setDraft({ ...draft, q: event.target.value })}
                  onPressEnter={submit}
                />
              </Form.Item>
              <Form.Item
                label={t.filters.user}
                htmlFor={userId}
                style={{ marginBottom: 0, width: 240 }}
              >
                <Input
                  id={userId}
                  allowClear
                  placeholder={t.filters.userPlaceholder}
                  value={draft.userId}
                  onChange={(event) => setDraft({ ...draft, userId: event.target.value })}
                  onPressEnter={submit}
                />
              </Form.Item>
              <Flex gap={12}>
                <Button type="primary" icon={<SearchOutlined aria-hidden />} onClick={submit}>
                  {t.filters.submit}
                </Button>
                <Button onClick={reset}>{t.filters.reset}</Button>
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
        <Card styles={{ body: { paddingTop: 8 } }}>
          <Tabs
            activeKey={query.status ?? ALL}
            items={tabItems}
            onChange={changeTab}
            style={{ marginBottom: 8 }}
          />
          <Flex vertical gap={12}>
            <Alert type="info" showIcon message={t.autoMatchedNote} />
            {body}
          </Flex>
        </Card>
      )}
    </Flex>
  );
}
