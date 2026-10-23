// Risk page (/risk, sidebar 「风控」; F1-10fa). The sidebar shows the page to risk.* accounts
// (resources/index.ts, unchanged); inside it the 规则清单 tab needs config.risk (or a super
// admin), as GET /admin/v1/risk-rules does. Without it no tab is shown and nothing is requested.
// The hit records, blocklist and appeal tabs wait for their contract (CT-24r) and are not shown.
import { Card, Flex, Tabs, Typography } from 'antd';
import type { ReactElement } from 'react';
import { PlannedPanel, usePlanned } from '../../components/planned/index.ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { riskTexts as t } from '../../texts/risk.ts';
import { RulesTab } from './RulesTab.tsx';

export interface RiskPageProps {
  readonly access: AccessControl;
}

const RULES_TAB = 'rules';
/** Permission key of the rule list and of enabling / disabling a rule (CT-24f). */
export const RULES_PERMISSION = 'config.risk';

export function RiskPage({ access }: RiskPageProps): ReactElement {
  const canRules = access.isSuper || access.can(RULES_PERMISSION);
  // GET /admin/v1/risk-rules not live yet (planned): the tab stays, its content is the
  // placeholder and nothing is read (D10-284).
  const rulesPlanned = usePlanned('adminListRiskRules');
  return (
    <Flex vertical gap={16}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t.title}
      </Typography.Title>
      {canRules ? (
        <Card>
          <Tabs
            activeKey={RULES_TAB}
            items={[{ key: RULES_TAB, label: t.tabs.rules }]}
            style={{ marginBottom: 8 }}
          />
          {rulesPlanned ? <PlannedPanel /> : <RulesTab />}
        </Card>
      ) : (
        <Card>
          <Typography.Text type="secondary">{t.noTab}</Typography.Text>
        </Card>
      )}
    </Flex>
  );
}
