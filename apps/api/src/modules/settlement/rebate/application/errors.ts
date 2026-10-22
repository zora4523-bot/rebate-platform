/**
 * BR-FUND-01 表外事件：状态与余额都不变；内部调用抛出，不重试（调用方记日志并告警）。
 * 只给表外命令；已锁定订单遇平台正向推进与重复上报不抛（本线 decision 43）。
 */
export class IllegalTransition extends Error {
  readonly from: string;
  readonly event: string;

  constructor(from: string, event: string, detail?: string) {
    super(
      `illegal rebate transition ${from} --${event}--> (${detail ?? 'not in transition table'})`,
    );
    this.name = 'IllegalTransition';
    this.from = from;
    this.event = event;
  }
}

/** Why settlement refused a rebate call other than an illegal transition. */
export type RebateErrorCode =
  /** No orders row for (app_id, order_id, attr_at): wrong app, wrong partition key or missing row. */
  | 'ORDER_NOT_FOUND'
  /** The CAS UPDATE matched zero rows again after one re-read (concurrent writer). */
  | 'ORDER_CAS_CONFLICT';

export class RebateError extends Error {
  readonly code: RebateErrorCode;

  constructor(code: RebateErrorCode, message: string) {
    super(`settlement: ${message}`);
    this.name = 'RebateError';
    this.code = code;
  }
}
