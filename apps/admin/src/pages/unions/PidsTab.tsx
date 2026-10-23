// 「推广位」页签（F1-10gb；契约 adminListUnionPids 等，CT-24h；BR-ATTR-02）：全量推广位列表（不分页，
// 顺序同服务端：平台、场景、创建时间）与本地筛选；按状态的入口——pending：修改、启用；active：停用；
// retired：无。任何行都没有删除。列表只读、不要动态码；每次写都先 totp 动态码，令牌只用一次。
// 联盟账号名来自 GET /admin/v1/union-accounts（要 union.account_auth；没有时显示账号编号，登记时
// 选不了账号并提示）。
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Empty,
  Flex,
  Form,
  Result,
  Select,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { AuthClock } from '../../providers/auth/index.ts';
import { unionsTexts as t } from '../../texts/unions.ts';
import { ActivateDialog } from './ActivateDialog.tsx';
import {
  ACCOUNTS_URL,
  PIDS_URL,
  beijingTime,
  codeOf,
  customOf,
  isNetwork,
  pidStatusLabel,
  platformLabel,
  sceneLabel,
  type UnionAccount,
  type UnionPid,
} from './model.ts';
import { PidFormDialog } from './PidFormDialog.tsx';
import { RetireDialog } from './RetireDialog.tsx';
import { useStepUp } from './useStepUp.tsx';

type LoadStatus = 'loading' | 'ready' | 'failed' | 'forbidden';

type Editing =
  | { readonly kind: 'register' }
  | { readonly kind: 'edit'; readonly row: UnionPid }
  | { readonly kind: 'activate'; readonly row: UnionPid }
  | { readonly kind: 'retire'; readonly row: UnionPid };

interface Notice {
  readonly type: 'success' | 'warning';
  readonly text: string;
}

const ALL = '__all__';

export interface PidsTabProps {
  readonly clock: AuthClock;
  /** 是否持 union.account_auth（读联盟账号列表要它）。 */
  readonly canReadAccounts: boolean;
}

export function PidForbidden(): ReactElement {
  return (
    <Card>
      <Result status="403" title={t.pids.forbiddenTitle} subTitle={t.pids.forbiddenDescription} />
    </Card>
  );
}

export function PidsTab({ clock, canReadAccounts }: PidsTabProps): ReactElement {
  const getProvider = useDataProvider();
  const stepUp = useStepUp();
  const platformFilterId = useId();
  const sceneFilterId = useId();
  const [rows, setRows] = useState<UnionPid[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [network, setNetwork] = useState(false);
  const [accounts, setAccounts] = useState<UnionAccount[]>();
  const [platformFilter, setPlatformFilter] = useState(ALL);
  const [sceneFilter, setSceneFilter] = useState(ALL);
  const [editing, setEditing] = useState<Editing>();
  const [notice, setNotice] = useState<Notice>();
  const sequence = useRef(0);

  const load = useCallback(() => {
    const request = ++sequence.current;
    return customOf(getProvider())<{ items: UnionPid[] }>({ url: PIDS_URL, method: 'get' }).then(
      (response) => {
        if (request !== sequence.current) return;
        setRows(response.data.items);
        setStatus('ready');
      },
      (cause: unknown) => {
        if (request !== sequence.current) return;
        // 再查失败不显示旧数据。
        setRows([]);
        setNetwork(isNetwork(cause));
        setStatus(codeOf(cause) === 10403 ? 'forbidden' : 'failed');
      },
    );
  }, [getProvider]);

  useEffect(() => {
    void load();
    return () => {
      sequence.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (!canReadAccounts) return;
    let alive = true;
    customOf(getProvider())<{ items: UnionAccount[] }>({ url: ACCOUNTS_URL, method: 'get' }).then(
      (response) => {
        if (alive) setAccounts(response.data.items);
      },
      () => {
        // 读不到账号时列表显示账号编号，登记对话框提示选不了账号。
      },
    );
    return () => {
      alive = false;
    };
  }, [canReadAccounts, getProvider]);

  const retry = () => {
    setStatus('loading');
    void load();
  };

  const open = (next: Editing) => {
    setNotice(undefined);
    setEditing(next);
  };

  /** 写成功：先用响应里的行更新列表，再重新读取（顺序与其他行以服务端为准）。 */
  const saved = (row: UnionPid, text: string) => {
    setEditing(undefined);
    setRows((previous) =>
      previous.some((item) => item.pid_id === row.pid_id)
        ? previous.map((item) => (item.pid_id === row.pid_id ? row : item))
        : [...previous, row],
    );
    setNotice({ type: 'success', text });
    void load();
  };

  const conflict = () => {
    setEditing(undefined);
    setNotice({ type: 'warning', text: t.pids.conflict });
    void load();
  };

  const accountName = (id: string): string =>
    accounts?.find((item) => item.union_account_id === id)?.account_name ?? id;

  const platforms: string[] = [];
  for (const row of rows) if (!platforms.includes(row.platform)) platforms.push(row.platform);
  const scenes: string[] = [];
  for (const row of rows) if (!scenes.includes(row.pid_scene)) scenes.push(row.pid_scene);
  const shown = rows.filter(
    (row) =>
      (platformFilter === ALL || row.platform === platformFilter) &&
      (sceneFilter === ALL || row.pid_scene === sceneFilter),
  );

  const columns: TableColumnsType<UnionPid> = [
    {
      key: 'platform',
      title: t.pids.columns.platform,
      width: 88,
      render: (_, row) => <Typography.Text>{platformLabel(row.platform)}</Typography.Text>,
    },
    {
      key: 'account',
      title: t.pids.columns.account,
      width: 180,
      render: (_, row) => (
        <Typography.Text style={{ overflowWrap: 'anywhere' }}>
          {accountName(row.union_account_id)}
        </Typography.Text>
      ),
    },
    {
      key: 'site',
      title: t.pids.columns.site,
      width: 120,
      render: (_, row) =>
        row.site_id === null ? (
          <Typography.Text type="secondary">{t.dash}</Typography.Text>
        ) : (
          <Typography.Text code>{row.site_id}</Typography.Text>
        ),
    },
    {
      key: 'pid',
      title: t.pids.columns.pid,
      width: 160,
      render: (_, row) => (
        <Typography.Text strong style={{ overflowWrap: 'anywhere' }}>
          {row.pid}
        </Typography.Text>
      ),
    },
    {
      key: 'scene',
      title: t.pids.columns.scene,
      width: 120,
      render: (_, row) => <Typography.Text>{sceneLabel(row.pid_scene)}</Typography.Text>,
    },
    {
      key: 'status',
      title: t.pids.columns.status,
      width: 96,
      render: (_, row) => (
        <Tag
          color={
            row.status === 'active'
              ? 'success'
              : row.status === 'pending'
                ? 'processing'
                : 'default'
          }
          style={{ marginInlineEnd: 0 }}
        >
          {pidStatusLabel(row.status)}
        </Tag>
      ),
    },
    {
      key: 'confirmed',
      title: t.pids.columns.confirmedAt,
      width: 170,
      render: (_, row) =>
        row.hjy_ignore_confirmed_at === null ? (
          <Typography.Text type="secondary">{t.dash}</Typography.Text>
        ) : (
          <Typography.Text>{beijingTime(row.hjy_ignore_confirmed_at)}</Typography.Text>
        ),
    },
    {
      key: 'actions',
      title: t.pids.columns.actions,
      width: 120,
      render: (_, row) =>
        row.status === 'pending' ? (
          <Flex gap={12}>
            <Button
              type="link"
              size="small"
              style={{ paddingInline: 0 }}
              onClick={() => open({ kind: 'edit', row })}
            >
              {t.pids.edit}
            </Button>
            <Button
              type="link"
              size="small"
              style={{ paddingInline: 0 }}
              onClick={() => open({ kind: 'activate', row })}
            >
              {t.pids.activate}
            </Button>
          </Flex>
        ) : row.status === 'active' ? (
          <Button
            type="link"
            size="small"
            danger
            style={{ paddingInline: 0 }}
            onClick={() => open({ kind: 'retire', row })}
          >
            {t.pids.retire}
          </Button>
        ) : (
          <Typography.Text type="secondary">{t.pids.noAction}</Typography.Text>
        ),
    },
  ];

  if (status === 'forbidden') return <PidForbidden />;

  let body: ReactElement;
  if (status === 'loading') {
    body = (
      <Card>
        <Typography.Text type="secondary" role="status">
          {t.pids.loading}
        </Typography.Text>
      </Card>
    );
  } else if (status === 'failed') {
    body = (
      <Card>
        <Result
          status="error"
          title={t.pids.loadFailedTitle}
          subTitle={network ? t.loadFailedNetwork : t.loadFailedDescription}
          extra={<Button onClick={retry}>{t.retry}</Button>}
        />
      </Card>
    );
  } else if (rows.length === 0) {
    body = (
      <Card>
        <Empty description={t.pids.empty} />
      </Card>
    );
  } else if (shown.length === 0) {
    body = (
      <Card>
        <Empty description={t.pids.filteredEmpty} />
      </Card>
    );
  } else {
    body = (
      <Card styles={{ body: { padding: 0 } }} style={{ overflow: 'hidden' }}>
        <Table<UnionPid>
          rowKey="pid_id"
          columns={columns}
          dataSource={shown}
          pagination={false}
          tableLayout="fixed"
          scroll={{ x: 1054 }}
        />
      </Card>
    );
  }

  return (
    <Flex vertical gap={16}>
      <Card size="small">
        <Flex align="flex-end" justify="space-between" gap={16} wrap>
          <Form layout="inline" component="div">
            <Form.Item
              label={t.pids.filterPlatform}
              htmlFor={platformFilterId}
              style={{ marginBottom: 0 }}
            >
              <Select<string>
                id={platformFilterId}
                value={platformFilter}
                style={{ width: 140 }}
                onChange={setPlatformFilter}
                options={[
                  { value: ALL, label: t.pids.filterAll },
                  ...platforms.map((value) => ({ value, label: platformLabel(value) })),
                ]}
              />
            </Form.Item>
            <Form.Item
              label={t.pids.filterScene}
              htmlFor={sceneFilterId}
              style={{ marginBottom: 0 }}
            >
              <Select<string>
                id={sceneFilterId}
                value={sceneFilter}
                style={{ width: 160 }}
                onChange={setSceneFilter}
                options={[
                  { value: ALL, label: t.pids.filterAll },
                  ...scenes.map((value) => ({ value, label: sceneLabel(value) })),
                ]}
              />
            </Form.Item>
          </Form>
          <Button type="primary" onClick={() => open({ kind: 'register' })}>
            {t.pids.register}
          </Button>
        </Flex>
      </Card>
      {notice === undefined ? null : (
        <Alert
          type={notice.type}
          showIcon
          closable
          message={notice.text}
          onClose={() => setNotice(undefined)}
        />
      )}
      {body}
      {editing?.kind === 'register' ? (
        <PidFormDialog
          accounts={accounts}
          stepUp={stepUp}
          onClose={() => setEditing(undefined)}
          onSaved={(row) => saved(row, t.pids.registered(row.pid))}
          onConflict={conflict}
        />
      ) : null}
      {editing?.kind === 'edit' ? (
        <PidFormDialog
          key={editing.row.pid_id}
          row={editing.row}
          accounts={accounts}
          stepUp={stepUp}
          onClose={() => setEditing(undefined)}
          onSaved={(row) => saved(row, t.pids.saved(row.pid))}
          onConflict={conflict}
        />
      ) : null}
      {editing?.kind === 'activate' ? (
        <ActivateDialog
          key={editing.row.pid_id}
          row={editing.row}
          clock={clock}
          stepUp={stepUp}
          onClose={() => setEditing(undefined)}
          onActivated={(row) => saved(row, t.pids.activated(row.pid))}
          onConflict={conflict}
          onRefresh={() => void load()}
        />
      ) : null}
      {editing?.kind === 'retire' ? (
        <RetireDialog
          key={editing.row.pid_id}
          row={editing.row}
          stepUp={stepUp}
          onClose={() => setEditing(undefined)}
          onRetired={(row) => saved(row, t.pids.retired(row.pid))}
          onConflict={conflict}
        />
      ) : null}
      {stepUp.modal}
    </Flex>
  );
}
