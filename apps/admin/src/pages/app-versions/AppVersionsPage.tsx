// 三端版本管理（01 F-ADM-17；契约 adminListAppVersions）。列表不分页，按服务端顺序（端、渠道）列出
// 每行的最新 / 最低支持 / 推荐版本、默认商店、各商店已上架版本与更新时间；读取不要动态码。
// 只有 ios、android、harmony 行有【编辑】，打开子页 /app-versions/<platform>/<channel>（直达只读
// 该行）；h5 与后台行只读。
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Empty,
  Flex,
  Result,
  Table,
  Tag,
  Typography,
  type TableColumnsType,
} from 'antd';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { Schema } from '@couli/contracts-ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { appVersionsTexts as t } from '../../texts/app-versions.ts';
import { AppVersionEditor } from './AppVersionEditor.tsx';
import {
  LIST_URL,
  MENU_ID,
  beijingTime,
  codeLabel,
  codeOf,
  editPath,
  editTargetOf,
  isEditable,
  targetLabel,
  type AppVersionRow,
} from './model.ts';

export interface AppVersionsPageProps {
  readonly access: AccessControl;
}

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'ready'; readonly items: readonly AppVersionRow[] };

/** 列表返回时带上刚保存的端与渠道，用来显示「已保存」。 */
interface SavedState {
  readonly savedTarget: string;
}

function savedTargetOf(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null || !('savedTarget' in state)) return undefined;
  return typeof state.savedTarget === 'string' ? state.savedTarget : undefined;
}

export function AppVersionsPage({ access }: AppVersionsPageProps): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const target = editTargetOf(location.pathname);
  if (target !== undefined) {
    return (
      <AppVersionEditor
        key={`${target.platform}/${target.channel}`}
        access={access}
        platform={target.platform}
        channel={target.channel}
        onBack={() => void navigate(`/${MENU_ID}`)}
        onSaved={(row) => {
          const state: SavedState = { savedTarget: targetLabel(row.platform, row.channel) };
          void navigate(`/${MENU_ID}`, { state });
        }}
      />
    );
  }
  return (
    <AppVersionList
      key={location.key}
      saved={savedTargetOf(location.state)}
      onEdit={(row) => {
        if (isEditable(row.platform))
          void navigate(editPath({ platform: row.platform, channel: row.channel }));
      }}
    />
  );
}

function AppVersionList({
  saved,
  onEdit,
}: {
  readonly saved: string | undefined;
  readonly onEdit: (row: AppVersionRow) => void;
}): ReactElement {
  const getProvider = useDataProvider();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const attempt = useRef(0);

  const read = useCallback((): Promise<void> => {
    attempt.current += 1;
    const current = attempt.current;
    const call = getProvider().custom;
    if (call === undefined) return Promise.reject(new Error('Missing custom data provider'));
    return call<Schema<'AdminAppVersionList'>>({ url: LIST_URL, method: 'get' }).then(
      (response) => {
        if (current === attempt.current) setLoad({ status: 'ready', items: response.data.items });
      },
      (cause: unknown) => {
        if (current === attempt.current)
          setLoad({ status: codeOf(cause) === 10403 ? 'forbidden' : 'failed' });
      },
    );
  }, [getProvider]);

  useEffect(() => {
    void read();
    return () => {
      attempt.current += 1;
    };
  }, [read]);

  const columns: TableColumnsType<AppVersionRow> = [
    {
      key: 'platform',
      title: t.columns.platform,
      render: (_, row) => codeLabel('client_platform', row.platform),
    },
    {
      key: 'channel',
      title: t.columns.channel,
      render: (_, row) => codeLabel('install_channel', row.channel),
    },
    { key: 'latest', title: t.columns.latest, render: (_, row) => row.latest_version },
    {
      key: 'minimum',
      title: t.columns.minimum,
      render: (_, row) => row.min_supported_version ?? t.dash,
    },
    {
      key: 'recommended',
      title: t.columns.recommended,
      render: (_, row) => row.recommended_version ?? t.dash,
    },
    {
      key: 'default',
      title: t.columns.defaultStore,
      render: (_, row) => codeLabel('app_store', row.default_store),
    },
    {
      key: 'listings',
      title: t.columns.listings,
      render: (_, row) =>
        row.store_listings.length === 0 ? (
          t.dash
        ) : (
          <Flex vertical gap={2}>
            {row.store_listings.map((listing) => (
              <Typography.Text key={listing.store}>
                {codeLabel('app_store', listing.store)}
                {t.listingSeparator}
                {listing.listed_version ?? t.notListed}
              </Typography.Text>
            ))}
          </Flex>
        ),
    },
    {
      key: 'updated',
      title: t.columns.updated,
      render: (_, row) => beijingTime(row.updated_at),
    },
    {
      key: 'actions',
      title: t.columns.actions,
      render: (_, row) =>
        isEditable(row.platform) ? (
          <Button type="link" size="small" onClick={() => onEdit(row)}>
            {t.edit}
          </Button>
        ) : (
          <Tag>{t.readOnly}</Tag>
        ),
    },
  ];

  let body: ReactElement;
  if (load.status === 'loading') {
    body = (
      <Card>
        <Typography.Text type="secondary" role="status">
          {t.loading}
        </Typography.Text>
      </Card>
    );
  } else if (load.status === 'forbidden') {
    body = (
      <Card>
        <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
      </Card>
    );
  } else if (load.status === 'failed') {
    body = (
      <Card>
        <Result
          status="error"
          title={t.loadFailedTitle}
          subTitle={t.loadFailedDescription}
          extra={
            <Button
              onClick={() => {
                setLoad({ status: 'loading' });
                void read();
              }}
            >
              {t.retry}
            </Button>
          }
        />
      </Card>
    );
  } else if (load.items.length === 0) {
    body = (
      <Card>
        <Empty description={t.empty} />
      </Card>
    );
  } else {
    body = (
      <Card>
        <Table<AppVersionRow>
          rowKey={(row) => `${row.platform}/${row.channel}`}
          columns={columns}
          dataSource={[...load.items]}
          pagination={false}
          size="middle"
        />
      </Card>
    );
  }

  return (
    <Flex vertical gap="middle">
      <Typography.Title level={4} className="admin-page-title" style={{ margin: 0 }}>
        {t.title}
      </Typography.Title>
      <Typography.Text type="secondary">{t.intro}</Typography.Text>
      {saved === undefined || load.status !== 'ready' ? null : (
        <Alert type="success" showIcon message={t.savedNotice(saved)} />
      )}
      {body}
    </Flex>
  );
}
