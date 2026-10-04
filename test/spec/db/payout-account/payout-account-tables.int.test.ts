// Rule tests for the payout-account tables of B1-13a (规划/04 §3.2 rows payout_accounts /
// payout_account_changes and payout_account_verify_attempts; ADR-0001 §4.1, §4.2 #8;
// db/AGENTS.md rules 4 and 7; 08 BR-WDR-02 and its 细则「核验次数上限」「支付宝登录号的规范化」
// 「保存在用户级锁内」, SPEC_REF 826f86e). Real PostgreSQL as the business roles. Columns whose
// shape 04 leaves to the implementation (keys, HMAC types, old/new column names) are found or
// filled from the catalog by kit.ts. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  FOREIGN_KEY_VIOLATION,
  PAYOUT_TABLES,
  PERMISSION_DENIED,
  REJECTED_VALUE,
  UNIQUE_VIOLATION,
  column,
  columns,
  foreignKeys,
  hasPrivilege,
  freshValue,
  insertRow,
  newUser,
  sqlState,
  useDb,
} from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;
let payout: Kysely<DB>;
let readonly: Kysely<DB>;
let maint: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  payout = createDb({ connectionString: database.urlFor('couli_payout'), max: 1 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
  maint = createDb({ connectionString: database.urlFor('couli_maint'), max: 1 });
  useDb(app);
});

afterAll(async () => {
  await Promise.all([app, payout, readonly, maint].map((db) => destroyDb(db)));
  await database.drop();
});

const INTEGER_TYPES = ['int2', 'int4', 'int8'];
const OTHER_APP = 'couli_two';
const RESERVED_AT = new Date('2026-10-04T08:00:00Z');
const VERIFY_STATUSES = [
  'reserved',
  'matched',
  'mismatched',
  'unknown',
  'expired_unresolved',
  'released',
];

const ACCOUNTS = 'payout_accounts';
const CHANGES = 'payout_account_changes';
const ATTEMPTS = 'payout_account_verify_attempts';

/** Inserts a current alipay account (BR-WDR-02 ②: cipher plus HMAC of the normalized logon id). */
async function newAlipay(values: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const appId = (values['app_id'] as string | undefined) ?? 'couli';
  return insertRow(ACCOUNTS, {
    app_id: appId,
    user_id: values['user_id'] ?? (await newUser({ app_id: appId })),
    payout_method: 'alipay',
    alipay_logon_id_cipher: Buffer.from(randomUUID()),
    alipay_hmac: await freshValue(ACCOUNTS, 'alipay_hmac'),
    payee_name: '张三',
    is_current: true,
    ...values,
  });
}

/** Inserts a current bank_card account (BR-WDR-02 ⑥). */
async function newBankCard(values: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const appId = (values['app_id'] as string | undefined) ?? 'couli';
  return insertRow(ACCOUNTS, {
    app_id: appId,
    user_id: values['user_id'] ?? (await newUser({ app_id: appId })),
    payout_method: 'bank_card',
    bank_card_no_cipher: Buffer.from(randomUUID()),
    bank_card_hmac: await freshValue(ACCOUNTS, 'bank_card_hmac'),
    bank_name: '招商银行',
    card_bin: '622588',
    payee_name: '张三',
    is_current: true,
    ...values,
  });
}

/** Inserts a verification reservation (BR-WDR-02 细则「核验次数上限」: one row per reservation). */
async function newAttempt(values: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const appId = (values['app_id'] as string | undefined) ?? 'couli';
  return insertRow(ATTEMPTS, {
    app_id: appId,
    user_id: values['user_id'] ?? (await newUser({ app_id: appId })),
    verify_date: '2026-10-04',
    status: 'reserved',
    vendor_request_id: await freshValue(ATTEMPTS, 'vendor_request_id'),
    request_fingerprint: await freshValue(ATTEMPTS, 'request_fingerprint'),
    reserved_at: RESERVED_AT,
    origin_action: 'payout_account_change',
    idempotency_key: await freshValue(ATTEMPTS, 'idempotency_key'),
    ...values,
  });
}

/** The old/new payout_method and HMAC columns of payout_account_changes (names left to 04 users). */
async function changeColumns(): Promise<
  Record<'oldMethod' | 'newMethod' | 'oldHmac' | 'newHmac', string[]>
> {
  const names = (await columns(CHANGES)).map((c) => c.name);
  const pick = (side: string, kind: string): string[] =>
    names.filter((n) => n.includes(side) && n.includes(kind));
  return {
    oldMethod: pick('old', 'method'),
    newMethod: pick('new', 'method'),
    oldHmac: pick('old', 'hmac'),
    newHmac: pick('new', 'hmac'),
  };
}

async function newChange(values: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const appId = (values['app_id'] as string | undefined) ?? 'couli';
  return insertRow(CHANGES, {
    app_id: appId,
    user_id: values['user_id'] ?? (await newUser({ app_id: appId })),
    changed_at: new Date('2026-10-08T02:00:00Z'),
    ...values,
  });
}

// ---------------------------------------------------------------------------------------------
// payout_accounts (04 §3.2; BR-WDR-02 ①②, 细则「存储」「支付宝登录号的规范化」)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-13a#1] payout_accounts has the 04 columns; account numbers are stored only as bytea cipher and HMAC (BR-WDR-02 ②)', async () => {
  const cols = new Map((await columns(ACCOUNTS)).map((c) => [c.name, c]));
  for (const name of [
    'app_id',
    'user_id',
    'payout_method',
    'alipay_logon_id_cipher',
    'alipay_hmac',
    'bank_card_no_cipher',
    'bank_card_hmac',
    'bank_name',
    'card_bin',
    'payee_name',
    'is_current',
  ]) {
    expect(cols.has(name), name).toBe(true);
  }
  expect(cols.get('alipay_logon_id_cipher')?.type).toBe('bytea');
  expect(cols.get('bank_card_no_cipher')?.type).toBe('bytea');
  expect(cols.get('is_current')?.type).toBe('bool');
  for (const name of ['app_id', 'user_id', 'payout_method', 'is_current']) {
    expect(cols.get(name)?.nullable, name).toBe(false);
  }
});

it('[AC-B1-13a#2] no table keeps a plaintext logon id or card number column (BR-WDR-02 ②; 04: request_fingerprint 不存明文卡号)', async () => {
  for (const table of PAYOUT_TABLES) {
    for (const c of await columns(table)) {
      if (/logon|card_no|card_number|account_no|account_number/.test(c.name)) {
        expect(c.name, `${table}.${c.name}`).toMatch(/_(cipher|hmac)$/);
      }
    }
  }
  const names = (await columns(ATTEMPTS)).map((c) => c.name);
  expect(names).not.toContain('card_no');
  expect(names).not.toContain('bank_card_no');
});

it('[AC-B1-13a#3] payout_method is alipay or bank_card only (BR-WDR-02, SPEC_REF 826f86e)', async () => {
  expect(await sqlState(newAlipay())).toBe('no error');
  expect(await sqlState(newBankCard())).toBe('no error');
  for (const method of ['wechat', 'ALIPAY', 'bankcard', '']) {
    expect(REJECTED_VALUE, JSON.stringify(method)).toContain(
      await sqlState(newAlipay({ payout_method: method })),
    );
  }
});

it('[AC-B1-13a#4] an alipay row needs no bank fields and a bank_card row needs no alipay fields', async () => {
  expect(
    await sqlState(
      newAlipay({
        bank_card_no_cipher: null,
        bank_card_hmac: null,
        bank_name: null,
        card_bin: null,
      }),
    ),
  ).toBe('no error');
  expect(await sqlState(newBankCard({ alipay_logon_id_cipher: null, alipay_hmac: null }))).toBe(
    'no error',
  );
});

it('[AC-B1-13a#5] an alipay account is current for at most one member of an app: unique (app_id, alipay_hmac) WHERE is_current (BR-WDR-02 ②, 30308)', async () => {
  const first = await newAlipay();
  expect(await sqlState(newAlipay({ alipay_hmac: first['alipay_hmac'] }))).toBe(UNIQUE_VIOLATION);
});

it('[AC-B1-13a#6] a replaced alipay account (is_current false) can be bound by another member (BR-WDR-02 细则: 换走的旧账号可以被其他会员绑定)', async () => {
  const hmac = await freshValue(ACCOUNTS, 'alipay_hmac');
  expect(await sqlState(newAlipay({ alipay_hmac: hmac, is_current: false }))).toBe('no error');
  expect(await sqlState(newAlipay({ alipay_hmac: hmac, is_current: false }))).toBe('no error');
  expect(await sqlState(newAlipay({ alipay_hmac: hmac }))).toBe('no error');
});

it('[AC-B1-13a#7] the alipay uniqueness is per app: another app may bind the same alipay_hmac', async () => {
  const first = await newAlipay();
  expect(await sqlState(newAlipay({ app_id: OTHER_APP, alipay_hmac: first['alipay_hmac'] }))).toBe(
    'no error',
  );
});

it('[AC-B1-13a#8] a bank card is current for at most one member of an app: unique (app_id, bank_card_hmac) WHERE is_current (BR-WDR-02 ②, 30308)', async () => {
  const first = await newBankCard();
  expect(await sqlState(newBankCard({ bank_card_hmac: first['bank_card_hmac'] }))).toBe(
    UNIQUE_VIOLATION,
  );
});

it('[AC-B1-13a#9] a replaced bank card (is_current false) can be bound by another member', async () => {
  const hmac = await freshValue(ACCOUNTS, 'bank_card_hmac');
  expect(await sqlState(newBankCard({ bank_card_hmac: hmac, is_current: false }))).toBe('no error');
  expect(await sqlState(newBankCard({ bank_card_hmac: hmac, is_current: false }))).toBe('no error');
  expect(await sqlState(newBankCard({ bank_card_hmac: hmac }))).toBe('no error');
});

it('[AC-B1-13a#10] the bank card uniqueness is per app: another app may bind the same bank_card_hmac', async () => {
  const first = await newBankCard();
  expect(
    await sqlState(newBankCard({ app_id: OTHER_APP, bank_card_hmac: first['bank_card_hmac'] })),
  ).toBe('no error');
});

it('[AC-B1-13a#11] a member has at most one current account across both methods (BR-WDR-02: 每人同一时刻 1 个当前账号)', async () => {
  const user = await newUser();
  await newAlipay({ user_id: user });
  expect(await sqlState(newBankCard({ user_id: user }))).toBe(UNIQUE_VIOLATION);
  expect(await sqlState(newAlipay({ user_id: user }))).toBe(UNIQUE_VIOLATION);
});

it('[AC-B1-13a#12] switching method keeps history: the old row turns non-current and a new current row is written (BR-WDR-02 细则「存储」)', async () => {
  const user = await newUser();
  await newAlipay({ user_id: user });
  const off = await sql`
    UPDATE app.payout_accounts SET is_current = false, row_version = row_version + 1
    WHERE user_id = ${user} AND is_current AND row_version = 0
  `.execute(app);
  expect(off.numAffectedRows).toBe(1n);
  expect(await sqlState(newBankCard({ user_id: user }))).toBe('no error');
  expect(await sqlState(newAlipay({ user_id: user, is_current: false }))).toBe('no error');
  const rows = await sql<{ current: boolean; n: string }>`
    SELECT is_current AS current, count(*)::text AS n FROM app.payout_accounts
    WHERE user_id = ${user} GROUP BY is_current ORDER BY is_current
  `.execute(app);
  expect(rows.rows).toEqual([
    { current: false, n: '2' },
    { current: true, n: '1' },
  ]);
});

it('[AC-B1-13a#13] payout_accounts.row_version is an integer with a default, advanced by the writer (ADR-0001 §4.1 CAS)', async () => {
  const c = await column(ACCOUNTS, 'row_version');
  expect(INTEGER_TYPES).toContain(c?.type);
  expect(c?.nullable).toBe(false);
  expect(c?.hasDefault).toBe(true);
  const row = await newAlipay();
  const stale = await sql`
    UPDATE app.payout_accounts SET is_current = false, row_version = row_version + 1
    WHERE user_id = ${row['user_id']} AND row_version = 5
  `.execute(app);
  expect(stale.numAffectedRows).toBe(0n);
  const stored = await sql<{ v: string; current: boolean }>`
    SELECT row_version::text AS v, is_current AS current FROM app.payout_accounts
    WHERE user_id = ${row['user_id']}
  `.execute(app);
  expect(stored.rows).toEqual([{ v: '0', current: true }]);
});

// ---------------------------------------------------------------------------------------------
// payout_account_changes (04 §3.2; BR-WDR-02 ④, 细则「存储」)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-13a#14] payout_account_changes has user_id, old and new payout_method and account HMAC, operator and changed_at', async () => {
  const cols = new Map((await columns(CHANGES)).map((c) => [c.name, c]));
  for (const name of ['app_id', 'user_id', 'operator', 'changed_at']) {
    expect(cols.has(name), name).toBe(true);
  }
  expect(cols.get('app_id')?.nullable).toBe(false);
  expect(cols.get('user_id')?.nullable).toBe(false);
  expect(cols.get('changed_at')?.type).toBe('timestamptz');
  expect(cols.get('changed_at')?.nullable).toBe(false);
  const found = await changeColumns();
  for (const [kind, names] of Object.entries(found)) {
    expect(names.length, `${kind}: ${JSON.stringify([...cols.keys()])}`).toBe(1);
  }
});

it('[AC-B1-13a#15] payout_account_changes is append-only for couli_app (BR-WDR-02 ④: 本月变更次数 = 本月记录条数)', async () => {
  const row = await newChange();
  const user = row['user_id'];
  expect(
    await sqlState(
      sql`UPDATE app.payout_account_changes SET changed_at = ${new Date('2026-09-01T00:00:00Z')}
          WHERE user_id = ${user}`.execute(app),
    ),
  ).not.toBe('no error');
  expect(
    await sqlState(
      sql`DELETE FROM app.payout_account_changes WHERE user_id = ${user}`.execute(app),
    ),
  ).not.toBe('no error');
  const stored = await sql<{ same: boolean }>`
    SELECT changed_at = ${new Date('2026-10-08T02:00:00Z')}::timestamptz AS same
    FROM app.payout_account_changes WHERE user_id = ${user}
  `.execute(app);
  expect(stored.rows).toEqual([{ same: true }]);
});

// ---------------------------------------------------------------------------------------------
// payout_account_verify_attempts (04 §3.2; BR-WDR-02 ⑦, 细则「核验次数上限」)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-13a#16] payout_account_verify_attempts has the 04 columns with their types and nullability', async () => {
  const cols = new Map((await columns(ATTEMPTS)).map((c) => [c.name, c]));
  for (const name of [
    'app_id',
    'user_id',
    'verify_date',
    'status',
    'vendor_request_id',
    'request_fingerprint',
    'reserved_at',
    'unknown_at',
    'resolved_at',
    'origin_action',
    'idempotency_key',
  ]) {
    expect(cols.has(name), name).toBe(true);
  }
  expect(cols.get('verify_date')?.type).toBe('date');
  for (const name of ['reserved_at', 'unknown_at', 'resolved_at']) {
    expect(cols.get(name)?.type, name).toBe('timestamptz');
  }
  for (const name of [
    'app_id',
    'user_id',
    'verify_date',
    'status',
    'vendor_request_id',
    'request_fingerprint',
    'reserved_at',
  ]) {
    expect(cols.get(name)?.nullable, name).toBe(false);
  }
  // Filled later (takeover, result) or absent (04: WHERE idempotency_key IS NOT NULL).
  for (const name of ['unknown_at', 'resolved_at', 'idempotency_key']) {
    expect(cols.get(name)?.nullable, name).toBe(true);
  }
});

it('[AC-B1-13a#17] status is one of the six 04 values (BR-WDR-02 细则「核验次数上限」)', async () => {
  for (const status of VERIFY_STATUSES) {
    expect(await sqlState(newAttempt({ status })), status).toBe('no error');
  }
  for (const status of ['pending', 'MATCHED', 'expired', 'refunded', '']) {
    expect(REJECTED_VALUE, JSON.stringify(status)).toContain(
      await sqlState(newAttempt({ status })),
    );
  }
});

it('[AC-B1-13a#18] origin_action records payout_account_change (04: 现只有 payout_account_change)', async () => {
  const row = await newAttempt({ origin_action: 'payout_account_change' });
  const stored = await sql<{ action: string }>`
    SELECT origin_action::text AS action FROM app.payout_account_verify_attempts
    WHERE user_id = ${row['user_id']}
  `.execute(app);
  expect(stored.rows).toEqual([{ action: 'payout_account_change' }]);
});

it('[AC-B1-13a#19] a vendor request id is used once per app: unique (app_id, vendor_request_id)', async () => {
  const first = await newAttempt();
  expect(
    await sqlState(
      newAttempt({ vendor_request_id: first['vendor_request_id'], status: 'matched' }),
    ),
  ).toBe(UNIQUE_VIOLATION);
  expect(
    await sqlState(
      newAttempt({ app_id: OTHER_APP, vendor_request_id: first['vendor_request_id'] }),
    ),
  ).toBe('no error');
});

it('[AC-B1-13a#20] one fingerprint has at most one reserved or unknown row per member (04 部分唯一 WHERE status IN (reserved, unknown))', async () => {
  for (const [a, b] of [
    ['reserved', 'reserved'],
    ['reserved', 'unknown'],
    ['unknown', 'reserved'],
    ['unknown', 'unknown'],
  ] as const) {
    const first = await newAttempt({ status: a });
    expect(
      await sqlState(
        newAttempt({
          user_id: first['user_id'],
          request_fingerprint: first['request_fingerprint'],
          status: b,
        }),
      ),
      `${a} then ${b}`,
    ).toBe(UNIQUE_VIOLATION);
  }
});

it('[AC-B1-13a#21] rows in a final state do not block a new reservation of the same fingerprint', async () => {
  const user = await newUser();
  const fingerprint = await freshValue(ATTEMPTS, 'request_fingerprint');
  for (const status of ['matched', 'mismatched', 'expired_unresolved', 'released', 'matched']) {
    expect(
      await sqlState(newAttempt({ user_id: user, request_fingerprint: fingerprint, status })),
      status,
    ).toBe('no error');
  }
  expect(await sqlState(newAttempt({ user_id: user, request_fingerprint: fingerprint }))).toBe(
    'no error',
  );
});

it('[AC-B1-13a#22] the in-flight uniqueness is per member and per app', async () => {
  const first = await newAttempt();
  expect(await sqlState(newAttempt({ request_fingerprint: first['request_fingerprint'] }))).toBe(
    'no error',
  );
  expect(
    await sqlState(
      newAttempt({ app_id: OTHER_APP, request_fingerprint: first['request_fingerprint'] }),
    ),
  ).toBe('no error');
});

it('[AC-B1-13a#23] resolving a reservation frees its fingerprint for a new one (reserved → matched)', async () => {
  const first = await newAttempt();
  const resolved = await sql`
    UPDATE app.payout_account_verify_attempts
    SET status = 'matched', resolved_at = ${new Date('2026-10-04T08:00:05Z')},
        row_version = row_version + 1
    WHERE vendor_request_id = ${first['vendor_request_id']} AND status = 'reserved'
  `.execute(app);
  expect(resolved.numAffectedRows).toBe(1n);
  expect(
    await sqlState(
      newAttempt({ user_id: first['user_id'], request_fingerprint: first['request_fingerprint'] }),
    ),
  ).toBe('no error');
});

it('[AC-B1-13a#24] an idempotency key binds at most one verification of a member, whatever its status (04 部分唯一 WHERE idempotency_key IS NOT NULL)', async () => {
  for (const status of VERIFY_STATUSES) {
    const first = await newAttempt({ status: 'matched' });
    expect(
      await sqlState(
        newAttempt({
          user_id: first['user_id'],
          idempotency_key: first['idempotency_key'],
          status,
        }),
      ),
      status,
    ).toBe(UNIQUE_VIOLATION);
  }
});

it('[AC-B1-13a#25] attempts without an idempotency key are not limited; the key is unique per member and per app', async () => {
  const user = await newUser();
  for (let i = 0; i < 2; i += 1) {
    expect(
      await sqlState(newAttempt({ user_id: user, idempotency_key: null, status: 'matched' })),
    ).toBe('no error');
  }
  const first = await newAttempt();
  expect(await sqlState(newAttempt({ idempotency_key: first['idempotency_key'] }))).toBe(
    'no error',
  );
  expect(
    await sqlState(newAttempt({ app_id: OTHER_APP, idempotency_key: first['idempotency_key'] })),
  ).toBe('no error');
});

it('[AC-B1-13a#26] attempts are indexed by (app_id, user_id, request_fingerprint, reserved_at)', async () => {
  const rows = await sql<{ def: string }>`
    SELECT indexdef AS def FROM pg_indexes
    WHERE schemaname = 'app' AND tablename = ${ATTEMPTS}
  `.execute(app);
  expect(
    rows.rows.some(({ def }) =>
      /\(\s*app_id\s*,\s*user_id\s*,\s*request_fingerprint\s*,\s*reserved_at\b/.test(def),
    ),
    JSON.stringify(rows.rows),
  ).toBe(true);
});

it('[AC-B1-13a#27] payout_account_verify_attempts.row_version is an integer with a default; takeover is a conditional update (ADR-0001 §4.1; 细则: 带原状态条件的更新)', async () => {
  const c = await column(ATTEMPTS, 'row_version');
  expect(INTEGER_TYPES).toContain(c?.type);
  expect(c?.nullable).toBe(false);
  expect(c?.hasDefault).toBe(true);
  const row = await newAttempt();
  const takeover = sql`
    UPDATE app.payout_account_verify_attempts
    SET status = 'unknown', unknown_at = ${new Date('2026-10-04T08:01:01Z')},
        row_version = row_version + 1
    WHERE vendor_request_id = ${row['vendor_request_id']} AND status = 'reserved'
      AND row_version = 0
  `;
  expect((await takeover.execute(app)).numAffectedRows).toBe(1n);
  expect((await takeover.execute(app)).numAffectedRows).toBe(0n);
  const stored = await sql<{ status: string; v: string }>`
    SELECT status::text AS status, row_version::text AS v
    FROM app.payout_account_verify_attempts WHERE vendor_request_id = ${row['vendor_request_id']}
  `.execute(app);
  expect(stored.rows).toEqual([{ status: 'unknown', v: '1' }]);
});

// ---------------------------------------------------------------------------------------------
// Common rules (db/AGENTS.md #7: app_id NOT NULL, foreign keys kept, no cascade)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-13a#28] every table carries app_id text NOT NULL (db/AGENTS.md #7)', async () => {
  for (const table of PAYOUT_TABLES) {
    const c = await column(table, 'app_id');
    expect(c?.type, table).toBe('text');
    expect(c?.nullable, table).toBe(false);
  }
});

it('[AC-B1-13a#29] user_id references a user of the same app, and no foreign key cascades (db/AGENTS.md #7)', async () => {
  const stranger = randomUUID();
  expect(await sqlState(newAlipay({ user_id: stranger }))).toBe(FOREIGN_KEY_VIOLATION);
  expect(await sqlState(newChange({ user_id: stranger }))).toBe(FOREIGN_KEY_VIOLATION);
  expect(await sqlState(newAttempt({ user_id: stranger }))).toBe(FOREIGN_KEY_VIOLATION);
  const user = await newUser();
  expect(await sqlState(newAlipay({ app_id: OTHER_APP, user_id: user }))).toBe(
    FOREIGN_KEY_VIOLATION,
  );
  expect(await sqlState(newAttempt({ app_id: OTHER_APP, user_id: user }))).toBe(
    FOREIGN_KEY_VIOLATION,
  );
  expect(await sqlState(newChange({ app_id: OTHER_APP, user_id: user }))).toBe(
    FOREIGN_KEY_VIOLATION,
  );
  for (const table of PAYOUT_TABLES) {
    const fks = await foreignKeys(table);
    expect(
      fks.some((fk) => fk.target === 'users' && fk.columns.includes('user_id')),
      table,
    ).toBe(true);
    for (const fk of fks) {
      expect(['a', 'r'], `${table}.${fk.name} ON DELETE`).toContain(fk.onDelete);
      expect(['a', 'r'], `${table}.${fk.name} ON UPDATE`).toContain(fk.onUpdate);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Roles (db/AGENTS.md #4; ADR-0001 §4.2 #8; BR-WDR-02: 只换绑不解绑; 04: 写者 withdraw)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-13a#30] couli_app reads and inserts all three tables and deletes none (BR-WDR-02: 不提供解绑)', async () => {
  for (const table of PAYOUT_TABLES) {
    expect(await hasPrivilege('couli_app', table, 'SELECT'), `${table} SELECT`).toBe(true);
    expect(await hasPrivilege('couli_app', table, 'INSERT'), `${table} INSERT`).toBe(true);
    expect(await hasPrivilege('couli_app', table, 'DELETE'), `${table} DELETE`).toBe(false);
    expect(await hasPrivilege('couli_app', table, 'TRUNCATE'), `${table} TRUNCATE`).toBe(false);
  }
  const account = await newAlipay();
  expect(
    await sqlState(
      sql`DELETE FROM app.payout_accounts WHERE user_id = ${account['user_id']}`.execute(app),
    ),
  ).toBe(PERMISSION_DENIED);
  const attempt = await newAttempt();
  expect(
    await sqlState(
      sql`DELETE FROM app.payout_account_verify_attempts
          WHERE user_id = ${attempt['user_id']}`.execute(app),
    ),
  ).toBe(PERMISSION_DENIED);
});

it('[AC-B1-13a#31] couli_readonly reads the three tables and cannot write them', async () => {
  for (const table of PAYOUT_TABLES) {
    expect(
      await sqlState(sql`SELECT 1 FROM ${sql.table(`app.${table}`)} LIMIT 1`.execute(readonly)),
      table,
    ).toBe('no error');
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      expect(await hasPrivilege('couli_readonly', table, privilege), `${table} ${privilege}`).toBe(
        false,
      );
    }
  }
  expect(
    await sqlState(
      sql`UPDATE app.payout_accounts SET is_current = false WHERE false`.execute(readonly),
    ),
  ).toBe(PERMISSION_DENIED);
});

it('[AC-B1-13a#32] couli_payout and couli_maint cannot write the three tables; couli_maint cannot read them', async () => {
  for (const table of PAYOUT_TABLES) {
    for (const role of ['couli_payout', 'couli_maint']) {
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        expect(await hasPrivilege(role, table, privilege), `${role} ${table} ${privilege}`).toBe(
          false,
        );
      }
    }
    expect(
      await sqlState(sql`SELECT 1 FROM ${sql.table(`app.${table}`)} LIMIT 1`.execute(maint)),
      table,
    ).toBe(PERMISSION_DENIED);
  }
  expect(
    await sqlState(
      sql`UPDATE app.payout_accounts SET is_current = false WHERE false`.execute(payout),
    ),
  ).toBe(PERMISSION_DENIED);
});
