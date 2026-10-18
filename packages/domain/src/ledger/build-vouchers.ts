// B2-01j: voucher entries from specs/ledger-templates.csv (via generated templates.gen.ts).
// BR-FUND-05/15/16, BR-WDR-09. Pure: no clock, no I/O, inputs are never mutated.
import { addFen, InvalidAmount, subFen } from '@couli/money';
import { orderKey, uniqKey, validateVoucher, type LedgerRole } from './ledger.ts';
import { LEDGER_TEMPLATE_ROWS, type LedgerTemplateRow } from './templates.gen.ts';

/** Domain account reference; persistence resolves this to an account_id within app_id. */
export interface VoucherAccount {
  readonly owner_type: 'user' | 'platform';
  readonly owner_id: string;
  /** Includes the platform suffix where the CSV has UNION_RECEIVABLE:{platform}. */
  readonly subject: string;
}

export interface BuiltVoucherEntry {
  readonly account: VoucherAccount;
  readonly sub_account: 'available' | 'frozen' | null;
  readonly amount_fen: bigint;
  readonly ledger_type: string;
  readonly sub_type: string | null;
}

export interface BuiltVoucher {
  readonly uniq_key: string;
  readonly entries: readonly BuiltVoucherEntry[];
}

/**
 * Flat CSV placeholder names and amount_ref names. User rows additionally require
 * user_id, even when the key (e.g. withdrawal_id) does not contain it. No aliases.
 * Amounts are nonnegative bigint fen within PG int64; key components are strings.
 */
export type BuildVoucherParams = Readonly<Record<string, string | bigint>>;

const TBD_MARK = 'TBD';
const REVERSE_SUFFIX = ':REVERSE';
const USER_ID = 'user_id';
const PLATFORM_OWNER_ID = 'platform';
const ROLES: readonly string[] = ['self', 'share', 'direct', 'indirect'];
const PLACEHOLDER = /\{([^{}]+)\}/g;

/** Templates grouped by id, CSV row order preserved. A Map so '__proto__' etc. are not ids. */
const TEMPLATES: ReadonlyMap<string, readonly LedgerTemplateRow[]> = groupTemplates();

function groupTemplates(): Map<string, LedgerTemplateRow[]> {
  const map = new Map<string, LedgerTemplateRow[]>();
  for (const row of LEDGER_TEMPLATE_ROWS) {
    const group = map.get(row.template_id);
    if (group === undefined) map.set(row.template_id, [row]);
    else group.push(row);
  }
  return map;
}

function isTbdTemplate(rows: readonly LedgerTemplateRow[]): boolean {
  return rows.some((row) => Object.values(row).some((cell) => cell.includes(TBD_MARK)));
}

function placeholders(pattern: string): string[] {
  return [...pattern.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
}

/** One key component: nonempty string without ':' (same rule as orderKey/uniqKey). */
function keyComponent(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '' || value.includes(':')) {
    throw new RangeError(`${name} must be a nonempty string without ':'`);
  }
  return value;
}

/** Nonnegative bigint fen within PG int64; range checked by @couli/money. */
function amountParam(value: unknown, name: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new RangeError(`${name} must be nonnegative bigint fen`);
  }
  try {
    return addFen(value, 0n);
  } catch (error) {
    if (error instanceof InvalidAmount) {
      throw new RangeError(`${name} exceeds the PG bigint range`, { cause: error });
    }
    throw error;
  }
}

/** Validate one key placeholder value and return it in canonical form. */
function keyParam(value: unknown, name: string): string {
  if (name === 'order_key') {
    if (typeof value !== 'string') throw new RangeError('order_key must be a string');
    const parts = value.split(':');
    if (parts.length !== 2) throw new RangeError('order_key must be {platform}:{sub_order_id}');
    return orderKey(parts[0] ?? '', parts[1] ?? '');
  }
  if (name === 'role') {
    if (typeof value !== 'string' || !ROLES.includes(value)) {
      throw new RangeError('role must be one of self|share|direct|indirect');
    }
    return value;
  }
  return keyComponent(value, name);
}

interface Resolved {
  readonly keys: ReadonlyMap<string, string>;
  readonly amounts: ReadonlyMap<string, bigint>;
}

/** Exactly the parameters the template needs: none missing, none extra, all well-formed. */
function resolveParams(rows: readonly LedgerTemplateRow[], params: unknown): Resolved {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new RangeError('params must be an object');
  }
  const record = params as Readonly<Record<string, unknown>>;
  const amountNames = new Set<string>();
  const keyNames = new Set<string>();
  for (const row of rows) {
    amountNames.add(row.amount_ref);
    for (const name of [...placeholders(row.uniq_key_pattern), ...placeholders(row.subject)]) {
      keyNames.add(name);
    }
    if (row.account_owner === 'user') keyNames.add(USER_ID);
  }
  for (const name of amountNames) {
    if (keyNames.has(name)) throw new Error(`template uses ${name} as amount and key`);
  }
  for (const name of Object.keys(record)) {
    if (!amountNames.has(name) && !keyNames.has(name)) {
      throw new RangeError(`unexpected parameter: ${name}`);
    }
  }
  const keys = new Map<string, string>();
  for (const name of keyNames) {
    if (!Object.hasOwn(record, name)) throw new RangeError(`missing parameter: ${name}`);
    keys.set(name, keyParam(record[name], name));
  }
  const amounts = new Map<string, bigint>();
  for (const name of amountNames) {
    if (!Object.hasOwn(record, name)) throw new RangeError(`missing parameter: ${name}`);
    amounts.set(name, amountParam(record[name], name));
  }
  return { keys, amounts };
}

function substitute(pattern: string, keys: ReadonlyMap<string, string>): string {
  return pattern.replace(PLACEHOLDER, (_match: string, name: string) => {
    const value = keys.get(name);
    if (value === undefined) throw new Error(`unresolved placeholder: ${name}`);
    return value;
  });
}

function role(keys: ReadonlyMap<string, string>): LedgerRole {
  return keys.get('role') as LedgerRole;
}

function requireKey(keys: ReadonlyMap<string, string>, name: string): string {
  const value = keys.get(name);
  if (value === undefined) throw new Error(`unresolved placeholder: ${name}`);
  return value;
}

/** Fill uniq_key_pattern; the BR-FUND-05/16 formats owned by uniqKey go through it. */
function fillUniqKey(pattern: string, keys: ReadonlyMap<string, string>): string {
  if (pattern.endsWith(REVERSE_SUFFIX)) {
    const original = fillUniqKey(pattern.slice(0, -REVERSE_SUFFIX.length), keys);
    return uniqKey({ kind: 'REVERSE', original_uniq_key: original });
  }
  const key = (name: string): string => requireKey(keys, name);
  switch (pattern) {
    case '{order_key}:{user_id}:{role}:CREDIT':
      return uniqKey({
        kind: 'CREDIT',
        order_key: key('order_key'),
        user_id: key('user_id'),
        role: role(keys),
      });
    case '{order_key}:PLATFORM:CREDIT':
      return uniqKey({ kind: 'PLATFORM_CREDIT', order_key: key('order_key') });
    case '{order_key}:PLATFORM:FORFEIT:{uid}:{role}':
      return uniqKey({
        kind: 'PLATFORM_FORFEIT',
        order_key: key('order_key'),
        user_id: key('uid'),
        role: role(keys),
      });
    case '{order_key}:PLATFORM:FORFEIT:{uid}:{role}:REASSIGN:{reassign_id}':
      return uniqKey({
        kind: 'PLATFORM_FORFEIT',
        order_key: key('order_key'),
        user_id: key('uid'),
        role: role(keys),
        reassign_id: key('reassign_id'),
      });
    case '{order_key}:{user_id}:{role}:CLAWBACK:{rights_event_id}':
      return uniqKey({
        kind: 'CLAWBACK',
        order_key: key('order_key'),
        user_id: key('user_id'),
        role: role(keys),
        rights_event_id: key('rights_event_id'),
      });
    case '{order_key}:PLATFORM:CLAWBACK:{rights_event_id}':
      return uniqKey({
        kind: 'PLATFORM_CLAWBACK',
        order_key: key('order_key'),
        rights_event_id: key('rights_event_id'),
      });
    default:
      // Other CSV formats (wd:…, ADJ:…, BADDEBT:…) from validated colon-free components.
      return substitute(pattern, keys);
  }
}

function owner(row: LedgerTemplateRow): 'user' | 'platform' {
  if (row.account_owner === 'user' || row.account_owner === 'platform') return row.account_owner;
  throw new Error(`template ${row.template_id} line ${row.line}: bad account_owner`);
}

function subAccount(row: LedgerTemplateRow): 'available' | 'frozen' | null {
  if (row.sub_account === '') return null;
  if (row.sub_account === 'available' || row.sub_account === 'frozen') return row.sub_account;
  throw new Error(`template ${row.template_id} line ${row.line}: bad sub_account`);
}

/** BR-FUND-16: debit positive, credit negative. */
function signed(row: LedgerTemplateRow, amount: bigint): bigint {
  if (row.sign === 'debit') return amount;
  if (row.sign === 'credit') return subFen(0n, amount);
  throw new Error(`template ${row.template_id} line ${row.line}: bad sign`);
}

/**
 * Uses templates.gen.ts, generated ONLY from specs/ledger-templates.csv by the
 * adjacent generate-templates.ts build tool. No CSV reads or I/O at runtime.
 *
 * Rejects unknown IDs, any TBD cell in the entire template, missing/extra parameters,
 * malformed key components and invalid amounts with RangeError. Never infers TBDs.
 * Reuses orderKey/uniqKey for their supported key formats. Empty CSV sub_type is null.
 * Omits zero pairs; when no entries remain returns []. Rows sharing a filled uniq_key
 * form one voucher; every emitted voucher passes validateVoucher.
 */
export function buildVouchers(
  templateId: string,
  params: BuildVoucherParams,
): readonly BuiltVoucher[] {
  const rows = typeof templateId === 'string' ? TEMPLATES.get(templateId) : undefined;
  if (rows === undefined) throw new RangeError(`unknown ledger template: ${String(templateId)}`);
  if (isTbdTemplate(rows)) {
    throw new RangeError(`ledger template ${templateId} has TBD cells and cannot be used`);
  }
  const { keys, amounts } = resolveParams(rows, params);
  const grouped = new Map<string, BuiltVoucherEntry[]>();
  for (const row of rows) {
    const amount = amounts.get(row.amount_ref);
    if (amount === undefined) throw new Error(`unresolved amount: ${row.amount_ref}`);
    const uniq = fillUniqKey(row.uniq_key_pattern, keys);
    const ownerType = owner(row);
    const account: VoucherAccount = Object.freeze({
      owner_type: ownerType,
      owner_id: ownerType === 'user' ? requireKey(keys, USER_ID) : PLATFORM_OWNER_ID,
      subject: substitute(row.subject, keys),
    });
    const sub = subAccount(row);
    if (amount === 0n) continue;
    const entry: BuiltVoucherEntry = Object.freeze({
      account,
      sub_account: sub,
      amount_fen: signed(row, amount),
      ledger_type: row.ledger_type,
      sub_type: row.sub_type === '' ? null : row.sub_type,
    });
    const group = grouped.get(uniq);
    if (group === undefined) grouped.set(uniq, [entry]);
    else group.push(entry);
  }
  const vouchers: BuiltVoucher[] = [];
  for (const [uniq, entries] of grouped) {
    const check = validateVoucher(
      entries.map((entry) => ({
        account_id: JSON.stringify(entry.account),
        account_code: entry.account.subject,
        sub_account: entry.sub_account,
        amount_fen: entry.amount_fen,
      })),
    );
    if (!check.ok) {
      throw new RangeError(`voucher ${uniq} is invalid: ${JSON.stringify(check.errors)}`);
    }
    vouchers.push(Object.freeze({ uniq_key: uniq, entries: Object.freeze(entries) }));
  }
  return Object.freeze(vouchers);
}
