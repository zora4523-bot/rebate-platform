import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  TABLES,
  TIMEOUT,
  accountRow,
  balanceRow,
  close,
  columns,
  entryRow,
  insert,
  open,
  parents,
  ready,
  sqlState,
  voucherRow,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-02c#1] 四表字段、金额 bigint、单一余额与可空结构化元数据', async () => {
  await ready(h.app);
  const shapes = {
    ledger_accounts: {
      id: 'uuid',
      app_id: 'text',
      owner_type: 'text',
      owner_id: 'text',
      subject: 'text',
    },
    ledger_vouchers: {
      id: 'uuid',
      app_id: 'text',
      biz_type: 'text',
      uniq_key: 'text',
      accounting_date: 'date',
    },
    ledger_entries: {
      id: 'int8',
      app_id: 'text',
      voucher_id: 'uuid',
      account_id: 'uuid',
      sub_account: 'text',
      amount_fen: 'int8',
      ledger_type: 'text',
      booked_at: 'timestamptz',
    },
    account_balances: {
      app_id: 'text',
      account_id: 'uuid',
      available_fen: 'int8',
      frozen_fen: 'int8',
    },
  };
  for (const [table, fields] of Object.entries(shapes)) {
    const found = await columns(h.app, table);
    for (const [name, type] of Object.entries(fields)) {
      expect(found, `${table}.${name}`).toContainEqual(
        expect.objectContaining({ name, type, nullable: 'NO' }),
      );
    }
    expect(found.map((c) => c.name)).not.toContain('account_type');
    for (const c of found.filter((c) => c.name.endsWith('_fen'))) expect(c.type).toBe('int8');
  }
  const vouchers = await columns(h.app, 'ledger_vouchers');
  for (const name of ['biz_id', 'operator', 'memo'])
    expect(vouchers.map((c) => c.name)).toContain(name);
  for (const name of ['order_key', 'beneficiary_user_id', 'role', 'voucher_kind']) {
    expect(vouchers).toContainEqual(expect.objectContaining({ name, nullable: 'YES' }));
  }
  const entries = await columns(h.app, 'ledger_entries');
  for (const name of ['sub_type', 'income_type']) {
    expect(entries).toContainEqual(
      expect.objectContaining({ name, type: 'text', nullable: 'YES' }),
    );
  }
  expect(entries).toContainEqual(
    expect.objectContaining({ name: 'balance_after_fen', type: 'int8', nullable: 'YES' }),
  );
  const balances = await columns(h.app, 'account_balances');
  expect(balances).toContainEqual(
    expect.objectContaining({ name: 'negative_since', type: 'date', nullable: 'YES' }),
  );
  for (const [found, name] of [
    [entries, 'account_version'],
    [balances, 'version'],
  ] as const) {
    const column = found.find((c) => c.name === name);
    expect(column).toBeDefined();
    expect(['int4', 'int8']).toContain(column?.type);
  }
  expect(balances.find((c) => c.name === 'version')?.nullable).toBe('NO');
});

it('[AC-B2-02c#2] booked_at 和 accounting_date 无 SQL 默认值且必须显式写入', async () => {
  await ready(h.app);
  const { account, voucher } = await parents(h.app);
  for (const [table, field, row] of [
    ['ledger_vouchers', 'accounting_date', voucherRow(account['app_id'])],
    ['ledger_entries', 'booked_at', entryRow(account, voucher)],
  ] as const) {
    expect((await columns(h.app, table)).find((c) => c.name === field)?.default_value).toBeNull();
    const omitted = { ...row };
    delete omitted[field];
    expect(await sqlState(insert(h.app, table, omitted))).toBe('23502');
    expect(await sqlState(insert(h.app, table, { ...row, [field]: null }))).toBe('23502');
  }
});

it('[AC-B2-02c#3] 同 app 同用户只有一个 USER_BALANCE，账户和凭证唯一键隔离 app', async () => {
  await ready(h.app);
  const { account, voucher } = await parents(h.app);
  expect(await sqlState(insert(h.app, 'ledger_accounts', { ...account, id: randomUUID() }))).toBe(
    '23505',
  );
  expect(await sqlState(insert(h.app, 'ledger_vouchers', { ...voucher, id: randomUUID() }))).toBe(
    '23505',
  );
  expect(
    await sqlState(
      insert(h.app, 'ledger_vouchers', {
        ...voucher,
        id: randomUUID(),
        accounting_date: '2032-07-01',
      }),
    ),
    '幂等键不能按会计日重新使用',
  ).toBe('23505');
  expect(
    await sqlState(
      insert(h.app, 'ledger_vouchers', {
        ...voucher,
        id: randomUUID(),
        uniq_key: `${String(voucher['uniq_key'])}:REVERSE`,
      }),
    ),
  ).toBe('ok');
  const other = `other-${randomUUID()}`;
  expect(
    await sqlState(
      insert(h.app, 'ledger_accounts', { ...account, id: randomUUID(), app_id: other }),
    ),
  ).toBe('ok');
  expect(
    await sqlState(
      insert(h.app, 'ledger_vouchers', { ...voucher, id: randomUUID(), app_id: other }),
    ),
  ).toBe('ok');
  expect(
    await sqlState(insert(h.app, 'ledger_accounts', accountRow({ app_id: account['app_id'] }))),
  ).toBe('ok');
  expect(await sqlState(insert(h.app, 'ledger_vouchers', voucherRow(account['app_id'])))).toBe(
    'ok',
  );
  expect(await sqlState(insert(h.app, 'account_balances', balanceRow(account)))).toBe('ok');
  expect(
    await sqlState(insert(h.app, 'account_balances', balanceRow(account, { version: 1 }))),
  ).toBe('23505');
});

it('[AC-B2-02c#4] 唯一约束在两个并发 INSERT 下仍只允许一个成功', async () => {
  await ready(h.app);
  const account = accountRow();
  const voucher = voucherRow(account['app_id']);
  for (const [table, row] of [
    ['ledger_accounts', account],
    ['ledger_vouchers', voucher],
  ] as const) {
    const results = await Promise.all(
      [0, 1].map(() => sqlState(insert(h.app, table, { ...row, id: randomUUID() }))),
    );
    expect(results.sort()).toEqual(['23505', 'ok']);
  }
});

it('[AC-B2-02c#5] 用户不能拆自购推广账户，平台科目接受带平台后缀的 subject', async () => {
  await ready(h.app);
  const { account } = await parents(h.app);
  for (const subject of ['USER_SELF', 'USER_PROMO', 'UNION_RECEIVABLE:taobao']) {
    expect(
      await sqlState(insert(h.app, 'ledger_accounts', { ...account, id: randomUUID(), subject })),
    ).toBe('23514');
  }
  for (const owner_type of ['other', 'USER', '']) {
    expect(await sqlState(insert(h.app, 'ledger_accounts', accountRow({ owner_type })))).toBe(
      '23514',
    );
  }
  expect(
    await sqlState(
      insert(
        h.app,
        'ledger_accounts',
        accountRow({
          owner_type: 'platform',
          owner_id: randomUUID(),
          subject: 'UNION_RECEIVABLE:taobao',
        }),
      ),
    ),
  ).toBe('23514');
  for (const subject of ['UNION_RECEIVABLE:taobao', 'UNION_RECEIVABLE:jd']) {
    expect(
      await sqlState(
        insert(
          h.app,
          'ledger_accounts',
          accountRow({
            app_id: account['app_id'],
            owner_type: 'platform',
            owner_id: 'platform',
            subject,
          }),
        ),
      ),
    ).toBe('ok');
  }
});

for (const field of ['frozen_fen', 'version'] as const) {
  it(`[AC-B2-02c#6] ${field} 拒绝 -1，接受 0 和 1，余额允许负 available`, async () => {
    await ready(h.app);
    const { account } = await parents(h.app);
    expect(
      await sqlState(insert(h.app, 'account_balances', balanceRow(account, { [field]: -1 }))),
    ).toBe('23514');
    expect(
      await sqlState(
        insert(h.app, 'account_balances', balanceRow(account, { available_fen: -1n })),
      ),
    ).toBe('ok');
    for (const value of [1, 0]) {
      expect(
        await sqlState(
          sql`UPDATE app.account_balances SET ${sql.ref(field)} = ${value}
        WHERE account_id = ${account['id']}`.execute(h.app),
        ),
      ).toBe('ok');
    }
    expect(
      await sqlState(
        sql`UPDATE app.account_balances SET ${sql.ref(field)} = -1
      WHERE account_id = ${account['id']}`.execute(h.app),
      ),
    ).toBe('23514');
    const stored = await sql<{ value: string }>`SELECT ${sql.ref(field)}::text AS value
      FROM app.account_balances WHERE account_id = ${account['id']}`.execute(h.app);
    expect(stored.rows).toEqual([{ value: '0' }]);
  });
}

it('[AC-B2-02c#7] 金额非零且保留正负号、超过 2^53 的整数分及平台空余额', async () => {
  await ready(h.app);
  const { account, voucher } = await parents(h.app);
  expect(
    await sqlState(insert(h.app, 'ledger_entries', entryRow(account, voucher, { amount_fen: 0n }))),
  ).toBe('23514');
  for (const amount of [-9007199254740993n, -1n, 1n, 9007199254740993n]) {
    expect(
      await sqlState(
        insert(
          h.app,
          'ledger_entries',
          entryRow(account, voucher, {
            amount_fen: amount,
            balance_after_fen: 9007199254740993n,
          }),
        ),
      ),
    ).toBe('ok');
  }
  const stored = await sql<{
    amount_fen: bigint;
    balance_after_fen: bigint;
  }>`SELECT amount_fen, balance_after_fen
    FROM app.ledger_entries WHERE voucher_id = ${voucher['id']} ORDER BY amount_fen`.execute(h.app);
  expect(stored.rows).toEqual(
    [-9007199254740993n, -1n, 1n, 9007199254740993n].map((amount_fen) => ({
      amount_fen,
      balance_after_fen: 9007199254740993n,
    })),
  );
  const platform = accountRow({
    app_id: account['app_id'],
    owner_type: 'platform',
    owner_id: 'platform',
    subject: 'UNION_RECEIVABLE:taobao',
  });
  expect(await sqlState(insert(h.app, 'ledger_accounts', platform))).toBe('ok');
  expect(
    await sqlState(
      insert(
        h.app,
        'ledger_entries',
        entryRow(platform, voucher, {
          amount_fen: 617n,
          balance_after_fen: null,
          account_version: null,
          income_type: null,
        }),
      ),
    ),
  ).toBe('ok');
});

it('[AC-B2-02c#8] ledger_type 接受契约全部 13 值，拒绝新增与旧类型；间推只用 sub_type', async () => {
  await ready(h.app);
  const source = readFileSync(
    new URL('../../../../../contracts/enums/fund.yaml', import.meta.url),
    'utf8',
  );
  const block = /^  ledger_type:\n([\s\S]*?)(?=^  \w+:)/m.exec(source)?.[1] ?? '';
  const types = [...block.matchAll(/^      ([A-Z_]+):/gm)].map((match) => match[1]!);
  expect(types).toHaveLength(13);
  const { account, voucher } = await parents(h.app);
  for (const ledger_type of types) {
    expect(
      await sqlState(insert(h.app, 'ledger_entries', entryRow(account, voucher, { ledger_type }))),
    ).toBe('ok');
  }
  for (const ledger_type of [
    'FOURTEENTH_TYPE',
    'INDIRECT_CREDIT',
    'SELF_REBATE',
    'rebate_credit',
    '',
  ]) {
    expect(
      await sqlState(insert(h.app, 'ledger_entries', entryRow(account, voucher, { ledger_type }))),
    ).toBe('23514');
  }
  expect(
    await sqlState(
      insert(
        h.app,
        'ledger_entries',
        entryRow(account, voucher, {
          ledger_type: 'REFERRAL_CREDIT',
          sub_type: 'INDIRECT',
        }),
      ),
    ),
  ).toBe('ok');
});

it('[AC-B2-02c#9] 子户仅 available / frozen，income_type 可空或为两种契约所得类型', async () => {
  await ready(h.app);
  const { account, voucher } = await parents(h.app);
  for (const sub_account of ['available', 'frozen']) {
    for (const income_type of [null, 'SERVICE_FEE', 'INCIDENTAL']) {
      expect(
        await sqlState(
          insert(h.app, 'ledger_entries', entryRow(account, voucher, { sub_account, income_type })),
        ),
      ).toBe('ok');
    }
  }
  for (const sub_account of ['self', 'promo', 'AVAILABLE', '']) {
    expect(
      await sqlState(insert(h.app, 'ledger_entries', entryRow(account, voucher, { sub_account }))),
    ).toBe('23514');
  }
  for (const income_type of ['SELF_REBATE', 'OTHER', '']) {
    expect(
      await sqlState(insert(h.app, 'ledger_entries', entryRow(account, voucher, { income_type }))),
    ).toBe('23514');
  }
});

it('[AC-B2-02c#10] 四表 app_id 及分录必要维度拒绝 NULL', async () => {
  await ready(h.app);
  const { account, voucher } = await parents(h.app);
  for (const [table, row, required] of [
    ['ledger_accounts', accountRow(), ['app_id', 'owner_type', 'owner_id', 'subject']],
    ['ledger_vouchers', voucherRow(account['app_id']), ['app_id', 'uniq_key']],
    [
      'ledger_entries',
      entryRow(account, voucher),
      ['app_id', 'voucher_id', 'account_id', 'sub_account', 'amount_fen', 'ledger_type'],
    ],
    [
      'account_balances',
      balanceRow(account),
      ['app_id', 'account_id', 'available_fen', 'frozen_fen', 'version'],
    ],
  ] as const) {
    for (const field of required) {
      expect(
        await sqlState(insert(h.app, table, { ...row, [field]: null })),
        `${table}.${field}`,
      ).toBe('23502');
    }
  }
});

it('[AC-B2-02c#11] 三条外键拒绝不存在及跨 app 的账户或凭证', async () => {
  await ready(h.app);
  const first = await parents(h.app);
  const other = await parents(h.app);
  for (const [field, foreign] of [
    ['account_id', other.account['id']],
    ['voucher_id', other.voucher['id']],
  ] as const) {
    for (const id of [randomUUID(), foreign]) {
      expect(
        await sqlState(
          insert(h.app, 'ledger_entries', entryRow(first.account, first.voucher, { [field]: id })),
        ),
      ).toBe('23503');
    }
  }
  for (const account_id of [randomUUID(), other.account['id']]) {
    expect(
      await sqlState(insert(h.app, 'account_balances', balanceRow(first.account, { account_id }))),
    ).toBe('23503');
  }
  expect(
    await sqlState(insert(h.app, 'ledger_entries', entryRow(first.account, first.voucher))),
  ).toBe('ok');
  expect(await sqlState(insert(h.app, 'account_balances', balanceRow(first.account)))).toBe('ok');
});

it('[AC-B2-02c#12] 外键显式包含 app_id、引用非分区父表且禁止级联', async () => {
  await ready(h.app);
  for (const [table, field, target] of [
    ['ledger_entries', 'voucher_id', 'ledger_vouchers'],
    ['ledger_entries', 'account_id', 'ledger_accounts'],
    ['account_balances', 'account_id', 'ledger_accounts'],
  ]) {
    const result = await sql<{
      source: string[];
      target: string[];
      deletion: string;
      updating: string;
      valid: boolean;
      kind: string;
    }>`
      SELECT ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS source,
        ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.ord) AS target,
        c.confdeltype::text AS deletion, c.confupdtype::text AS updating, c.convalidated AS valid,
        p.relkind::text AS kind FROM pg_constraint c JOIN pg_class p ON p.oid = c.confrelid
      WHERE c.conrelid = to_regclass(${`app.${table}`}) AND c.confrelid = to_regclass(${`app.${target}`}) AND c.contype = 'f'
    `.execute(h.app);
    const fk = result.rows.find((row) => row.source.includes(field!));
    expect(fk).toBeDefined();
    expect(fk?.source).toHaveLength(2);
    expect(fk?.source).toEqual(expect.arrayContaining(['app_id', field]));
    expect(fk?.source.map((name, i) => [name, fk.target[i]])).toEqual(
      expect.arrayContaining([
        ['app_id', 'app_id'],
        [field, 'id'],
      ]),
    );
    expect(fk?.kind).toBe('r');
    expect(fk?.valid).toBe(true);
    expect(['a', 'r']).toContain(fk?.deletion);
    expect(['a', 'r']).toContain(fk?.updating);
  }
});

it('[AC-B2-02c#13] 0037 显式命名约束及索引并设置两个正超时', async () => {
  await ready(h.app);
  const path = new URL('../../../../../db/migrations/0037_ledger-core.sql', import.meta.url);
  expect(existsSync(path), 'reserved migration 0037').toBe(true);
  const source = readFileSync(path, 'utf8').replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '');
  for (const setting of ['lock_timeout', 'statement_timeout']) {
    expect(source).toMatch(
      new RegExp(
        `SET\\s+LOCAL\\s+${setting}\\s*(?:=|TO)\\s*(?:'[1-9][0-9]*\\s*(?:ms|s|min|h|d)?'|[1-9][0-9]*)\\s*;`,
        'i',
      ),
    );
  }
  for (const table of TABLES) {
    const constraints = await sql<{ name: string }>`SELECT conname AS name FROM pg_constraint
      WHERE conrelid = to_regclass(${`app.${table}`}) AND contype IN ('p', 'u', 'c', 'f')`.execute(
      h.app,
    );
    expect(constraints.rows.length).toBeGreaterThan(0);
    for (const { name } of constraints.rows) {
      expect(source, `${table}.${name} explicit CONSTRAINT`).toMatch(
        new RegExp(`\\bCONSTRAINT\\s+"?${name}"?\\s`, 'i'),
      );
    }
    const indexes = await sql<{
      name: string;
      constraint_backed: boolean;
    }>`SELECT c.relname AS name,
      EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.contype IN ('p', 'u')) AS constraint_backed
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = to_regclass(${`app.${table}`})`.execute(
      h.app,
    );
    expect(indexes.rows.length).toBeGreaterThan(0);
    for (const { name, constraint_backed } of indexes.rows) {
      if (!constraint_backed)
        expect(source).toMatch(
          new RegExp(`\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+"?${name}"?\\s`, 'i'),
        );
    }
  }
});
