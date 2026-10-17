import { isUtf8 } from 'node:buffer';
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// Independent oracle: task B2-01i §2/2b, funds-quote and pinned 02 §8.2 only.
// No implementation imports, database, generated implementation data or test-time codegen.
const root = new URL('../../../', import.meta.url);
const expectedUrl = new URL('./expected.csv', import.meta.url);
const actualUrl = new URL('specs/ledger-templates.csv', root);
const markdownUrl = new URL('specs/ledger-rules.md', root);
const tbd = 'TBD(08 未定)';
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
type Column = (typeof columns)[number];
type Row = Record<Column, string>;
const comparedColumns = columns.filter((column) => column !== 'note');
const amountRefs = [
  'share_fen',
  'platform_retain_fen',
  'n_fen',
  'reserve_fen',
  'clawback_fen',
  'adjust_fen',
  'withdraw_fen',
  'fee_fen',
  'writeoff_fen',
  'restore_fen',
  'reassign_fen',
  'admin_adjust_fen',
  'closing_balance_fen',
];
const subjects = [
  'USER_BALANCE',
  'UNION_RECEIVABLE:{platform}',
  'CASH_ALIPAY',
  'CASH_WECHAT',
  'CASH_BANK',
  'COMMISSION_REVENUE',
  'FEE_INCOME',
  'TAX_PAYABLE',
  'MKT_EXPENSE',
  'BAD_DEBT',
];

function requiredText(url: URL): string {
  // A missing draft is an assertion failure, never ENOENT during test collection.
  expect(existsSync(url), `缺少待交付规格：${url.pathname}`).toBe(true);
  const bytes = readFileSync(url);
  expect(isUtf8(bytes), `${url.pathname} 必须是 UTF-8`).toBe(true);
  return bytes.toString('utf8').replace(/^\uFEFF/, '');
}

function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += char;
      }
    } else if (char === ',') {
      record.push(field);
      field = '';
      closedQuote = false;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      closedQuote = false;
    } else if (char === '"') {
      expect(field, '引号必须位于字段起始').toBe('');
      expect(closedQuote, '闭引号后只能接分隔符').toBe(false);
      quoted = true;
    } else {
      expect(closedQuote, '闭引号后只能接分隔符').toBe(false);
      field += char;
    }
  }
  expect(quoted, 'CSV 不得有未闭合引号').toBe(false);
  if (record.length > 0 || field !== '' || closedQuote) records.push([...record, field]);
  return records;
}

function readRows(url: URL): Row[] {
  const [header, ...records] = parseCsv(requiredText(url));
  expect(header, '固定列及顺序').toEqual(columns);
  expect(records.length, '不得交付空模板表').toBeGreaterThan(0);
  return records.map((record, index) => {
    expect(record.length, `CSV 第 ${index + 2} 行列数`).toBe(columns.length);
    return Object.fromEntries(columns.map((column, col) => [column, record[col]])) as Row;
  });
}

function rowKey(row: Row): string {
  return `${row.template_id}\u0000${row.line}`;
}

function indexRows(rows: Row[]): Map<string, Row> {
  const indexed = new Map(rows.map((row) => [rowKey(row), row]));
  expect(indexed.size, 'template_id + line 必须唯一').toBe(rows.length);
  return indexed;
}

function grouped(rows: Row[]): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const group = groups.get(row.template_id) ?? [];
    group.push(row);
    groups.set(row.template_id, group);
  }
  return groups;
}

function oracleRow(expected: Map<string, Row>, row: Row): Row {
  const match = expected.get(rowKey(row));
  expect(match, `未约定模板行 ${row.template_id} #${row.line}`).toBeDefined();
  return match!;
}

function contractValues(name: string): string[] {
  const yaml = requiredText(new URL('contracts/enums/fund.yaml', root));
  // Only the named enum's indented values block, never descriptions or other enums.
  const section = yaml.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  \\w+:|$(?![\\s\\S]))`, 'm'),
  );
  expect(section, `契约缺少 ${name}`).not.toBeNull();
  const values = [...section![1]!.matchAll(/^      ([A-Za-z_]+):/gm)].map((match) => match[1]!);
  expect(values.length).toBeGreaterThan(0);
  return values;
}

it('[AC-B2-01i#1] CSV 固定十一列、按模板升序、行号从一连续且键唯一', () => {
  const rows = readRows(actualUrl);
  indexRows(rows);
  const ids = rows.map((row) => row.template_id);
  expect(ids).toEqual([...ids].sort());
  for (const [id, group] of grouped(rows)) {
    expect(id).not.toBe('');
    expect(
      group.map((row) => row.line),
      id,
    ).toEqual(group.map((_, index) => String(index + 1)));
    expect(group.length, id).toBeGreaterThanOrEqual(2);
  }
});

it('[AC-B2-01i#2] 按 template_id + line 与独立 expected.csv 逐格相等，仅 note 不比对', () => {
  const actual = indexRows(readRows(actualUrl));
  const expected = indexRows(readRows(expectedUrl));
  expect([...actual.keys()].sort(), '禁止漏行或新增未经规则定义的行').toEqual(
    [...expected.keys()].sort(),
  );
  for (const [key, expectedRow] of expected) {
    const actualRow = actual.get(key);
    expect(actualRow, key).toBeDefined();
    for (const column of comparedColumns) {
      expect(actualRow![column], `${expectedRow.template_id} #${expectedRow.line} ${column}`).toBe(
        expectedRow[column],
      );
    }
  }
});

it('[AC-B2-01i#3] 已定 ledger_type 与 sub_type 只取契约值，覆盖全部十三类', () => {
  const rows = readRows(actualUrl);
  const expected = indexRows(readRows(expectedUrl));
  const types = contractValues('ledger_type');
  expect(types).toHaveLength(13);
  const subtypes = new Map([
    ['REFERRAL_CREDIT', contractValues('referral_credit_sub_type')],
    ['CLAWBACK', contractValues('clawback_sub_type')],
    ['SETTLE_ADJUST', contractValues('settle_adjust_sub_type')],
    ['REWARD', contractValues('reward_sub_type')],
    ['ADMIN_ADJUST', contractValues('admin_adjust_sub_type')],
  ]);
  for (const row of rows) {
    if (row.ledger_type === tbd) {
      expect(oracleRow(expected, row).ledger_type).toBe(tbd);
    } else {
      expect(types, row.template_id).toContain(row.ledger_type);
      expect(subtypes.get(row.ledger_type) ?? [''], row.template_id).toContain(row.sub_type);
    }
  }
  expect(
    [...new Set(rows.map((row) => row.ledger_type).filter((type) => type !== tbd))].sort(),
  ).toEqual([...types].sort());
});

it('[AC-B2-01i#4] 每模板每种金额符号均借贷成对，分录借正贷负且不使用数值金额', () => {
  const rows = readRows(actualUrl);
  const expected = indexRows(readRows(expectedUrl));
  for (const [id, group] of grouped(rows)) {
    expect(group.length, id).toBeGreaterThanOrEqual(2);
    const counts = new Map<string, { debit: number; credit: number }>();
    for (const row of group) {
      expect(['debit', 'credit'], id).toContain(row.sign);
      if (row.amount_ref === tbd) expect(oracleRow(expected, row).amount_ref).toBe(tbd);
      else expect(amountRefs, id).toContain(row.amount_ref);
      const count = counts.get(row.amount_ref) ?? { debit: 0, credit: 0 };
      if (row.sign === 'debit') count.debit += 1;
      else count.credit += 1;
      counts.set(row.amount_ref, count);
    }
    for (const [amount, count] of counts) {
      expect(count.debit, `${id} / ${amount}`).toBeGreaterThan(0);
      expect(count.debit, `${id} / ${amount} 符号系数合计必须为零`).toBe(count.credit);
    }
  }
});

it('[AC-B2-01i#5] 单一用户科目及子户合法，待定格不得扩大到已定字段', () => {
  const rows = readRows(actualUrl);
  const expected = indexRows(readRows(expectedUrl));
  for (const row of rows) {
    for (const column of comparedColumns) {
      expect(row[column] === tbd, `${row.template_id} ${column} 的待定状态`).toBe(
        oracleRow(expected, row)[column] === tbd,
      );
    }
    if (row.account_owner !== tbd) expect(['user', 'platform']).toContain(row.account_owner);
    if (row.subject !== tbd) expect(subjects).toContain(row.subject);
    if (row.sub_account !== tbd) expect(['available', 'frozen']).toContain(row.sub_account);
    if (row.account_owner === 'user') expect(row.subject).toBe('USER_BALANCE');
    if (row.account_owner === 'platform') expect(row.subject).not.toBe('USER_BALANCE');
  }
});

it('[AC-B2-01i#6] 红冲逐行沿用原科目金额与类型，符号反转且原键只追加一次 REVERSE', () => {
  const rows = readRows(actualUrl);
  const originals = indexRows(rows);
  const reversals = rows.filter((row) => row.template_id.endsWith(':REVERSE'));
  expect(reversals.length).toBeGreaterThan(0);
  for (const row of reversals) {
    const originalId = row.template_id.slice(0, -':REVERSE'.length);
    const original = originals.get(`${originalId}\u0000${row.line}`);
    expect(original, originalId).toBeDefined();
    expect(row.uniq_key_pattern).toBe(`${original!.uniq_key_pattern}:REVERSE`);
    expect(row.uniq_key_pattern).not.toContain(':REVERSE:REVERSE');
    for (const column of [
      'ledger_type',
      'sub_type',
      'account_owner',
      'subject',
      'sub_account',
      'amount_ref',
    ] as const) {
      expect(row[column], `${row.template_id} ${column}`).toBe(original![column]);
    }
    expect(row.sign).toBe(original!.sign === 'debit' ? 'credit' : 'debit');
  }
});

it('[AC-B2-01i#7] 人读规格可索引每个模板、科目与已定幂等键', () => {
  const markdown = requiredText(markdownUrl);
  const expected = readRows(expectedUrl);
  for (const id of new Set(expected.map((row) => row.template_id)))
    expect(markdown, id).toContain(id);
  for (const subject of subjects) expect(markdown, subject).toContain(subject);
  for (const key of new Set(
    expected.map((row) => row.uniq_key_pattern).filter((key) => key !== tbd),
  ))
    expect(markdown, key).toContain(key);
  expect(markdown).toMatch(/科目/);
  expect(markdown).toContain('uniq_key');
  expect(markdown).toMatch(/借贷|借.*贷/);
  expect(markdown).toMatch(/红冲/);
  expect(markdown).toMatch(/口径/);
});

it('[AC-B2-01i#8] 文档显式列出待定格、财务确认白名单与银行通道限制', () => {
  const markdown = requiredText(markdownUrl);
  const pending = markdown.match(/^#{1,6} [^\n]*待定[^\n]*\n([\s\S]*?)(?=^#{1,6} |$(?![\s\S]))/m);
  expect(pending, '须有独立待定节').not.toBeNull();
  for (const term of [
    tbd,
    'ledger_type',
    'sub_account',
    'net_fen',
    'tax_fen',
    'REASSIGN',
    'REWARD',
    '回款',
    '白名单',
  ]) {
    expect(pending![1], `待定节解释 ${term}`).toContain(term);
  }
  expect(markdown).toContain('待财务确认');
  expect(markdown).toContain('银行卡通道开通前不使用');
  expect(markdown).toContain('booked_n_fen');
  expect(markdown).toContain('BR-CALC-02');
  expect(markdown).toMatch(/补贴[^\n]*(待|验证)/);
});

it('[AC-B2-01i#9] 口径说明包含租户幂等、账户所有者、整数分与时钟会计日', () => {
  const markdown = requiredText(markdownUrl);
  for (const term of [
    'app_id',
    'owner_id',
    'platform',
    'order_key',
    'packages/money',
    'Clock',
    '00:00',
    '+08:00',
    'balance_after_fen',
  ])
    expect(markdown, term).toContain(term);
  expect(markdown).toMatch(/借[^\n]*正/);
  expect(markdown).toMatch(/贷[^\n]*负/);
  expect(markdown).toMatch(/(整数|bigint)[^\n]*分|分[^\n]*(整数|bigint)/);
  expect(markdown).toMatch(/(只插入|仅插入|INSERT)/);
  expect(markdown).toMatch(/(同一|同个)[^\n]*事务/);
});

it('[AC-B2-01i#10] 红冲与提现说明保留整笔限制、单张成功凭证和无分录迁移', () => {
  const markdown = requiredText(markdownUrl);
  expect(markdown).toMatch(/(整笔|全额)[^\n]*红冲|红冲[^\n]*(整笔|全额)/);
  expect(markdown).toMatch(/(不支持|禁止|不得|不能)[^\n]*部分红冲/);
  expect(markdown).toMatch(/红冲单[^\n]*(不得|不能|不可)[^\n]*红冲/);
  expect(markdown).toContain('ADJ:{adjust_id}:REVERSE');
  expect(markdown).toMatch(/(一张|单张|同一张)[^\n]*凭证/);
  expect(markdown).toMatch(/(金额为 0|零金额|金额为零)[^\n]*(不写|省略)/);
  for (const transition of ['W2', 'W4', 'W7', 'W9', 'W11']) expect(markdown).toContain(transition);
  expect(markdown).toMatch(/不(写|产生)[^\n]*分录/);
  expect(markdown).toContain('WITHDRAW_IN_TRANSIT');
});
