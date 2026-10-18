import { readFileSync } from 'node:fs';
import { validateVoucher, type BuildVoucherParams, type BuiltVoucher } from '@couli/domain';

const columns = [
  'template_id',
  'ledger_type',
  'sub_type',
  'uniq_key_pattern',
  'line',
  'account_owner',
  'subject',
  'sub_account',
  'sign',
  'amount_ref',
  'note',
] as const;
export type TemplateRow = Record<(typeof columns)[number], string>;

// Independent CSV oracle, never imported from the implementation or its generated data.
// Supports quoted notes, doubled quotes, embedded newlines, BOM and CRLF.
export function readTemplates(): Map<string, TemplateRow[]> {
  const text = readFileSync(
    new URL('../../../../specs/ledger-templates.csv', import.meta.url),
    'utf8',
  ).replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (!quoted && char === ',') {
      row.push(field);
      field = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      records.push([...row, field]);
      row = [];
      field = '';
    } else field += char;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (row.length > 0 || field !== '') records.push([...row, field]);
  if (JSON.stringify(records.shift()) !== JSON.stringify(columns)) {
    throw new Error('Unexpected ledger CSV header');
  }
  const templates = new Map<string, TemplateRow[]>();
  for (const record of records) {
    if (record.length !== columns.length) throw new Error('Unexpected ledger CSV width');
    const item = Object.fromEntries(columns.map((column, i) => [column, record[i]])) as TemplateRow;
    const group = templates.get(item.template_id) ?? [];
    group.push(item);
    templates.set(item.template_id, group);
  }
  return templates;
}

export function isTbd(rows: readonly TemplateRow[]): boolean {
  return rows.some((row) => Object.values(row).some((cell) => cell.includes('TBD')));
}

export function executableTemplates(): [string, TemplateRow[]][] {
  return [...readTemplates()].filter(([, rows]) => !isTbd(rows));
}

export function parameters(rows: readonly TemplateRow[], amount = 617n): BuildVoucherParams {
  const params: Record<string, string | bigint> = {};
  for (const row of rows) {
    if (!row.amount_ref.includes('TBD')) params[row.amount_ref] = amount;
    for (const cell of [row.uniq_key_pattern, row.subject]) {
      for (const match of cell.matchAll(/\{([^}]+)\}/g)) {
        const name = match[1]!;
        params[name] =
          name === 'order_key'
            ? 'taobao:1234567'
            : name === 'platform'
              ? 'taobao'
              : name === 'role'
                ? 'self'
                : `${name}-42`;
      }
    }
    if (row.account_owner === 'user') params['user_id'] = 'user-42';
  }
  const templateId = rows[0]?.template_id;
  if ('role' in params) {
    if (templateId === 'CREDIT:DIRECT') params['role'] = 'direct';
    if (templateId === 'CREDIT:INDIRECT') params['role'] = 'indirect';
    if (templateId === 'CREDIT:SHARE') params['role'] = 'share';
  }
  return params;
}

export function substitute(pattern: string, params: BuildVoucherParams): string {
  return pattern.replace(/\{([^}]+)\}/g, (_match: string, name: string) => {
    const value = params[name];
    if (typeof value !== 'string') throw new Error(`Missing oracle placeholder: ${name}`);
    return value;
  });
}

// Group by (ledger_type, sub_type, filled uniq_key), preserving multiplicity, ignoring line order.
export function csvGroups(rows: readonly TemplateRow[], params: BuildVoucherParams): string[] {
  return rows
    .flatMap((row) => {
      const amount = params[row.amount_ref];
      if (typeof amount !== 'bigint') throw new Error('Missing oracle amount');
      if (amount === 0n) return [];
      return [
        JSON.stringify([
          row.ledger_type,
          row.sub_type === '' ? null : row.sub_type,
          substitute(row.uniq_key_pattern, params),
          row.account_owner,
          row.account_owner === 'user' ? params['user_id'] : 'platform',
          substitute(row.subject, params),
          row.sub_account === '' ? null : row.sub_account,
          String(row.sign === 'debit' ? amount : -amount),
        ]),
      ];
    })
    .sort();
}

export function voucherGroups(vouchers: readonly BuiltVoucher[]): string[] {
  return vouchers
    .flatMap((voucher) =>
      voucher.entries.map((entry) =>
        JSON.stringify([
          entry.ledger_type,
          entry.sub_type,
          voucher.uniq_key,
          entry.account.owner_type,
          entry.account.owner_id,
          entry.account.subject,
          entry.sub_account,
          String(entry.amount_fen),
        ]),
      ),
    )
    .sort();
}

export function validVouchers(vouchers: readonly BuiltVoucher[]): boolean {
  return vouchers.every(
    (voucher) =>
      validateVoucher(
        voucher.entries.map((entry) => ({
          account_id: JSON.stringify(entry.account),
          account_code: entry.account.subject,
          sub_account: entry.sub_account,
          amount_fen: entry.amount_fen,
        })),
      ).ok && voucher.entries.reduce((sum, entry) => sum + entry.amount_fen, 0n) === 0n,
  );
}

export function reversedGroups(vouchers: readonly BuiltVoucher[]): string[] {
  return voucherGroups(
    vouchers.map((voucher) => ({
      uniq_key: `${voucher.uniq_key}:REVERSE`,
      entries: voucher.entries.map((entry) => ({ ...entry, amount_fen: -entry.amount_fen })),
    })),
  );
}

export function rejectsRangeError(action: () => unknown): boolean {
  try {
    action();
    return false;
  } catch (error) {
    // Do not mistake NotImplemented, TypeError or unrelated failures for validation.
    if (!(error instanceof RangeError)) throw error;
    return true;
  }
}
