// Shell-owned pages: no permission yet (design-hifi AdmHomeNoPerm), welcome, a menu whose page
// is not wired yet, and a failed permission load (antd Result / Card / Empty).
import { LockOutlined } from '@ant-design/icons';
import { Button, Card, Empty, Flex, Result, Typography } from 'antd';
import type { MouseEvent } from 'react';
import { useHref, useNavigate } from 'react-router';
import { noPermissionTexts, shellTexts } from '../texts/shell.ts';

export interface NoPermissionPageProps {
  readonly username: string;
  readonly displayName: string;
  readonly permissionCount: number;
  readonly onRefresh: () => void;
}

const REPORTS = '/reports';

export function NoPermissionPage({
  username,
  displayName,
  permissionCount,
  onRefresh,
}: NoPermissionPageProps) {
  const navigate = useNavigate();
  const reportsHref = useHref(REPORTS);
  function openReports(event: MouseEvent<HTMLElement>): void {
    // A real link (new tab, copy address) that still navigates inside the router.
    event.preventDefault();
    void navigate(REPORTS);
  }
  return (
    <Flex vertical gap="middle">
      <Typography.Title level={4} className="admin-page-title">
        {shellTexts.welcomeTitle}
      </Typography.Title>
      <Card>
        <Result
          icon={<LockOutlined />}
          title={<h2 className="admin-plain-heading">{noPermissionTexts.title}</h2>}
          subTitle={noPermissionTexts.description(username)}
          extra={[
            <Button key="refresh" type="primary" autoInsertSpace={false} onClick={onRefresh}>
              {noPermissionTexts.refresh}
            </Button>,
            <Button key="reports" href={reportsHref} onClick={openReports}>
              {noPermissionTexts.viewReports}
            </Button>,
          ]}
        />
      </Card>
      <Card title={<h2 className="admin-plain-heading">{noPermissionTexts.availableTitle}</h2>}>
        <Flex gap="middle">
          <Card size="small" style={{ flex: 1 }}>
            <Flex vertical gap={4}>
              <Typography.Text strong>{noPermissionTexts.reportsTitle}</Typography.Text>
              <Typography.Text type="secondary">
                {noPermissionTexts.reportsDescription}
              </Typography.Text>
            </Flex>
          </Card>
          <Card size="small" style={{ flex: 1 }}>
            <Flex vertical gap={4}>
              <Typography.Text strong>{noPermissionTexts.auditLogsTitle}</Typography.Text>
              <Typography.Text type="secondary">
                {noPermissionTexts.auditLogsDescription}
              </Typography.Text>
            </Flex>
          </Card>
        </Flex>
        <Typography.Paragraph type="secondary" className="admin-footnote">
          {noPermissionTexts.accountInfo(username, displayName, permissionCount)}
        </Typography.Paragraph>
      </Card>
    </Flex>
  );
}

export function WelcomePage() {
  return (
    <Flex vertical gap="middle">
      <Typography.Title level={4} className="admin-page-title">
        {shellTexts.welcomeTitle}
      </Typography.Title>
      <Card>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={shellTexts.welcomeHint} />
      </Card>
    </Flex>
  );
}

export function PagePending({ title }: { readonly title: string }) {
  return (
    <Flex vertical gap="middle">
      <Typography.Title level={4} className="admin-page-title">
        {title}
      </Typography.Title>
      <Card>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={shellTexts.pagePendingDescription}
        />
      </Card>
    </Flex>
  );
}

export function LoadFailedPage({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <Card role="alert">
      <Result
        status="error"
        title={<h2 className="admin-plain-heading">{shellTexts.loadFailedTitle}</h2>}
        subTitle={shellTexts.loadFailedDescription}
        extra={
          <Button type="primary" autoInsertSpace={false} onClick={onRetry}>
            {shellTexts.retry}
          </Button>
        }
      />
    </Card>
  );
}
