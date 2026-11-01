import type { ReactElement } from 'react';

export type EarningsPageProps = Record<string, never>;

/**
 * 收益看板（F1-12a，路由 Earnings）：经应用级 API 客户端读 getEarningsSummary，自购 / 分享 / 邀请
 * 三栏 × 四期间、平台筛选与指标说明。测试阶段只有骨架。
 */
export function EarningsPage(props: EarningsPageProps): ReactElement {
  void props;
  throw new Error('NotImplemented: EarningsPage');
}

/** Route module shape (React Router `lazy`): the Earnings route renders this page. */
export { EarningsPage as Component };
