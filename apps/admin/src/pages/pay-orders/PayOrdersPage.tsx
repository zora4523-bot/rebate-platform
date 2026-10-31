// 支付单（资源 pay-orders，菜单 资金 / 支付单；画板 AdmPayOrders / AdmPayRecon，F1-13a 第一段只读）：
// 「支付单」「异常收款」「收款对账」三个页签，分别只读 CT-21e 的 listAdminPayOrders、
// listAdminPayAnomalies、listAdminPayReconDiffs。持 pay.view 可看；只持 pay.refund / pay.resolve
// 时本页说明无权限、不发请求。收款不进用户余额（BR-PAY-07）的说明常驻页头。F1-13b：异常收款页签按
// pay.refund 给出【退款】；支付单的写入口在详情页。
// TODO(规划/11 §7): 「退款单」页签、【导出】 — blocked on 退款单列表读接口 / 导出契约未接入
import { Alert, Card, Flex, Result, Tabs, Typography } from 'antd';
import type { ReactElement } from 'react';
import { PlannedPage, usePlanned } from '../../components/planned/index.ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { payOrdersTexts as t } from '../../texts/pay-orders.ts';
import { AnomaliesTab } from './AnomaliesTab.tsx';
import { OrdersTab } from './OrdersTab.tsx';
import { ReconDiffsTab } from './ReconDiffsTab.tsx';

/** The four reads of CT-21e all need pay.view. */
export function canReadPayOrders(access: AccessControl): boolean {
  return access.can('pay.view');
}

export function PayTitle({ children }: { readonly children?: string }): ReactElement {
  return (
    <Typography.Title level={4} className="admin-page-title" style={{ margin: 0 }}>
      {children ?? t.title}
    </Typography.Title>
  );
}

export function PayForbidden(): ReactElement {
  return (
    <Flex vertical gap={16}>
      <PayTitle />
      <Card>
        <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
      </Card>
    </Flex>
  );
}

export interface PayOrdersPageProps {
  readonly access: AccessControl;
}

export function PayOrdersPage({ access }: PayOrdersPageProps): ReactElement {
  const planned = usePlanned('listAdminPayOrders');
  if (planned) return <PlannedPage title={t.title} />;
  if (!canReadPayOrders(access)) return <PayForbidden />;
  return (
    <Flex vertical gap={16}>
      <PayTitle />
      <Alert type="info" showIcon role="note" message={t.balanceNotice} />
      <Alert type="info" role="note" message={t.writeNotice} />
      <Tabs
        defaultActiveKey="orders"
        items={[
          { key: 'orders', label: t.tabs.orders, children: <OrdersTab /> },
          { key: 'anomalies', label: t.tabs.anomalies, children: <AnomaliesTab access={access} /> },
          { key: 'recon', label: t.tabs.recon, children: <ReconDiffsTab /> },
        ]}
      />
    </Flex>
  );
}
