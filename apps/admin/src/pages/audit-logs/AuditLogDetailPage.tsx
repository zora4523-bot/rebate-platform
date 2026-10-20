// Audit record detail subpage (/audit-logs/<id>, F1-10j): GET /admin/v1/audit-logs/{id} only
// (a direct address never reads the list) with the list fields and the before / after view: one
// row per field, the changed ones marked with text (not colour alone); a side the action did not
// record shows the dash. A record that is unknown or not visible (20001) shows nothing of it.
import type { Schema } from '@couli/contracts-ts';
import { ArrowLeftOutlined, DiffOutlined, ReloadOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Button,
  Card,
  Descriptions,
  Empty,
  Flex,
  Result,
  Table,
  Tag,
  Typography,
  theme,
  type DescriptionsProps,
  type TableColumnsType,
} from 'antd';
import { useEffect, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { auditLogsTexts } from '../../texts/audit-logs.ts';
import { beijingTime, diffRows, valueText, type AuditDetail, type DiffRow } from './model.ts';

const t = auditLogsTexts.detail;
const dash = auditLogsTexts.dash;
const LOGS_URL = '/admin/v1/audit-logs';

type LoadStatus = 'loading' | 'ready' | 'failed' | 'missing' | 'forbidden';

function statusOf(cause: unknown): LoadStatus {
  if (!(cause instanceof AdminApiError)) return 'failed';
  if (cause.code === 10403) return 'forbidden';
  if (cause.code === 20001) return 'missing';
  return 'failed';
}

export interface AuditLogDetailPageProps {
  readonly id: string;
  readonly access: AccessControl;
}

export function AuditLogDetailPage({ id }: AuditLogDetailPageProps): ReactElement {
  const getProvider = useDataProvider();
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const [record, setRecord] = useState<AuditDetail>();
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<Schema<'AdminAuditLog'>>({
      url: `${LOGS_URL}/${encodeURIComponent(id)}`,
      method: 'get',
    }).then(
      (response) => {
        if (!current) return;
        setRecord(response.data);
        setStatus('ready');
      },
      (cause: unknown) => {
        if (!current) return;
        setRecord(undefined);
        setStatus(statusOf(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, id, attempt]);

  const retry = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  const code = { fontFamily: token.fontFamilyCode } as const;

  const header = (
    <Flex justify="space-between" align="center" wrap gap={8}>
      <Flex align="center" gap={12} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t.title}
        </Typography.Title>
        <Typography.Text type="secondary" style={code}>
          {id}
        </Typography.Text>
      </Flex>
      <Button icon={<ArrowLeftOutlined aria-hidden />} onClick={() => void navigate('/audit-logs')}>
        {t.back}
      </Button>
    </Flex>
  );

  let body: ReactElement;
  if (status === 'loading') {
    body = (
      <Card>
        <Typography.Text type="secondary" role="status">
          {t.loading}
        </Typography.Text>
      </Card>
    );
  } else if (status === 'missing') {
    body = (
      <Card>
        <Result status="404" title={t.missingTitle} subTitle={t.missingDescription} />
      </Card>
    );
  } else if (status === 'forbidden') {
    body = (
      <Card>
        <Result status="403" title={t.forbiddenTitle} />
      </Card>
    );
  } else if (status === 'failed' || record === undefined) {
    body = (
      <Card>
        <Result
          status="error"
          title={t.loadFailedTitle}
          subTitle={t.loadFailedDescription}
          extra={
            <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={retry}>
              {auditLogsTexts.retry}
            </Button>
          }
        />
      </Card>
    );
  } else {
    body = <DetailBody record={record} />;
  }

  return (
    <Flex vertical gap={16}>
      {header}
      {body}
    </Flex>
  );
}

function DetailBody({ record }: { readonly record: AuditDetail }): ReactElement {
  const { token } = theme.useToken();
  const code = { fontFamily: token.fontFamilyCode } as const;
  const rows = diffRows(record.before, record.after);

  const items: DescriptionsProps['items'] = [
    { key: 'id', label: t.fields.id, children: <span style={code}>{record.id}</span> },
    { key: 'at', label: t.fields.at, children: beijingTime(record.at) },
    {
      key: 'actor',
      label: t.fields.actor,
      children: (
        <Flex vertical>
          <span>{record.actor_name ?? dash}</span>
          <span style={{ ...code, color: token.colorTextSecondary }}>{record.actor_id}</span>
        </Flex>
      ),
    },
    { key: 'action', label: t.fields.action, children: <span style={code}>{record.action}</span> },
    {
      key: 'target',
      label: t.fields.target,
      children: (
        <span style={code}>
          {record.target_type ?? dash} / {record.target_id ?? dash}
        </span>
      ),
    },
    {
      key: 'permission',
      label: t.fields.permission,
      children: <span style={code}>{record.permission ?? dash}</span>,
    },
    { key: 'ip', label: t.fields.ip, children: <span style={code}>{record.ip ?? dash}</span> },
  ];

  const valueCell = (value: unknown) => (
    <span style={{ ...code, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
      {valueText(value, dash)}
    </span>
  );

  const columns: TableColumnsType<DiffRow> = [
    {
      key: 'name',
      title: t.columns.field,
      width: 200,
      render: (_, row) => <span style={code}>{row.field ?? t.whole}</span>,
    },
    { key: 'before', title: t.columns.before, render: (_, row) => valueCell(row.before) },
    { key: 'after', title: t.columns.after, render: (_, row) => valueCell(row.after) },
    {
      key: 'change',
      title: t.columns.change,
      width: 120,
      render: (_, row) =>
        row.changed ? (
          <Tag color="warning" icon={<DiffOutlined aria-hidden />}>
            {t.changed}
          </Tag>
        ) : (
          <Typography.Text type="secondary">{t.unchanged}</Typography.Text>
        ),
    },
  ];

  return (
    <>
      <Card>
        <Descriptions column={2} size="small" items={items} />
      </Card>
      <Card title={t.diffTitle} styles={{ body: { padding: 0 } }}>
        {rows.length === 0 ? (
          <div style={{ padding: '32px 24px' }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t.noValues} />
          </div>
        ) : (
          <Table<DiffRow>
            rowKey={(row) => row.field ?? ''}
            columns={columns}
            dataSource={rows}
            pagination={false}
          />
        )}
      </Card>
    </>
  );
}
