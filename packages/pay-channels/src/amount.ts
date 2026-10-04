// Fen <-> yuan conversion for channel payloads. Integer arithmetic only: no floats anywhere.

/** 1234 -> "12.34". Rejects negatives and non-integers. */
export function fenToYuan(fen: number | bigint): string {
  const v = typeof fen === 'bigint' ? fen : toBigInt(fen);
  if (v < 0n) throw new RangeError('amount must not be negative');
  const whole = v / 100n;
  const cents = v % 100n;
  return `${whole.toString()}.${cents.toString().padStart(2, '0')}`;
}

/** "12.34" | "12.3" | "12" -> 1234n. Rejects anything that is not a plain decimal with <= 2 places. */
export function yuanToFen(yuan: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(yuan);
  if (!m) throw new RangeError('not a decimal amount with at most 2 places');
  const whole = BigInt(m[1] ?? '0');
  const cents = BigInt((m[2] ?? '').padEnd(2, '0'));
  return whole * 100n + cents;
}

function toBigInt(n: number): bigint {
  if (!Number.isSafeInteger(n)) throw new RangeError('amount must be a safe integer of fen');
  return BigInt(n);
}
