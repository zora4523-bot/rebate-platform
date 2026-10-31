// B2-08c (规划/08 BR-WDR-20 税额计算与年度台账; 编排裁定 D10-456 ④; 拍板第二批 FUND-04): the tax of a
// withdrawal, computed at application from content's configuration — never a rate in code.
//
// Configuration (content's PayoutConfigPort, on the caller's handle; keys registered by B2-08cz):
//   tax.SERVICE_FEE.method      'none' | 'flat_rate' | 'cumulative'           missing → 'none'
//   tax.SERVICE_FEE.rate_bp     JSON integer 0..10000                           missing → 0
//   tax.SERVICE_FEE.rate_table  JSON array of brackets
//                               [{ from_fen, rate_bp, quick_deduction_fen }, …]  missing → []
//                               (every field a non-negative JSON integer, rate_bp ≤ 10000; the
//                               first from_fen is 0 and from_fen strictly ascends)
//   A missing row is its default silently; an invalid value is its default with a logger.warn
//   (key only), never a throw. The effective configuration is what remains after the defaults.
//
// Methods (amounts bigint fen, @couli/money; never floating point):
//   none        tax 0 (the state until the rate table arrives, FUND-04; tax_ytd still adds up).
//   flat_rate   round_half_up(amount × rate_bp / 10000).
//   cumulative  max(0, due(ytd income + in-flight amounts + amount) − ytd withheld − in-flight tax)
//               where due(X) = round_half_up(X × rate_bp / 10000) − quick_deduction_fen of the
//               bracket X falls in (the last bracket whose from_fen ≤ X; an empty table → 0);
//               ytd = the tax_ytd row (app, user, year, 'SERVICE_FEE', current identity hmac from
//               identity's realname-identity-key port; no row → 0 / 0; no verified real name →
//               0 / 0 and a logger.warn without any hmac); in-flight = the same member's
//               withdrawals, income_type 'SERVICE_FEE', status PENDING_REVIEW / APPROVED / PAYING,
//               whose created_at falls in the same +08:00 year: Σ amount_fen and Σ tax_fen.
//               year = the +08:00 calendar year of input.now (the instant the row is created at).
//   none and flat_rate read nothing but the three keys.
//
// fee_fen stays 0 (BR-WDR-19 MVP); net_fen = amount − fee − tax; tax_rule_version =
// taxRuleVersion(effective configuration): a deterministic, non-empty string that changes when the
// method, the rate or any bracket changes and is stable for the same configuration.
//
// withdraw-apply.ts quotes once before the locks (the net for the first-pass validation) and once
// more under the member's locks; the locked quote is what the row stores, so a concurrent
// application that committed in between counts as in flight (BR-WDR-07 lock order).
import type { DB } from '@couli/db';
import { accountingDate } from '@couli/domain';
import { parseFen } from '@couli/money';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { TaxYtdIdentityKeyReader } from './tax-ytd.ts';
import type { FeeTaxCalculator, PayoutConfigPort } from './withdraw-rules.ts';

export type TaxMethod = 'none' | 'flat_rate' | 'cumulative';

/** One bracket of the progressive table: from from_fen (inclusive) on, rate_bp and the deduction. */
export interface TaxBracket {
  readonly from_fen: bigint;
  readonly rate_bp: bigint;
  readonly quick_deduction_fen: bigint;
}

/** The effective tax.SERVICE_FEE.* configuration (after the defaults). */
export interface TaxConfig {
  readonly method: TaxMethod;
  readonly rate_bp: bigint;
  readonly rate_table: readonly TaxBracket[];
}

export interface CumulativeTaxInput {
  /** tax_ytd.cum_income_fen of the current identity's row (0 without a row). */
  readonly ytdIncomeFen: bigint;
  /** tax_ytd.cum_withheld_fen of the current identity's row (0 without a row). */
  readonly ytdWithheldFen: bigint;
  /** Σ amount_fen of the in-flight withdrawals of the year. */
  readonly inFlightAmountFen: bigint;
  /** Σ tax_fen of the in-flight withdrawals of the year. */
  readonly inFlightTaxFen: bigint;
  /** This application's amount. */
  readonly amountFen: bigint;
  readonly table: readonly TaxBracket[];
}

export interface FeeTaxLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface FeeTaxCalculatorOptions {
  readonly config: PayoutConfigPort;
  readonly identityKey: TaxYtdIdentityKeyReader;
  readonly logger: FeeTaxLogger;
}

export const TAX_METHOD_KEY = 'tax.SERVICE_FEE.method';
export const TAX_RATE_BP_KEY = 'tax.SERVICE_FEE.rate_bp';
export const TAX_RATE_TABLE_KEY = 'tax.SERVICE_FEE.rate_table';

/** The warn line of a configuration value that is not of the registered shape (key only). */
export const TAX_CONFIG_INVALID = 'tax_config_invalid';
/** The warn line of a cumulative quote for a member without a verified real name (ids only). */
export const TAX_IDENTITY_MISSING = 'tax_calc_identity_missing';

const INCOME_TYPE = 'SERVICE_FEE';
const IN_FLIGHT_STATUSES = ['PENDING_REVIEW', 'APPROVED', 'PAYING'] as const;
const BP_DENOMINATOR = 10_000n;
const MAX_BP = 10_000n;

/** round_half_up(amountFen × ratioBp / denominator) for amountFen ≥ 0, in bigint. */
export function mulDivRoundHalfUp(amountFen: bigint, ratioBp: bigint, denominator: bigint): bigint {
  if (amountFen < 0n || ratioBp < 0n || denominator <= 0n) {
    throw new RangeError('fee-tax: round_half_up needs a non-negative amount and ratio');
  }
  return (2n * amountFen * ratioBp + denominator) / (2n * denominator);
}

/** flat_rate: round_half_up(amount × rate_bp / 10000). */
export function flatRateTaxFen(amountFen: bigint, rateBp: bigint): bigint {
  return mulDivRoundHalfUp(amountFen, rateBp, BP_DENOMINATOR);
}

/**
 * due(X) of the progressive table: the last bracket whose from_fen ≤ X decides the rate and the
 * quick deduction; an empty table (or X below the first bracket) is 0.
 */
export function dueTaxFen(incomeFen: bigint, table: readonly TaxBracket[]): bigint {
  let bracket: TaxBracket | undefined;
  for (const row of table) {
    if (row.from_fen <= incomeFen) bracket = row;
    else break;
  }
  if (bracket === undefined) return 0n;
  const due =
    mulDivRoundHalfUp(incomeFen, bracket.rate_bp, BP_DENOMINATOR) - bracket.quick_deduction_fen;
  return due < 0n ? 0n : due;
}

/** cumulative: max(0, due(ytd income + in-flight + amount) − ytd withheld − in-flight tax). */
export function cumulativeTaxFen(input: CumulativeTaxInput): bigint {
  const total = input.ytdIncomeFen + input.inFlightAmountFen + input.amountFen;
  const tax = dueTaxFen(total, input.table) - input.ytdWithheldFen - input.inFlightTaxFen;
  return tax < 0n ? 0n : tax;
}

/** A deterministic text of the effective configuration (field order fixed, key order irrelevant). */
export function taxRuleVersion(config: TaxConfig): string {
  const table = config.rate_table
    .map((row) => `${row.from_fen}:${row.rate_bp}:${row.quick_deduction_fen}`)
    .join(',');
  return `${config.method}|${config.rate_bp}|[${table}]`;
}

function isJsonInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function parseMethod(value: unknown): TaxMethod | null {
  return value === 'none' || value === 'flat_rate' || value === 'cumulative' ? value : null;
}

function parseRateBp(value: unknown): bigint | null {
  if (!isJsonInteger(value) || value < 0 || value > Number(MAX_BP)) return null;
  return BigInt(value);
}

function parseBracket(value: unknown): TaxBracket | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const from = row['from_fen'];
  const rate = row['rate_bp'];
  const deduction = row['quick_deduction_fen'];
  if (!isJsonInteger(from) || !isJsonInteger(rate) || !isJsonInteger(deduction)) return null;
  if (from < 0 || rate < 0 || rate > Number(MAX_BP) || deduction < 0) return null;
  return { from_fen: BigInt(from), rate_bp: BigInt(rate), quick_deduction_fen: BigInt(deduction) };
}

function parseRateTable(value: unknown): readonly TaxBracket[] | null {
  if (!Array.isArray(value)) return null;
  const table: TaxBracket[] = [];
  for (const item of value) {
    const bracket = parseBracket(item);
    if (bracket === null) return null;
    table.push(bracket);
  }
  for (let i = 0; i < table.length; i += 1) {
    const row = table[i]!;
    if (i === 0 ? row.from_fen !== 0n : row.from_fen <= table[i - 1]!.from_fen) return null;
  }
  return table;
}

/** The +08:00 calendar year of `at` and the instants that bound it (left closed, right open). */
function taxYearOf(at: Date): { year: number; start: string; end: string } {
  const year = Number(accountingDate(at).slice(0, 4));
  return {
    year,
    start: `${year}-01-01T00:00:00+08:00`,
    end: `${year + 1}-01-01T00:00:00+08:00`,
  };
}

export function createFeeTaxCalculator(options: FeeTaxCalculatorOptions): FeeTaxCalculator {
  const { config, identityKey, logger } = options;

  async function readConfig(appId: string, handle: Kysely<DB>): Promise<TaxConfig> {
    const read = async <T>(
      key: string,
      parse: (value: unknown) => T | null,
      fallback: T,
    ): Promise<T> => {
      const row = await config.configValue(appId, key, handle);
      if (row === null) return fallback;
      const parsed = parse(row.value);
      if (parsed === null) {
        logger.warn({ app_id: appId, key }, TAX_CONFIG_INVALID);
        return fallback;
      }
      return parsed;
    };
    const method = await read(TAX_METHOD_KEY, parseMethod, 'none');
    const rateBp = await read(TAX_RATE_BP_KEY, parseRateBp, 0n);
    const rateTable = await read<readonly TaxBracket[]>(TAX_RATE_TABLE_KEY, parseRateTable, []);
    return { method, rate_bp: rateBp, rate_table: rateTable };
  }

  async function ytdOf(
    handle: Kysely<DB> | Transaction<DB>,
    appId: string,
    userId: string,
    year: number,
    withdrawalId: string | undefined,
  ): Promise<{ income: bigint; withheld: bigint }> {
    const hmac = await identityKey.readIdentityKey(handle, { appId, userId });
    if (hmac === null) {
      logger.warn(
        {
          app_id: appId,
          user_id: userId,
          year,
          ...(withdrawalId === undefined ? {} : { withdrawal_id: withdrawalId }),
        },
        TAX_IDENTITY_MISSING,
      );
      return { income: 0n, withheld: 0n };
    }
    const row = await handle
      .withSchema('app')
      .selectFrom('tax_ytd')
      .select(['cum_income_fen', 'cum_withheld_fen'])
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .where('year', '=', year)
      .where('income_type', '=', INCOME_TYPE)
      .where('identity_hmac', '=', hmac)
      .executeTakeFirst();
    return row === undefined
      ? { income: 0n, withheld: 0n }
      : { income: parseFen(row.cum_income_fen), withheld: parseFen(row.cum_withheld_fen) };
  }

  async function inFlightOf(
    handle: Kysely<DB> | Transaction<DB>,
    appId: string,
    userId: string,
    bounds: { start: string; end: string },
  ): Promise<{ amount: bigint; tax: bigint }> {
    const row = await handle
      .withSchema('app')
      .selectFrom('withdrawals')
      .select([
        sql<string>`coalesce(sum(amount_fen), 0)::text`.as('amount'),
        sql<string>`coalesce(sum(tax_fen), 0)::text`.as('tax'),
      ])
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .where('income_type', '=', INCOME_TYPE)
      .where('status', 'in', [...IN_FLIGHT_STATUSES])
      .where('created_at', '>=', sql<Date>`${bounds.start}::timestamptz`)
      .where('created_at', '<', sql<Date>`${bounds.end}::timestamptz`)
      .executeTakeFirstOrThrow();
    return { amount: parseFen(row.amount), tax: parseFen(row.tax) };
  }

  return {
    async calculate(handle, input) {
      const amountFen = parseFen(input.amountFen);
      if (amountFen < 0n) throw new RangeError('fee-tax: the amount must not be negative');
      const effective = await readConfig(input.appId, handle);
      let taxFen = 0n;
      if (effective.method === 'flat_rate') {
        taxFen = flatRateTaxFen(amountFen, effective.rate_bp);
      } else if (effective.method === 'cumulative') {
        const { year, start, end } = taxYearOf(input.now);
        const ytd = await ytdOf(handle, input.appId, input.userId, year, undefined);
        const inFlight = await inFlightOf(handle, input.appId, input.userId, { start, end });
        taxFen = cumulativeTaxFen({
          ytdIncomeFen: ytd.income,
          ytdWithheldFen: ytd.withheld,
          inFlightAmountFen: inFlight.amount,
          inFlightTaxFen: inFlight.tax,
          amountFen,
          table: effective.rate_table,
        });
      }
      const feeFen = 0n;
      return {
        fee_fen: feeFen,
        tax_fen: taxFen,
        net_fen: amountFen - feeFen - taxFen,
        fee_rule_id: null,
        tax_rule_version: taxRuleVersion(effective),
      };
    },
  };
}
