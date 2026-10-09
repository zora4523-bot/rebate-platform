import { Breadcrumb, Button, Flex, Layout, Tag, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import type { AdminEnvironment } from '../shell-options.ts';
import { shellTexts } from '../texts/shell.ts';

export interface TopBarProps {
  readonly crumbs: readonly string[];
  readonly environment: AdminEnvironment;
  readonly displayName: string;
  /** A returned promise keeps 【退出】 disabled until the request ends (success, failure, timeout). */
  readonly onLogout: () => void | Promise<unknown>;
}

/** Breadcrumb on the left; environment tag, account and logout on the right (antd Layout.Header). */
export function TopBar({ crumbs, environment, displayName, onLogout }: TopBarProps) {
  const [loggingOut, setLoggingOut] = useState(false);
  // The click handler reads this, so a second click in the same frame is ignored too.
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function logout(): void {
    if (inFlight.current) return;
    const request = onLogout();
    if (request === undefined) return;
    inFlight.current = true;
    setLoggingOut(true);
    const settle = (): void => {
      inFlight.current = false;
      if (mounted.current) setLoggingOut(false);
    };
    void request.then(settle, settle);
  }

  return (
    <Layout.Header role="banner" className="admin-header">
      <Flex align="center" justify="space-between" style={{ height: '100%' }}>
        <Breadcrumb
          aria-label={shellTexts.breadcrumb}
          items={crumbs.map((crumb, index) => ({ key: index, title: crumb }))}
        />
        <Flex align="center" gap="small">
          {environment === 'production' ? null : (
            <Tag color="warning" bordered={false}>
              {shellTexts.nonProductionEnvironment}
            </Tag>
          )}
          <Typography.Text>{displayName}</Typography.Text>
          <Button
            type="link"
            autoInsertSpace={false}
            disabled={loggingOut}
            aria-busy={loggingOut || undefined}
            onClick={logout}
          >
            {shellTexts.logout}
          </Button>
        </Flex>
      </Flex>
    </Layout.Header>
  );
}
