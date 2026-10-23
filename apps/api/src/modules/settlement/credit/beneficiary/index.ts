// B2-04q: execution of one beneficiary credit item (R5a). Module-internal entry; the batch executor
// (B2-04p) calls it once per beneficiary item.
export { createBeneficiaryCredit } from './beneficiary-credit.ts';
export type {
  BeneficiaryCredit,
  BeneficiaryCreditAlert,
  BeneficiaryCreditDependencies,
  BeneficiaryCreditInput,
  BeneficiaryCreditResult,
  BeneficiaryCreditSkipReason,
} from './beneficiary-credit.ts';
