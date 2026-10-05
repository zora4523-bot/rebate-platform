/** BR-TEXT-10: App display of int64 bigint fen; signed adds '+' only for positives. */
export function formatYuan(fen: bigint, opts?: { signed?: boolean }): string {
  void fen;
  void opts;
  throw new Error('NotImplemented: formatYuan');
}

/** BR-TEXT-10: Admin display with two decimals and comma grouping. */
export function formatYuanAdmin(fen: bigint, opts?: { signed?: boolean }): string {
  void fen;
  void opts;
  throw new Error('NotImplemented: formatYuanAdmin');
}

/** BR-TEXT-10: Ordered nonnegative rebate range; zero/zero returns null. */
export function formatYuanRange(
  minFen: bigint,
  maxFen: bigint,
  opts?: { admin?: boolean },
): string | null {
  void minFen;
  void maxFen;
  void opts;
  throw new Error('NotImplemented: formatYuanRange');
}
