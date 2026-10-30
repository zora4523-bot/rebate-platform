// 「收款对账」页签：只读 R4 收款差错单 GET /admin/v1/pay-recon-diffs（类型、状态筛选，页码分页）；
// 我方 / 渠道金额与差额照契约原样显示（差额保留负号，不在页面上运算）。
// TODO(规划/11 §7): 对账任务表、【手动下载并核对】、差错单的处置 — blocked on 读接口 / 写接口契约未出
import { Button, Card, Flex, Form, Select, Tag, Typography, theme } from 'antd';
import type { TableColumnsType } from 'antd';
import { useId, useState, type ReactElement } from 'react';
import { payOrdersTexts } from '../../texts/pay-orders.ts';
import { DictName } from './DictName.tsx';
import {
  DIFFS_URL,
  DIFF_STATUSES,
  DIFF_TYPES,
  beijingTime,
  diffParams,
  diffStatusLabel,
  diffTypeLabel,
  money,
  type DiffFilters,
  type PayReconDiff,
  type PayReconDiffType,
  type ReconDiffStatus,
} from './model.ts';
import { PagedTable, usePagedRead } from './PagedList.tsx';

const t = payOrdersTexts.recon;

interface DiffDraft {
  readonly type: PayReconDiffType | undefined;
  readonly status: ReconDiffStatus | undefined;
}
const EMPTY_DRAFT: DiffDraft = { type: undefined, status: undefined };

export function ReconDiffsTab(): ReactElement {
  const { token } = theme.useToken();
  const ids = { type: useId(), status: useId() };
  const [draft, setDraft] = useState<DiffDraft>(EMPTY_DRAFT);
  const [filters, setFilters] = useState<DiffFilters>({});
  const read = usePagedRead<PayReconDiff>(DIFFS_URL, diffParams(filters));

  const runQuery = () => {
    setFilters({
      ...(draft.type === undefined ? {} : { type: draft.type }),
      ...(draft.status === undefined ? {} : { status: draft.status }),
    });
    read.restart();
  };
  const reset = () => {
    setDraft(EMPTY_DRAFT);
    setFilters({});
    read.restart();
  };

  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const amount = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;
  const columns: TableColumnsType<PayReconDiff> = [
    {
      key: 'period',
      title: t.columns.period,
      render: (_, row) => <span style={{ whiteSpace: 'nowrap' }}>{row.period}</span>,
    },
    {
      key: 'type',
      title: t.columns.type,
      render: (_, row) => (
        <span style={{ whiteSpace: 'nowrap' }}>
          <DictName>{diffTypeLabel(row.type)}</DictName>
        </span>
      ),
    },
    {
      key: 'ref',
      title: t.columns.ref,
      render: (_, row) => (
        <Flex vertical gap={2}>
          <span style={{ fontSize: token.fontSizeSM, color: token.colorTextSecondary }}>
            {row.ref_type}
          </span>
          <span style={{ ...code, fontSize: token.fontSizeSM }}>{row.ref_id}</span>
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
        <Tag style={{ marginInlineEnd: 0 }}>
          <DictName>{diffStatusLabel(row.status)}</DictName>
        </Tag>
      ),
    },
    {
      key: 'created',
      title: t.columns.created,
      render: (_, row) => (
        <span style={{ whiteSpace: 'nowrap' }}>{beijingTime(row.created_at)}</span>
      ),
    },
  ];

  return (
    <Flex vertical gap={16}>
      <Typography.Text type="secondary">{t.note}</Typography.Text>
      <Card>
        <Form layout="vertical" component="div">
          <Flex wrap gap={16} align="flex-end">
            <Form.Item label={t.filter.type} htmlFor={ids.type} style={{ marginBottom: 0 }}>
              <Select<PayReconDiffType>
                id={ids.type}
                value={draft.type ?? null}
                allowClear
                virtual={false}
                placeholder={payOrdersTexts.all}
                style={{ width: 180 }}
                options={DIFF_TYPES.map((item) => ({ value: item, label: diffTypeLabel(item) }))}
                onChange={(value: PayReconDiffType | undefined) =>
                  setDraft((previous) => ({ ...previous, type: value ?? undefined }))
                }
              />
            </Form.Item>
            <Form.Item label={t.filter.status} htmlFor={ids.status} style={{ marginBottom: 0 }}>
              <Select<ReconDiffStatus>
                id={ids.status}
                value={draft.status ?? null}
                allowClear
                virtual={false}
                placeholder={payOrdersTexts.all}
                style={{ width: 180 }}
                options={DIFF_STATUSES.map((item) => ({
                  value: item,
                  label: diffStatusLabel(item),
                }))}
                onChange={(value: ReconDiffStatus | undefined) =>
                  setDraft((previous) => ({ ...previous, status: value ?? undefined }))
                }
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
      <PagedTable<PayReconDiff>
        read={read}
        title={t.listTitle}
        rowKey="recon_diff_id"
        columns={columns}
        loadingText={t.loading}
        failedText={t.failed}
        emptyText={t.empty}
      />
    </Flex>
  );
}
