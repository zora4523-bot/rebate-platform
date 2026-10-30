export { SettlementAdminModule, SettlementModule, REBATE_PORT } from './settlement.module.ts';
export { createRebatePort } from './rebate/application/rebate.ts';
export { IllegalTransition, RebateError } from './rebate/application/errors.ts';
export type { RebateErrorCode } from './rebate/application/errors.ts';
export type {
  RebatePort,
  RebateDependencies,
  RebateOrderRef,
  RebateChangeInput,
  RebateHoldAudit,
  PrecreditEvent,
} from './rebate/application/rebate.ts';
export { createPendingEarningsSource } from './reads/pending-earnings.ts';
export type {
  PendingEarningsSource,
  PendingEarningsDependencies,
  PendingSnapshot,
  PendingSnapshotInput,
  UserPendingEarnings,
  AppPendingEarnings,
} from './reads/pending-earnings.ts';
// B2-13a: the earnings dashboard's order facts (BR-FUND-25; read only, for ledger's port).
export { createEarningsOrdersSource } from './reads/earnings.ts';
export type {
  EarningsOrders,
  EarningsOrdersDependencies,
  EarningsOrdersInput,
  EarningsOrdersSource,
  EarningsOwnOrder,
  EarningsReferralOrder,
} from './reads/earnings.ts';
// B2-04zc: the wallet ledger's order links (order_key → order_id; read only, for ledger's port).
export { readOrderIdsByKey } from './reads/wallet-ledger.ts';
export type { OrderIdsByKeyInput } from './reads/wallet-ledger.ts';
// B1-01zzi: the worker's fund metrics (failed bill jobs, PARTIAL batches, held shares; read only).
export { readSettlementFundMetrics } from './application/metrics-read.ts';
export type { SettlementFundMetrics } from './application/metrics-read.ts';
// B2-04l: orders' rights ports (rights.record; rebate.adminHold / adminUnhold, R11).
// 生产装配维权端口的任务须 deps B2-04lb（TODO(规划/11 §4.2): 入账前部分维权 N_new 落库与 WAIT_COMMISSION 入账前关闭 — blocked on B2-04lb（D10-470））。
export { createRebateAdminCommandPort, createRightsCommandPort } from './rights/index.ts';
export type { RebateAdminDependencies, RightsCommandDependencies } from './rights/index.ts';
