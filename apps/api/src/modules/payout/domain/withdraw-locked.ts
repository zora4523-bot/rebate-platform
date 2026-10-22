import type { WithdrawBlock, WithdrawRuleInput } from './withdraw-rules.ts';

/** BR-WDR-07 ④: only BR-WDR-03 ⑦⑧⑩⑪⑫, in that order, using fresh locked reads. */
export function validateLockedWithdrawal(
  input: WithdrawRuleInput,
  amountFen: bigint,
): WithdrawBlock | null {
  void input;
  void amountFen;
  throw new Error('NotImplemented: validateLockedWithdrawal');
}
