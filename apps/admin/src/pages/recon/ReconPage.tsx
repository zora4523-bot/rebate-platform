// 对账与差错（资源 recon，菜单 资金 / 对账与差错；规格 admin-recon.md，F1-08e 第一段）：「差错单」
// 列表 GET /admin/v1/recon-diffs（只有 R1–R3；类型 / 来源 / 状态 / 周期区间 / 关联单据号筛选，页码
// 分页）、详情抽屉 GET …/{id}、【已关闭（不处理）】POST …/{id}/close（只给 fund.recon，必填原因，
// Idempotency-Key：同一对话框内重试沿用、新开对话框换新键；不走动态码）。持 fund.recon 或
// fund.view 可看；两者都没有时本页说明无权限、不发请求。
// TODO(规划/11 §7): 「对账任务」页签（任务列表、手动触发 R1、月末三项、导出）与工作台计数 — blocked on 契约未出
import { ReloadOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Empty,
  Flex,
  Form,
  Input,
  Result,
  Select,
  Table,
  Tag,
  Typography,
  theme,
  type TableColumnsType,
  type TablePaginationConfig,
} from 'antd';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { Schema } from '@couli/contracts-ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { reconTexts as t } from '../../texts/recon.ts';
import { CloseModal } from './CloseModal.tsx';
import { DetailDrawer, type DetailState } from './DetailDrawer.tsx';
import {
  EMPTY_DRAFT,
  PAGE_SIZE,
  SOURCES,
  STATUSES,
  TYPES,
  checkDraft,
  codeOf,
  isNetwork,
  listQuery,
  money,
  newRequestKey,
  rejectedFields,
  rowOf,
  sourceLabel,
  statusColor,
  statusLabel,
  typeLabel,
  type Draft,
  type DraftErrors,
  type Filters,
  type ReconDiff,
  type ReconDiffDetail,
  type ReconDiffSource,
  type ReconDiffStatus,
  type ReconDiffType,
} from './model.ts';

const LIST_URL = '/admin/v1/recon-diffs';
const itemUrl = (id: string): string => `${LIST_URL}/${encodeURIComponent(id)}`;

type ListStatus = 'loading' | 'ready' | 'failed' | 'forbidden';

interface ListData {
  readonly items: readonly ReconDiff[];
  readonly total: number;
}

type Notice = { readonly type: 'success' | 'error' | 'warning'; readonly text: string };

/** The open drawer: which difference, and a counter so every 【详情】 reads it again. */
interface DrawerTarget {
  readonly id: string;
  readonly read: number;
}

/** One close dialog: its own Idempotency-Key, kept for every retry inside it. */
interface CloseFlow {
  readonly id: string;
  readonly requestKey: string;
  readonly sending: boolean;
  readonly fieldError?: string;
  readonly error?: string;
  readonly canSubmit: boolean;
}

export interface ReconPageProps {
  readonly access: AccessControl;
}

export function ReconPage({ access }: ReconPageProps): ReactElement {
  if (!access.can('fund.recon') && !access.can('fund.view')) {
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
  return <ReconContent canClose={access.can('fund.recon')} />;
}

function ReconContent({ canClose }: { readonly canClose: boolean }): ReactElement {
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const ids = {
    type: useId(),
    source: useId(),
    status: useId(),
    from: useId(),
    to: useId(),
    ref: useId(),
  };
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [draftErrors, setDraftErrors] = useState<DraftErrors>({});
  const [filters, setFilters] = useState<Filters>({});
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ListStatus>('loading');
  const [data, setData] = useState<ListData>();
  const [notice, setNotice] = useState<Notice>();
  const [drawer, setDrawer] = useState<DrawerTarget>();
  const [detail, setDetail] = useState<DetailState>({ status: 'loading' });
  const [flow, setFlowState] = useState<CloseFlow>();
  const flowRef = useRef<CloseFlow | undefined>(undefined);
  const drawerRef = useRef<DrawerTarget | undefined>(undefined);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const setFlow = (next: CloseFlow | undefined) => {
    flowRef.current = next;
    setFlowState(next);
  };
  const openDrawer = (next: DrawerTarget | undefined) => {
    drawerRef.current = next;
    setDrawer(next);
    // Never a flash of the previous difference while this one is read.
    if (next !== undefined) setDetail({ status: 'loading' });
  };

  const customOf = () => {
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    return custom;
  };

  // The list: page `page` under the applied `filters`; `attempt` reads the same again.
  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<Schema<'AdminReconDiffPage'>>({
      url: LIST_URL,
      method: 'get',
      query: listQuery(filters, page),
    }).then(
      (response) => {
        if (!current) return;
        setData({ items: response.data.items, total: response.data.total });
        setStatus('ready');
      },
      (cause: unknown) => {
        if (!current) return;
        // A failed read never keeps the rows of an earlier answer on screen.
        setData(undefined);
        setStatus(codeOf(cause) === 10403 ? 'forbidden' : 'failed');
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, filters, page, attempt]);

  // The drawer's difference, read on every 【详情】 and after a 20902.
  useEffect(() => {
    if (drawer === undefined) return;
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<ReconDiffDetail>({ url: itemUrl(drawer.id), method: 'get' }).then(
      (response) => {
        if (current) setDetail({ status: 'ready', data: response.data });
      },
      (cause: unknown) => {
        if (current) setDetail({ status: codeOf(cause) === 20001 ? 'missing' : 'failed' });
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, drawer]);

  const reload = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  const readDetailAgain = () => {
    const target = drawerRef.current;
    if (target !== undefined) openDrawer({ id: target.id, read: target.read + 1 });
  };

  const runQuery = () => {
    const checked = checkDraft(draft);
    if ('errors' in checked) {
      setDraftErrors(checked.errors);
      return;
    }
    setDraftErrors({});
    setFilters(checked.filters);
    setPage(1);
    reload();
  };

  const reset = () => {
    setDraft(EMPTY_DRAFT);
    setDraftErrors({});
    setFilters({});
    setPage(1);
    reload();
  };

  const changePage = (pagination: TablePaginationConfig) => {
    if (pagination.current === undefined || pagination.current === page) return;
    setStatus('loading');
    setPage(pagination.current);
  };

  const showDetail = (id: string) => {
    const previous = drawerRef.current;
    openDrawer({ id, read: (previous?.read ?? 0) + 1 });
  };

  /** Puts a difference as the server now has it into the list and the open drawer. */
  const applyItem = (item: ReconDiffDetail) => {
    const row = rowOf(item);
    setData((previous) =>
      previous === undefined
        ? previous
        : {
            ...previous,
            items: previous.items.map((entry) =>
              entry.recon_diff_id === row.recon_diff_id ? row : entry,
            ),
          },
    );
    if (drawerRef.current?.id === item.recon_diff_id) setDetail({ status: 'ready', data: item });
  };

  const startClose = (item: ReconDiffDetail) => {
    if (!canClose || flowRef.current !== undefined) return;
    setNotice(undefined);
    // A new dialog is a new close: a new Idempotency-Key (kept for every retry inside it).
    setFlow({
      id: item.recon_diff_id,
      requestKey: newRequestKey(),
      sending: false,
      canSubmit: true,
    });
  };

  const cancelClose = () => {
    if (flowRef.current?.sending === true) return;
    setFlow(undefined);
  };

  const submitClose = async (reason: string) => {
    const current = flowRef.current;
    if (current === undefined || current.sending || !current.canSubmit) return;
    setFlow({ id: current.id, requestKey: current.requestKey, sending: true, canSubmit: true });
    const payload: Schema<'AdminReconDiffCloseRequest'> = { reason };
    try {
      const response = await customOf()<Schema<'AdminReconDiffClose'>>({
        url: `${itemUrl(current.id)}/close`,
        method: 'post',
        payload,
        meta: { idempotencyKey: current.requestKey },
      });
      if (!alive.current) return;
      setFlow(undefined);
      applyItem(response.data.recon_diff);
      setNotice({ type: 'success', text: t.close.done(response.data.released_hold_count) });
    } catch (cause) {
      if (!alive.current) return;
      const keep = (patch: Partial<CloseFlow>) =>
        setFlow({
          id: current.id,
          requestKey: current.requestKey,
          sending: false,
          canSubmit: true,
          ...patch,
        });
      const code = codeOf(cause);
      const fields = rejectedFields(cause);
      if (code === 20001 && fields.includes('reason')) {
        keep({ fieldError: t.close.rejected });
      } else if (code === 20001) {
        // Unknown or no longer visible: the list is read again.
        setFlow(undefined);
        setNotice({ type: 'error', text: t.close.missing });
        reload();
        readDetailAgain();
      } else if (code === 20902) {
        // Handled meanwhile (closed / adjusted / written off): nothing changed; read it again.
        setFlow(undefined);
        setNotice({ type: 'warning', text: t.close.conflict });
        reload();
        readDetailAgain();
      } else if (code === 20901) {
        // The same key with another body: never resent from this dialog.
        keep({ error: t.close.changed, canSubmit: false });
      } else if (code === 40901) {
        keep({ error: t.close.running });
      } else if (code === 10403) {
        keep({ error: t.close.forbidden, canSubmit: false });
      } else if (isNetwork(cause)) {
        // Not known whether it was closed: a retry here resends the same key and body.
        keep({ error: t.close.network });
      } else {
        keep({ error: t.close.failed });
      }
    }
  };

  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const secondary = { fontSize: token.fontSizeSM, color: token.colorTextSecondary } as const;
  const amount = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;

  const columns: TableColumnsType<ReconDiff> = [
    {
      key: 'id',
      title: t.columns.id,
      width: 150,
      render: (_, row) => (
        <span style={{ ...code, fontSize: token.fontSizeSM }}>{row.recon_diff_id}</span>
      ),
    },
    { key: 'type', title: t.columns.type, render: (_, row) => typeLabel(row.type) },
    {
      key: 'source',
      title: t.columns.source,
      render: (_, row) => <span style={{ whiteSpace: 'nowrap' }}>{sourceLabel(row.source)}</span>,
    },
    {
      key: 'period',
      title: t.columns.period,
      render: (_, row) => <span style={{ whiteSpace: 'nowrap' }}>{row.period}</span>,
    },
    {
      key: 'ref',
      title: t.columns.ref,
      render: (_, row) => (
        <Flex vertical gap={2}>
          <span style={secondary}>{row.ref_type}</span>
          <span style={code}>{row.ref_id}</span>
        </Flex>
      ),
    },
    {
      key: 'expected',
      title: t.columns.expected,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.expected_fen)}</span>,
    },
    {
      key: 'actual',
      title: t.columns.actual,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.actual_fen)}</span>,
    },
    {
      key: 'diff',
      title: t.columns.diff,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.diff_fen)}</span>,
    },
    {
      key: 'status',
      title: t.columns.status,
      render: (_, row) => (
        <Tag color={statusColor(row.status)} style={{ marginInlineEnd: 0 }}>
          {statusLabel(row.status)}
        </Tag>
      ),
    },
    {
      key: 'actions',
      title: t.columns.actions,
      width: 80,
      render: (_, row) => (
        <Button size="small" onClick={() => showDetail(row.recon_diff_id)}>
          {t.detailEntry}
        </Button>
      ),
    },
  ];

  const loadingLine =
    status === 'loading' ? (
      <Flex
        align="center"
        gap={8}
        style={{ padding: '12px 16px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}
      >
        <Typography.Text type="secondary" role="status">
          {t.loading}
        </Typography.Text>
      </Flex>
    ) : null;

  let body: ReactElement;
  if (status === 'forbidden') {
    body = (
      <Card title={t.listTitle}>
        <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
      </Card>
    );
  } else if (status === 'failed') {
    body = (
      <Card title={t.listTitle}>
        <Result
          status="error"
          title={t.loadFailedTitle}
          subTitle={t.loadFailedDescription}
          extra={
            <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={reload}>
              {t.retryLoad}
            </Button>
          }
        />
      </Card>
    );
  } else if (data === undefined) {
    body = (
      <Card title={t.listTitle} styles={{ body: { padding: 0 } }}>
        {loadingLine}
      </Card>
    );
  } else {
    body = (
      <Card title={t.listTitle} styles={{ body: { padding: 0 } }}>
        {loadingLine}
        <Table<ReconDiff>
          rowKey="recon_diff_id"
          columns={columns}
          dataSource={data.items as ReconDiff[]}
          loading={status === 'loading'}
          scroll={{ x: 'max-content' }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <Flex vertical align="center" gap={4}>
                    <Typography.Text strong>{t.empty}</Typography.Text>
                    <Typography.Text type="secondary">{t.emptyHint}</Typography.Text>
                  </Flex>
                }
              />
            ),
          }}
          pagination={{
            current: page,
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

  const periodItem = (which: 'from' | 'to') => {
    const error = which === 'from' ? draftErrors.periodFrom : draftErrors.periodTo;
    const field = which === 'from' ? 'periodFrom' : 'periodTo';
    return (
      <Form.Item
        label={which === 'from' ? t.filter.periodFrom : t.filter.periodTo}
        htmlFor={which === 'from' ? ids.from : ids.to}
        validateStatus={error === undefined ? '' : 'error'}
        help={error}
        style={{ marginBottom: 0 }}
      >
        <Input
          id={which === 'from' ? ids.from : ids.to}
          value={draft[field]}
          placeholder={t.filter.periodPlaceholder}
          aria-invalid={error === undefined ? undefined : true}
          style={{ width: 180 }}
          onChange={(event) => {
            const value = event.target.value;
            setDraft((previous) => ({ ...previous, [field]: value }));
          }}
        />
      </Form.Item>
    );
  };

  return (
    <Flex vertical gap={16}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t.title}
      </Typography.Title>
      <Typography.Text type="secondary">{t.runsPending}</Typography.Text>
      <Alert type="info" showIcon role="note" message={t.r4Notice} />
      {notice === undefined ? null : (
        <Alert
          type={notice.type}
          showIcon
          closable
          message={notice.text}
          onClose={() => setNotice(undefined)}
        />
      )}
      <Card>
        <Form layout="vertical" component="div">
          <Flex wrap gap={16} align="flex-end">
            <Form.Item label={t.filter.type} htmlFor={ids.type} style={{ marginBottom: 0 }}>
              <Select<ReconDiffType>
                id={ids.type}
                value={draft.type ?? null}
                allowClear
                virtual={false}
                placeholder={t.filter.all}
                style={{ width: 180 }}
                options={TYPES.map((item) => ({ value: item, label: typeLabel(item) }))}
                onChange={(value: ReconDiffType | undefined) =>
                  setDraft((previous) => ({ ...previous, type: value ?? undefined }))
                }
              />
            </Form.Item>
            <Form.Item label={t.filter.source} htmlFor={ids.source} style={{ marginBottom: 0 }}>
              <Select<ReconDiffSource>
                id={ids.source}
                value={draft.source ?? null}
                allowClear
                virtual={false}
                placeholder={t.filter.all}
                style={{ width: 140 }}
                options={SOURCES.map((item) => ({ value: item, label: sourceLabel(item) }))}
                onChange={(value: ReconDiffSource | undefined) =>
                  setDraft((previous) => ({ ...previous, source: value ?? undefined }))
                }
              />
            </Form.Item>
            <Form.Item label={t.filter.status} htmlFor={ids.status} style={{ marginBottom: 0 }}>
              <Select<ReconDiffStatus>
                id={ids.status}
                value={draft.status ?? null}
                allowClear
                virtual={false}
                placeholder={t.filter.all}
                style={{ width: 160 }}
                options={STATUSES.map((item) => ({ value: item, label: statusLabel(item) }))}
                onChange={(value: ReconDiffStatus | undefined) =>
                  setDraft((previous) => ({ ...previous, status: value ?? undefined }))
                }
              />
            </Form.Item>
            {periodItem('from')}
            {periodItem('to')}
            <Form.Item label={t.filter.ref} htmlFor={ids.ref} style={{ marginBottom: 0 }}>
              <Input
                id={ids.ref}
                value={draft.refId}
                maxLength={64}
                placeholder={t.filter.refPlaceholder}
                style={{ width: 200 }}
                onChange={(event) => {
                  const value = event.target.value;
                  setDraft((previous) => ({ ...previous, refId: value }));
                }}
              />
            </Form.Item>
            <Flex gap={8}>
              <Button onClick={reset}>{t.filter.reset}</Button>
              <Button type="primary" onClick={runQuery}>
                {t.filter.query}
              </Button>
            </Flex>
          </Flex>
        </Form>
      </Card>
      <Alert type="info" role="note" message={t.amountNotice} />
      {body}
      <DetailDrawer
        open={drawer !== undefined}
        state={detail}
        canClose={canClose}
        closing={flow !== undefined}
        onClose={() => openDrawer(undefined)}
        onRetry={readDetailAgain}
        onCloseDiff={startClose}
      />
      {flow === undefined ? null : (
        <CloseModal
          key={flow.requestKey}
          reconDiffId={flow.id}
          sending={flow.sending}
          fieldError={flow.fieldError}
          error={flow.error}
          canSubmit={flow.canSubmit}
          onCancel={cancelClose}
          onSubmit={(reason) => void submitClose(reason)}
        />
      )}
    </Flex>
  );
}
