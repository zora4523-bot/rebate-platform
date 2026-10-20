/** Total budget minus occupied and paid rewards, in fen; growth owns the calculation. */
export abstract class InviteRewardBudgetReader {
  /** null means unavailable; callers must disable the invitation reward display. */
  abstract available(appId: string): Promise<number | null>;
}
