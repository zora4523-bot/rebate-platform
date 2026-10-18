/**
 * Build-tool entry, not a runtime domain export. The implementation adds CLI dispatch:
 * node packages/domain/src/ledger/generate-templates.ts [--verify]
 *
 * Read specs/ledger-templates.csv relative to this module, preserve every cell including
 * TBD, and deterministically generate adjacent templates.gen.ts. --verify compares
 * without writing and exits nonzero on missing/stale output. Never maintain a second
 * handwritten template table. This test-stage entry is deliberately only a skeleton;
 * generated output and CLI execution belong to implementation/container verification.
 */
export function generateLedgerTemplates(args: readonly string[]): void {
  void args;
  throw new Error('NotImplemented: generateLedgerTemplates');
}
