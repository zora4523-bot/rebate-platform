export { SettlementModule, REBATE_PORT } from './settlement.module.ts';
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
// B1-01zzi: the worker's fund metrics (failed bill jobs, PARTIAL batches, held shares; read only).
export { readSettlementFundMetrics } from './application/metrics-read.ts';
export type { SettlementFundMetrics } from './application/metrics-read.ts';
