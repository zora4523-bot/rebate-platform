// B2-04z / BR-FUND-19⑤⑧：只执行真实 SQL，不在测试里复写不变量算法。
// 沿用 B2-02e：只增 SQL 不放占位实现，缺文件先由 expect 失败，不产生 ENOENT。
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createDb, destroyDb, type DB } from '@couli/db';
import { subFen } from '@couli/money';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import {
  account,
  insert,
  pair,
  platform,
  voucher,
  type Account,
  type Result,
  type Row,
} from '../invariants/kit.ts';

export {
  APP,
  OTHER_APP,
  DAY,
  TIMEOUT,
  clean,
  detailContains,
  differences,
} from '../invariants/kit.ts';
export const AT = '2032-06-15T08:00:00Z';
type Code = '05' | '08';
interface Database {
  urlFor(role: 'couli_app' | 'couli_readonly'): string;
  drop(): Promise<void>;
}

export function source(code: Code): string {
  const directory = new URL('../../../../../db/invariants/ledger/', import.meta.url);
  const names = readdirSync(directory).filter(
    (name) => name.startsWith(`${code}_`) && name.endsWith('.sql'),
  );
  expect(names, `BR-FUND-19 ${code} 必须有且只有一个 SQL 文件`).toHaveLength(1);
  const raw = readFileSync(new URL(names[0]!, directory), 'utf8');
  expect(raw).toMatch(/^\s*--[^\n]*BR-FUND-19/);
  const text = raw.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (token) =>
    token.startsWith("'") ? token : ' ',
  );
  const tokens = text.replace(/'(?:''|[^'])*'/g, ' ');
  expect(tokens.trim()).toMatch(/^(?:SELECT|WITH)\b/i);
  expect(tokens.trim().replace(/;\s*$/, '')).not.toContain(';');
  expect(tokens).not.toMatch(
    /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|CALL|DO|COPY|INTO)\b/i,
  );
  expect(tokens).not.toMatch(
    /\b(?:now|clock_timestamp|statement_timestamp|transaction_timestamp)\s*\(|\b(?:CURRENT_DATE|CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP)\b/i,
  );
  return text.trim().replace(/;\s*$/, '');
}

export async function scenario(
  create: () => Promise<Database>,
  code: Code,
  run: (fixture: {
    db: Kysely<DB>;
    check(count: bigint, date?: string): Promise<Result[]>;
  }) => Promise<void>,
): Promise<void> {
  const query = source(code);
  const database = await create();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  const reader = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
  try {
    await run({
      db,
      async check(count, date = '2032-06-15') {
        return reader
          .transaction()
          .setIsolationLevel('repeatable read')
          .execute(async (trx) => {
            await sql`SET TRANSACTION READ ONLY`.execute(trx);
            await sql`SELECT set_config('couli.check_date', ${date}, true)`.execute(trx);
            const { rows } = await sql.raw<Result>(query).execute(trx);
            expect(rows.length).toBeGreaterThan(0);
            for (const row of rows) {
              expect(Object.keys(row).sort()).toEqual([
                'account_id',
                'app_id',
                'checked_rows',
                'detail',
                'invariant',
                'scope',
              ]);
              expect(row.invariant).toBe(code);
              // 数子订单，不能被凭证、义务、维权或受益人连接倍增。
              expect(row.checked_rows).toBe(count);
              expect(['none', code === '05' ? 'global' : 'account']).toContain(row.scope);
            }
            const types = await sql
              .raw<Row>(
                `SELECT pg_typeof(checked_rows)::text AS count_type,
          pg_typeof(account_id)::text AS account_type, pg_typeof(detail)::text AS detail_type
          FROM (${query}\n) result LIMIT 1`,
              )
              .execute(trx);
            expect(types.rows).toEqual([
              { count_type: 'bigint', account_type: 'uuid', detail_type: 'jsonb' },
            ]);
            return rows;
          });
      },
    });
  } finally {
    await Promise.all([destroyDb(db), destroyDb(reader)]);
    await database.drop();
  }
}

export interface Person {
  account: Account;
  role: 'self' | 'direct' | 'share' | 'indirect';
  ratio: number;
  status?: 'active' | 'held' | 'forfeited';
}
export interface Order {
  app: string;
  id: string;
  key: string;
  people: Person[];
  receivable: Account;
  revenue: Account;
}

export async function person(
  db: Kysely<DB>,
  app: string,
  role: Person['role'] = 'self',
  ratio = 5000,
): Promise<Person> {
  const user = await account(db, { app_id: app });
  await insert(db, 'users', {
    id: user.owner_id,
    app_id: app,
    nickname: '不变量夹具',
    avatar: '',
    invite_code: randomUUID(),
    attr_code: randomUUID(),
    level: 'L1',
    status: 'normal',
    register_method: 'phone',
  });
  return { account: user, role, ratio };
}

async function subject(db: Kysely<DB>, app: string, name: string): Promise<Account> {
  const row = await db
    .selectFrom('ledger_accounts')
    .select(['id', 'app_id', 'owner_id', 'owner_type', 'subject'])
    .where('app_id', '=', app)
    .where('subject', '=', name)
    .where('owner_type', '=', 'platform')
    .executeTakeFirst();
  return row ?? platform(db, name, app);
}

export async function order(
  db: Kysely<DB>,
  options: { app?: string; platform?: string; sub?: string; people?: Person[]; values?: Row } = {},
): Promise<Order> {
  const app = options.app ?? 'invariant-app-a';
  const id = randomUUID();
  const platformName = options.platform ?? 'taobao';
  const sub = options.sub ?? randomUUID();
  const people = options.people ?? [await person(db, app), await person(db, app, 'direct', 1000)];
  const identity = {
    app_id: app,
    order_id: id,
    platform: platformName,
    sub_order_id: sub,
    attr_at: AT,
  };
  await insert(db, 'order_keys', identity);
  await insert(db, 'orders', {
    ...identity,
    raw_item_id: 'fixture',
    user_id: people[0]!.account.owner_id,
    platform_status: 'SETTLED',
    rebate_status: 'CREDITED',
    booked_n_fen: 1000n,
    booked_base_fen: 800n,
    credited_at: AT,
    commission_version: 1,
    ...options.values,
  });
  const rule = randomUUID();
  await insert(db, 'commission_rule_versions', { app_id: app, rule_version_id: rule });
  await insert(db, 'commission_splits', {
    app_id: app,
    order_id: id,
    rule_version_id: rule,
    order_type: 'self',
    paid_at: AT,
    paid_at_source: 'platform',
    raw_n_fen: 1000n,
    subsidy_commission_fen: 0n,
    reserve_bp: 2000,
    reserve_fen: 200n,
    tlj_deduct_fen: 0n,
    base_fen: 800n,
    platform_retain_fen: 320n,
    beneficiaries: JSON.stringify(
      people.map((p) => ({
        user_id: p.account.owner_id,
        role: p.role,
        ratio_bp: p.ratio,
        level: 'L1',
        initial_status: p.status ?? 'active',
        forfeit_reason: null,
      })),
    ),
  });
  return {
    app,
    id,
    key: `${platformName}:${sub}`,
    people,
    receivable: await subject(db, app, `UNION_RECEIVABLE:${platformName}`),
    revenue: await subject(db, app, 'COMMISSION_REVENUE'),
  };
}

// share 是实际流向该收款账户的有符号金额；这里只造凭证，不计算预期不变量。
export async function post(
  db: Kysely<DB>,
  o: Order,
  recipient: Person | Account,
  share: bigint,
  kind = 'CREDIT',
  options: { keyPerson?: Person; subType?: string; date?: string; counter?: Account } = {},
): Promise<void> {
  if (share === 0n) return; // 数据库不接受零金额分录。
  const p = 'account' in recipient ? recipient : options.keyPerson;
  const a = 'account' in recipient ? recipient.account : recipient;
  const type =
    kind === 'ADMIN_ADJUST'
      ? 'ADMIN_ADJUST'
      : kind === 'CLAWBACK'
        ? 'CLAWBACK'
        : kind === 'SETTLE_ADJUST'
          ? 'SETTLE_ADJUST'
          : kind === 'REWARD'
            ? 'REWARD'
            : 'REBATE_CREDIT';
  const v = await voucher(db, {
    app_id: o.app,
    order_key: o.key,
    biz_id: o.id,
    beneficiary_user_id: p?.account.owner_id ?? null,
    role: p?.role ?? null,
    voucher_kind: kind,
    accounting_date: options.date ?? '2032-06-15',
  });
  await pair(db, a, options.counter ?? o.receivable, v, subFen(0n, share), {
    ledger_type: type,
    sub_type: options.subType ?? null,
  });
}

export async function obligation(
  db: Kysely<DB>,
  o: Order,
  p: Person,
  options: {
    kind?: 'first_credit' | 'deferred';
    status?: 'open' | 'done' | 'forfeited' | 'voided';
  } = {},
): Promise<void> {
  const kind = options.kind ?? 'first_credit';
  const status = options.status ?? 'open';
  await insert(db, 'beneficiary_credits', {
    beneficiary_credit_id: randomUUID(),
    app_id: o.app,
    order_id: o.id,
    user_id: p.account.owner_id,
    role: p.role,
    kind,
    opened_by: kind === 'first_credit' ? 'R5' : 'R10',
    opened_ref: randomUUID(),
    split_ref: o.id,
    origin_ledger_type: kind === 'deferred' ? 'SETTLE_ADJUST' : null,
    origin_sub_type: kind === 'deferred' ? 'DEFERRED' : null,
    status,
    opened_at: AT,
    closed_by: status === 'open' ? null : status === 'voided' ? 'R8' : 'R5a',
    closed_ref: status === 'open' ? null : randomUUID(),
    closed_at: status === 'open' ? null : AT,
  });
}

export async function rights(
  db: Kysely<DB>,
  o: Order,
  status = 'SUCCEEDED',
  type = 'INVALID_AFTER_SETTLE',
): Promise<void> {
  await insert(db, 'order_rights', {
    id: randomUUID(),
    app_id: o.app,
    order_id: o.id,
    source: 'API',
    type,
    status,
    occurred_at: AT,
  });
}

export function identifies(rows: Result[], o: Order): void {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.app_id).toBe(o.app);
    const leaves = (value: unknown): unknown[] =>
      value !== null && typeof value === 'object' ? Object.values(value).flatMap(leaves) : [value];
    expect(leaves(row.detail).some((v) => v === o.key || v === o.id)).toBe(true);
  }
}
