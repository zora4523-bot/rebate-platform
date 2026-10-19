// Pure parts of the daily check (BR-FUND-19): file order, the single-statement guard and the
// reading of the unified invariant output (invariant, checked_rows, scope, app_id, account_id,
// detail). Anything outside that contract throws: a malformed result is never zero differences.
import type { LedgerDifference, LedgerInvariantFile } from './daily-check-types.ts';
import { LedgerError } from './errors.ts';

export interface InvariantOutcome {
  readonly invariant: string;
  readonly checkedRows: bigint;
  /** Differences of every app (filtering by appId is the runner's). */
  readonly differences: readonly LedgerDifference[];
}

/** Ascending file name by UTF-16 code units (locale-independent, like Array#sort). */
export function orderInvariantFiles(
  files: readonly LedgerInvariantFile[],
): readonly LedgerInvariantFile[] {
  const seen = new Set<string>();
  for (const file of files) {
    if (typeof file.name !== 'string' || file.name === '' || typeof file.sql !== 'string') {
      throw new LedgerError('INVALID_INPUT', 'invariant file without a name or SQL text');
    }
    if (seen.has(file.name)) {
      throw new LedgerError('INVALID_INPUT', `invariant file ${file.name} listed twice`);
    }
    seen.add(file.name);
  }
  return [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Removes comments, string literals and quoted identifiers, then requires at most one trailing
 * ';'. A statement list ("SELECT …; COMMIT; UPDATE …") would run through the simple query
 * protocol and could leave the read-only transaction, so it is refused before execution.
 */
export function assertSingleStatement(file: LedgerInvariantFile): void {
  const stripped = file.sql.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g,
    ' ',
  );
  const body = stripped.trim().replace(/;\s*$/, '');
  if (body === '' || body.includes(';')) {
    throw new LedgerError('INVALID_INPUT', `invariant file ${file.name} must be one statement`);
  }
}

function malformed(file: string, what: string): LedgerError {
  return new LedgerError('DAILY_CHECK_FAILED', `invariant file ${file}: ${what}`);
}

function readCheckedRows(file: string, value: unknown): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) throw malformed(file, 'negative checked_rows');
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw malformed(file, 'checked_rows must be a non-negative bigint');
}

function readOptionalText(file: string, column: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value === '') {
    throw malformed(file, `${column} must be text or null`);
  }
  return value;
}

/**
 * At least one row is mandatory (the clean sentinel has scope 'none'); every row carries the
 * same invariant and checked_rows. 'account' rows need app_id and account_id, 'global' rows
 * need app_id; 'none' rows are sentinels and report nothing.
 */
export function readInvariantRows(file: string, rows: unknown): InvariantOutcome {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw malformed(file, 'returned no rows (a sentinel row is mandatory)');
  }
  let invariant: string | undefined;
  let checkedRows: bigint | undefined;
  const differences: LedgerDifference[] = [];
  for (const raw of rows as unknown[]) {
    if (typeof raw !== 'object' || raw === null) throw malformed(file, 'row is not an object');
    const row = raw as Record<string, unknown>;
    const code = row['invariant'];
    if (typeof code !== 'string' || code === '') throw malformed(file, 'invariant must be text');
    const count = readCheckedRows(file, row['checked_rows']);
    if (invariant === undefined || checkedRows === undefined) {
      invariant = code;
      checkedRows = count;
    } else if (invariant !== code || checkedRows !== count) {
      throw malformed(file, 'rows disagree on invariant or checked_rows');
    }
    const scope = row['scope'];
    const appId = readOptionalText(file, 'app_id', row['app_id']);
    const accountId = readOptionalText(file, 'account_id', row['account_id']);
    if (scope === 'none') continue;
    if (scope !== 'account' && scope !== 'global') {
      throw malformed(file, `unknown scope ${JSON.stringify(scope)}`);
    }
    if (appId === null) throw malformed(file, `${scope} difference without app_id`);
    if (scope === 'account' && accountId === null) {
      throw malformed(file, 'account difference without account_id');
    }
    differences.push({
      invariant: code,
      scope,
      app_id: appId,
      account_id: accountId,
      detail: row['detail'] ?? null,
    });
  }
  if (invariant === undefined || checkedRows === undefined) {
    throw malformed(file, 'returned no rows (a sentinel row is mandatory)');
  }
  return { invariant, checkedRows, differences };
}
