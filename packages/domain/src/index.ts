export { accountingDate, chinaMonth, chinaDayRange, chinaMonthRange } from './calendar/index.ts';
export { summarizeClaimDecisions, evidenceEvent } from './claims/summarize.ts';
export {
  parseResidentIdNo,
  reachedAgeAt,
  ageAt,
  isAtLeastAge,
  normalizePersonName,
  samePersonName,
  normalizeBankCardNo,
  isValidBankCardNo,
} from './identity-docs/index.ts';
export type { ResidentIdNoResult } from './identity-docs/index.ts';
export {
  normalizeInviteCode,
  isInviteCodeFormat,
  inviterUnavailable,
  inviteBackfillDeadline,
  withinBackfill,
  inviteFailWindow,
} from './invite/index.ts';
export type { InviterFacts, InviteFailWindow } from './invite/index.ts';
export { splitCommission, quoteRebate } from './commission/commission.ts';
export { validateRuleVersion } from './commission/publish-validation.ts';
export type {
  RuleVersionDraft,
  RuleVersionReserve,
  RuleVersionRow,
  RuleVersionValidationCode,
  RuleVersionValidationError,
  ValidateRuleVersionInput,
  ValidateRuleVersionResult,
} from './commission/publish-validation.ts';
export type {
  CommissionBeneficiary,
  CommissionShare,
  CommissionWarning,
  QuoteRebateInput,
  SplitCommissionInput,
  SplitCommissionResult,
} from './commission/commission.ts';
export {
  deriveProductKey,
  ProductKeyInvalid,
  ProductKeyPlatformUnsupported,
  ProductKeyUnderivable,
  splitProductKey,
  validateProductKey,
} from './product-key/product-key.ts';
export type {
  ProductKeyDerivation,
  ProductKeyParts,
  ProductKeyPlatform,
  UnionProductPayload,
} from './product-key/product-key.ts';
export {
  orderKey,
  uniqKey,
  validateVoucher,
  applyEntries,
  mayGoNegative,
} from './ledger/ledger.ts';
export type {
  LedgerRole,
  UniqKeyInput,
  LedgerEntry,
  VoucherValidationCode,
  VoucherValidationError,
  VoucherValidationResult,
  LedgerBalance,
  NegativeBalanceInput,
} from './ledger/ledger.ts';
export { buildVouchers } from './ledger/build-vouchers.ts';
export type {
  VoucherAccount,
  BuiltVoucherEntry,
  BuiltVoucher,
  BuildVoucherParams,
} from './ledger/build-vouchers.ts';
export {
  ORDER_PLATFORM_EVENTS,
  ORDER_PLATFORM_STATES,
  ORDER_PLATFORM_TRANSITIONS,
  transitionOrderPlatform,
} from './state-machines/order-platform.gen.ts';
export type {
  OrderPlatformState,
  OrderPlatformEvent,
  OrderPlatformTransitionResult,
  OrderPlatformTransitionRow,
} from './state-machines/order-platform.gen.ts';
export {
  ORDER_REBATE_EVENTS,
  ORDER_REBATE_STATES,
  ORDER_REBATE_TRANSITIONS,
  transitionOrderRebate,
} from './state-machines/order-rebate.gen.ts';
export type {
  OrderRebateState,
  OrderRebateEvent,
  OrderRebateTransitionResult,
  OrderRebateTransitionRow,
} from './state-machines/order-rebate.gen.ts';
export {
  COMMISSION_RULE_VERSION_EVENTS,
  COMMISSION_RULE_VERSION_STATES,
  COMMISSION_RULE_VERSION_TRANSITIONS,
  transitionCommissionRuleVersion,
} from './state-machines/commission-rule-version.gen.ts';
export type {
  CommissionRuleVersionState,
  CommissionRuleVersionEvent,
  CommissionRuleVersionTransitionResult,
  CommissionRuleVersionTransitionRow,
} from './state-machines/commission-rule-version.gen.ts';
export {
  PAGE_VERSION_EVENTS,
  PAGE_VERSION_STATES,
  PAGE_VERSION_TRANSITIONS,
  transitionPageVersion,
} from './state-machines/page-version.gen.ts';
export type {
  PageVersionState,
  PageVersionEvent,
  PageVersionTransitionResult,
  PageVersionTransitionRow,
} from './state-machines/page-version.gen.ts';
export {
  WITHDRAWAL_EVENTS,
  WITHDRAWAL_STATES,
  WITHDRAWAL_TRANSITIONS,
  transitionWithdrawal,
} from './state-machines/withdrawal.gen.ts';
export type {
  WithdrawalState,
  WithdrawalEvent,
  WithdrawalTransitionResult,
  WithdrawalTransitionRow,
} from './state-machines/withdrawal.gen.ts';
