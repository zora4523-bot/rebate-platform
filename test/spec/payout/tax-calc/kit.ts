// B2-08c rule-test kit (claude-independent; 规划/08 BR-WDR-20 税额计算与年度台账; task §9.2 1, §9.3):
// pure pieces shared by the unit tests and the database tests — the three configuration keys, a
// synthetic progressive table (made-up numbers: the real one waits for the tax adviser, 06 Q-F6;
// code must never carry it), a configuration port of fixed values and a recording logger.
// Nothing here calls the factories under test or touches a database.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { vi } from 'vitest';
import type { TaxBracket } from '../../../../apps/api/src/modules/payout/application/fee-tax-calculator.ts';
import type { PayoutConfigPort } from '../../../../apps/api/src/modules/payout/application/withdraw-rules.ts';

export const TAX_KEYS = {
  method: 'tax.SERVICE_FEE.method',
  rateBp: 'tax.SERVICE_FEE.rate_bp',
  rateTable: 'tax.SERVICE_FEE.rate_table',
} as const;

/** One bracket as stored in config_items (JSON numbers). */
export interface BracketJson {
  readonly from_fen: number;
  readonly rate_bp: number;
  readonly quick_deduction_fen: number;
}

/**
 * A synthetic three-bracket table, continuous at its boundaries (both sides give the same due):
 *   X <  100 000           10 %
 *   100 000 ≤ X < 500 000  20 % − 10 000
 *   X ≥ 500 000            30 % − 60 000
 */
export const TABLE_JSON: readonly BracketJson[] = [
  { from_fen: 0, rate_bp: 1000, quick_deduction_fen: 0 },
  { from_fen: 100_000, rate_bp: 2000, quick_deduction_fen: 10_000 },
  { from_fen: 500_000, rate_bp: 3000, quick_deduction_fen: 60_000 },
];

/** TABLE_JSON as the calculator's brackets. */
export const TABLE: readonly TaxBracket[] = TABLE_JSON.map(toBracket);

export function toBracket(row: BracketJson): TaxBracket {
  return {
    from_fen: BigInt(row.from_fen),
    rate_bp: BigInt(row.rate_bp),
    quick_deduction_fen: BigInt(row.quick_deduction_fen),
  };
}

/** due(X) of TABLE written out by hand (round half up of exact quotients; X ≥ 0). */
export function tableDue(x: bigint): bigint {
  const half = (n: bigint) => (2n * n + 10_000n) / 20_000n;
  if (x >= 500_000n) return half(x * 3000n) - 60_000n;
  if (x >= 100_000n) return half(x * 2000n) - 10_000n;
  return half(x * 1000n);
}

/** round_half_up(a × r / d) for a ≥ 0, r ≥ 0, d > 0, written out by hand. */
export function roundHalfUp(a: bigint, r: bigint, d: bigint): bigint {
  return (2n * a * r + d) / (2n * d);
}

/** A handle the none / flat_rate paths must never use (they read the three keys only). */
export const NO_HANDLE = {} as Kysely<DB>;

/**
 * A configuration port answering `values` for `appId` only (another app reads nothing); a key
 * absent from `values` is a missing row. Records every key read.
 */
export function fixedConfig(appId: string, values: Readonly<Record<string, unknown>>) {
  const reads: string[] = [];
  const port: PayoutConfigPort = {
    configValue(app, key) {
      reads.push(key);
      if (app !== appId || !Object.hasOwn(values, key)) {
        return Promise.resolve(null);
      }
      return Promise.resolve({ value: values[key], version: 1 });
    },
  };
  return { port, reads };
}

/** A logger whose warn lines are recorded. */
export function recordingLogger() {
  return { warn: vi.fn<(fields: Record<string, unknown>, message: string) => void>() };
}

/** Every recorded log line as one JSON text (bigint as text), for "never logged" checks. */
export function logText(logger: ReturnType<typeof recordingLogger>): string {
  return JSON.stringify(logger.warn.mock.calls, (_key: string, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

/** A synthetic member of a synthetic app (no database row needed by the pure paths). */
export function actor(appId: string) {
  return {
    appId,
    userId: '0190a8a0-0000-7000-8000-000000000001',
    deviceId: '0190a8a0-0000-7000-8000-000000000002',
  };
}

/** 2026-10-19 10:00 +08:00, the instant the unit tests apply at. */
export const NOW = new Date('2026-10-19T02:00:00.000Z');
