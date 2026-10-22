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
