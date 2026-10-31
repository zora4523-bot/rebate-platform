// One read-only list of the user detail tabs: GET <url>?user_id=…&page=…&page_size=… through the
// data provider, page-number pagination and the three states of AdmUserDetailTabStates (loading,
// failed with 【重试】 that resends only this list, empty) plus no permission on 10403. Mounted
// only once its tab is opened, and keyed by the user (a new user never sees old rows).
import { useDataProvider } from '@refinedev/core';
import {
  Button,
  Card,
  Empty,
  Result,
  Table,
  Typography,
  type TableColumnsType,
  type TablePaginationConfig,
} from 'antd';
import { useEffect, useState, type ReactElement } from 'react';
import { usersTexts } from '../../../texts/users.ts';
import { TAB_PAGE_SIZE, tabFailureOf } from './model.ts';

const t = usersTexts.tabs;

export interface TabListCopy {
  readonly label: string;
  readonly loading: string;
  readonly failedTitle: string;
  readonly forbiddenTitle: string;
  readonly forbiddenDescription: string;
  readonly empty: string;
}

interface ListPage<Row> {
  readonly items: readonly Row[];
  readonly total: number;
}

export interface TabListProps<Row> {
  readonly url: string;
  readonly userId: string;
  readonly copy: TabListCopy;
  readonly columns: TableColumnsType<Row>;
  readonly rowKey: (row: Row) => string;
}

type Status = 'loading' | 'ready' | 'failed' | 'forbidden';

export function TabList<Row extends object>({
  url,
  userId,
  copy,
  columns,
  rowKey,
}: TabListProps<Row>): ReactElement {
  const getProvider = useDataProvider();
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<Status>('loading');
  const [data, setData] = useState<ListPage<Row>>();

  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<ListPage<Row>>({
      url,
      method: 'get',
      query: { user_id: userId, page, page_size: TAB_PAGE_SIZE },
    }).then(
      (response) => {
        if (!current) return;
        setData(response.data);
        setStatus('ready');
      },
      (cause: unknown) => {
        if (!current) return;
        setData(undefined);
        setStatus(tabFailureOf(cause));
      },
    );
    return () => {
      // A newer page (or leaving the tab) drops this answer.
      current = false;
    };
  }, [getProvider, url, userId, page, attempt]);

  const retry = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  const changePage = (pagination: TablePaginationConfig) => {
    if (pagination.current === undefined || pagination.current === page) return;
    setStatus('loading');
    setData(undefined);
    setPage(pagination.current);
  };

  if (status === 'loading')
    return (
      <Card>
        <Typography.Text type="secondary" role="status">
          {copy.loading}
        </Typography.Text>
      </Card>
    );
  if (status === 'forbidden')
    return (
      <Card>
        <Result status="403" title={copy.forbiddenTitle} subTitle={copy.forbiddenDescription} />
      </Card>
    );
  if (status === 'failed' || data === undefined)
    return (
      <Card>
        <Result
          status="error"
          title={copy.failedTitle}
          subTitle={t.failedDescription}
          extra={<Button onClick={retry}>{t.retry}</Button>}
        />
      </Card>
    );
  return (
    <Card styles={{ body: { paddingTop: 0 } }}>
      <Table<Row>
        aria-label={copy.label}
        rowKey={rowKey}
        columns={columns}
        dataSource={[...data.items]}
        scroll={{ x: 'max-content' }}
        onChange={changePage}
        pagination={
          data.total > 0
            ? {
                current: page,
                pageSize: TAB_PAGE_SIZE,
                total: data.total,
                showSizeChanger: false,
                showTotal: (total) => t.total(total),
              }
            : false
        }
        locale={{
          emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={copy.empty} />,
        }}
      />
    </Card>
  );
}
