export { splitCommission, quoteRebate } from './commission/commission.ts';
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
