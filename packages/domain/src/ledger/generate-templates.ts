/**
 * Build-tool entry, not a runtime domain export (B2-01j). CLI:
 *   node packages/domain/src/ledger/generate-templates.ts            write templates.gen.ts
 *   node packages/domain/src/ledger/generate-templates.ts --verify   compare only; exit 1 if stale
 *
 * Reads specs/ledger-templates.csv relative to this module, preserves every cell including
 * TBD, and deterministically generates the adjacent templates.gen.ts. There is no second
 * handwritten template table: buildVouchers reads only the generated rows.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSV_URL = new URL('../../../../specs/ledger-templates.csv', import.meta.url);
const TARGET_URL = new URL('./templates.gen.ts', import.meta.url);
const GENERATE_COMMAND = 'node packages/domain/src/ledger/generate-templates.ts';

export const LEDGER_TEMPLATE_CSV_COLUMNS: readonly string[] = [
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
];

export class LedgerTemplatesError extends Error {
  constructor(message: string) {
    super(`ledger-templates: ${message}`);
    this.name = 'LedgerTemplatesError';
  }
}

/** RFC 4180 subset: quoted fields, doubled quotes, embedded newlines, BOM and CRLF. */
function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
    } else if (char === '"') {
      if (field !== '') throw new LedgerTemplatesError('quote inside an unquoted field');
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      records.push([...row, field]);
      row = [];
      field = '';
    } else field += char;
  }
  if (quoted) throw new LedgerTemplatesError('unclosed CSV quote');
  if (row.length > 0 || field !== '') records.push([...row, field]);
  return records;
}

/** Pure: the same CSV text always renders the same module text. Cells are kept verbatim. */
export function renderLedgerTemplates(csvText: string): string {
  const records = parseCsv(csvText);
  const header = records.shift();
  if (JSON.stringify(header) !== JSON.stringify(LEDGER_TEMPLATE_CSV_COLUMNS)) {
    throw new LedgerTemplatesError('unexpected CSV header');
  }
  if (records.length === 0) throw new LedgerTemplatesError('CSV has no template rows');
  const rows = records.map((record, index) => {
    if (record.length !== LEDGER_TEMPLATE_CSV_COLUMNS.length) {
      throw new LedgerTemplatesError(`row ${index + 2} has ${record.length} cells`);
    }
    const cells = LEDGER_TEMPLATE_CSV_COLUMNS.map(
      (column, i) => `${column}: ${JSON.stringify(record[i])}`,
    );
    return `  { ${cells.join(', ')} },`;
  });
  const fields = LEDGER_TEMPLATE_CSV_COLUMNS.map((column) => `  readonly ${column}: string;`);
  return [
    '// 生成物，勿手改。来源：specs/ledger-templates.csv（B2-01i；逐格原样保留，含 TBD）。',
    `// 改 csv 后重新生成：${GENERATE_COMMAND}（--verify 只比对）。`,
    '',
    'export interface LedgerTemplateRow {',
    ...fields,
    '}',
    '',
    'export const LEDGER_TEMPLATE_ROWS: readonly LedgerTemplateRow[] = [',
    ...rows,
    '];',
    '',
  ].join('\n');
}

/**
 * Writes templates.gen.ts, or with --verify only compares. A missing or stale generated file
 * under --verify throws LedgerTemplatesError (the CLI turns it into exit code 1).
 */
export function generateLedgerTemplates(args: readonly string[]): void {
  const unknown = args.filter((arg) => arg !== '--verify');
  if (unknown.length > 0) {
    throw new LedgerTemplatesError(`unknown argument(s): ${unknown.join(' ')}`);
  }
  const verify = args.includes('--verify');
  const expected = renderLedgerTemplates(readFileSync(CSV_URL, 'utf8'));
  const current = existsSync(TARGET_URL) ? readFileSync(TARGET_URL, 'utf8') : null;
  if (current === expected) return;
  if (verify) {
    throw new LedgerTemplatesError(`templates.gen.ts is missing or stale; run ${GENERATE_COMMAND}`);
  }
  writeFileSync(TARGET_URL, expected);
}

function isEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  try {
    generateLedgerTemplates(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
