// B1-01zzp D10-393 (c) kit: 告警与执行同口径. The cap gauge takes B2-11c's own reading of
// withdraw.auto_payout.platform_daily_max_fen (autoPayoutConfigOf: absent or malformed → its 08
// default), so every expected cap here is computed by that very function, never written out as a
// number. The 80 % rule is read from infra/monitoring/rules/couli-fund.yaml as rules.test.ts reads
// it (parsed with tools/lib/yaml-lite). The static scan finds every import of platform/**.
import { readFileSync, readdirSync } from 'node:fs';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import {
  AUTO_PAYOUT_DEFAULTS,
  autoPayoutConfigOf,
} from '../../../../../apps/api/src/modules/payout/application/auto-payout.ts';
import type {
  AutoPayoutCapFenOf,
  AutoPayoutCapSnapshot,
} from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import { parseYamlLite } from '../../../../../tools/lib/yaml-lite.ts';
import { ROOT } from '../kit.ts';
import { CAP_KEY, CAP_METRIC, TOTAL_METRIC } from './kit.ts';

// ---- B2-11c's reading of the cap ---------------------------------------------------------------

/** B2-11c's platform_daily_max_fen of one snapshot: the function the decision itself runs. */
export const payoutCapFenOf: AutoPayoutCapFenOf = (snapshot) =>
  autoPayoutConfigOf(snapshot, () => undefined).config.platform_daily_max_fen;

/** The snapshot of an app_id whose cap row holds `value` (as read back from jsonb). */
export function capSnapshot(value: unknown): AutoPayoutCapSnapshot {
  return new Map([[CAP_KEY, { value, version: 1 }]]);
}

/** The cap B2-11c executes with when the app_id has no cap row. */
export function defaultCapFen(): number {
  return Number(autoPayoutConfigOf(new Map(), () => undefined).config.platform_daily_max_fen);
}

/** The cap B2-11c executes with when the app_id's cap row holds `value`. */
export function capFenOfValue(value: unknown): number {
  return Number(payoutCapFenOf(capSnapshot(value)));
}

/**
 * Cap values B2-11c does not accept (not a safe nonnegative integer number), each falling back to
 * the default: negative, fractional, a numeric string, JSON null, a boolean, beyond 2^53, an object.
 */
export const MALFORMED_CAPS: readonly unknown[] = [-1, 1.5, '150000', null, true, 2 ** 53, {}];

/** Cap values B2-11c accepts as they are (0: never auto, D10-377). */
export const VALID_CAPS: readonly number[] = [0, 123_400];

/**
 * Runs `body` while B2-11c's default cap is `fen`, then restores it: a value that follows the
 * change came from B2-11c's function, not from a copy of its default.
 */
export async function withPayoutDefaultCap<T>(fen: bigint, body: () => Promise<T> | T): Promise<T> {
  const original = AUTO_PAYOUT_DEFAULTS.platform_daily_max_fen;
  AUTO_PAYOUT_DEFAULTS.platform_daily_max_fen = fen;
  try {
    return await body();
  } finally {
    AUTO_PAYOUT_DEFAULTS.platform_daily_max_fen = original;
  }
}

/** A default cap different from B2-11c's real one (for withPayoutDefaultCap). */
export function shiftedDefaultCap(): bigint {
  return AUTO_PAYOUT_DEFAULTS.platform_daily_max_fen + 1_234n;
}

/** A cap row holding any JSON value (insertCap writes numbers only). */
export async function insertCapValue(db: Kysely<DB>, appId: string, value: unknown): Promise<void> {
  await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
    VALUES (${appId}, ${CAP_KEY}, ${JSON.stringify(value)}::jsonb, 'seed')`.execute(db);
}

// ---- BR-WDR-24: the 80 % line --------------------------------------------------------------------

/** BR-WDR-24 / B2-11c: total × 10000 ≥ cap × 8000, i.e. total ≥ ⌈cap × 8000 / 10000⌉ (whole fen). */
export function nearCapLineFen(capFen: number): number {
  return Number((BigInt(capFen) * 8000n + 9999n) / 10000n);
}

/** BR-WDR-24 itself, on whole fen. */
export function reachesNearCap(totalFen: number, capFen: number): boolean {
  return BigInt(totalFen) * 10000n >= BigInt(capFen) * 8000n;
}

/** As rules.test.ts: `total / cap >= t`, optionally `on(app_id)`, parenthesised or `* 100`. */
const RATIO = new RegExp(
  `^\\(?\\s*${TOTAL_METRIC}(\\{\\})?\\s*/\\s*(on\\s*\\(\\s*app_id\\s*\\)\\s*)?${CAP_METRIC}(\\{\\})?` +
    `\\s*\\)?\\s*(\\*\\s*100\\s*)?>=\\s*([0-9]+(?:\\.[0-9]+)?)\\s*$`,
);

/** The share t of every couli-fund.yaml rule reading the total gauge. */
export function capRuleShares(): number[] {
  const text = readFileSync(new URL('infra/monitoring/rules/couli-fund.yaml', ROOT), 'utf8');
  const doc = parseYamlLite(text) as {
    groups?: { rules?: { alert?: unknown; expr?: unknown }[] }[];
  };
  const shares: number[] = [];
  for (const group of doc.groups ?? []) {
    for (const rule of group.rules ?? []) {
      const expr = typeof rule.expr === 'string' ? rule.expr.trim() : '';
      if (!new RegExp(`\\b${TOTAL_METRIC}\\b`).test(expr)) continue;
      const match = RATIO.exec(expr);
      const where = `${String(rule.alert)}: expr is total / cap >= share, got ${expr}`;
      expect(match, where).not.toBeNull();
      const threshold = Number(match![5]);
      shares.push(match![4] === undefined ? threshold : threshold / 100);
    }
  }
  return shares;
}

/** Whether `total / cap >= share` holds as Prometheus evaluates it (0 / 0 is NaN: never). */
export function fires(share: number, totalFen: number, capFen: number): boolean {
  return totalFen / capFen >= share;
}

// ---- static: platform imports no business module ----------------------------------------------

const PLATFORM_DIR = new URL('apps/api/src/modules/platform/', ROOT);
const PAYOUT_DIR = new URL('apps/api/src/modules/payout/', ROOT);
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

/** Every .ts file under platform/** with each module specifier it imports or re-exports. */
export function platformImports(): { file: string; specifier: string; resolved: string }[] {
  const files = readdirSync(PLATFORM_DIR, { encoding: 'utf8', recursive: true }).filter((name) =>
    name.endsWith('.ts'),
  );
  const out: { file: string; specifier: string; resolved: string }[] = [];
  for (const name of files) {
    const url = new URL(name, PLATFORM_DIR);
    for (const match of readFileSync(url, 'utf8').matchAll(SPECIFIER)) {
      const specifier = match[1]!;
      const resolved = specifier.startsWith('.') ? new URL(specifier, url).pathname : specifier;
      out.push({ file: name, specifier, resolved });
    }
  }
  return out;
}

/** The imports of platform/** that reach the payout module (relative or by any package path). */
export function platformImportsOfPayout(): string[] {
  const payout = PAYOUT_DIR.pathname;
  return platformImports()
    .filter(
      ({ specifier, resolved }) =>
        resolved.startsWith(payout) ||
        `${resolved}/` === payout ||
        /(^|\/)modules\/payout(\/|$)/.test(specifier),
    )
    .map(({ file, specifier }) => `${file}: ${specifier}`);
}
