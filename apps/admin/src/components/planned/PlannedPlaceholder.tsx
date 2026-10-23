// 「功能开发中」占位（D10-284）：页面或页签依赖的读接口还没上线时代替内容区显示，不发请求、
// 不报错、没有重试。
import { Card, Empty, Flex, Typography } from 'antd';
import type { ReactElement } from 'react';
import { plannedTexts } from '../../texts/shell.ts';

/** 页签内容区的占位（不带页面标题）。 */
export function PlannedPanel(): ReactElement {
  return (
    <Card>
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <Flex vertical gap={4} role="status">
            <Typography.Text strong>{plannedTexts.title}</Typography.Text>
            <Typography.Text type="secondary">{plannedTexts.description}</Typography.Text>
          </Flex>
        }
      />
    </Card>
  );
}

/** 整页占位：页面标题照常，内容区换成占位。 */
export function PlannedPage({ title }: { readonly title: string }): ReactElement {
  return (
    <Flex vertical gap={16}>
      <Typography.Title level={4} className="admin-page-title" style={{ margin: 0 }}>
        {title}
      </Typography.Title>
      <PlannedPanel />
    </Flex>
  );
}
