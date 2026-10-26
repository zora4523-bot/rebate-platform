// B2-11a: the default WithdrawRiskFactsReader (BR-WDR-29 ①②④⑤⑥⑦⑧⑩). Reads only on the handle
// given; payout's own tables directly, other modules' data only through their index.ts ports
// (orders / commission / ledger / identity). Day and window bounds from @couli/domain, never a SQL
// clock. Nothing is written or logged. Rule tests: test/spec/payout/risk-flags/**.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { WithdrawRiskFactsReader } from '../application/withdraw-risk-flags.ts';

export function createWithdrawRiskFactsReader(): WithdrawRiskFactsReader {
  throw new Error('NotImplemented: createWithdrawRiskFactsReader');
}
