// B2-08a rule tests (规划/08 BR-WDR-20; 规划/04 §3.2 tax_ytd; BR-ID-25「实名更正」/ D10-181 ②):
// columns, types, NOT NULL, CHECK, unique key, index and foreign key of app.tax_ytd, on a migrated
// test database.
import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  INCOME_TYPES,
  INDEX,
  INDEX_COLUMNS,
  REJECTED_INCOME_TYPES,
  SHAPE,
  TIMEOUT,
  UNIQUE_COLUMNS,
  UNIQUE_KEY,
  YEAR,
  YEAR_MAX,
  YEAR_MIN,
  appId,
  close,
  columns,
  fresh,
  hmac,
  insert,
  ledger,
  member,
  open,
  ready,
  sqlState,
  stored,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[BR-WDR-20] tax_ytd 列名、类型、可空性和默认值逐一匹配：累计金额 bigint 分、年度 integer、身份 text', async () => {
  await ready(h.app);
  const found = await columns(h.app);
  expect(found.map((c) => c.name).sort()).toEqual(Object.keys(SHAPE).sort());
  for (const [name, [type, nullable, default_expr]] of Object.entries(SHAPE)) {
    expect(found, name).toContainEqual({ name, type, nullable, default_expr });
  }
});

it('[BR-WDR-20] tax_ytd 主键为 id，必填列拒绝 NULL，累计列缺省为 0，时间戳由库填写', async () => {
  await ready(h.app);
  const row = await fresh(h.app);
  for (const [name, [, nullable]] of Object.entries(SHAPE)) {
    if (!nullable)
      expect(await sqlState(insert(h.app, { ...row, [name]: null })), name).toBe('23502');
  }
  const totals = ['cum_income_fen', 'cum_withheld_fen', 'continuous_months'];
  const bare = Object.fromEntries(Object.entries(row).filter(([name]) => !totals.includes(name)));
  expect(await sqlState(insert(h.app, bare))).toBe('ok');
  const saved = (await stored(h.app, row['id']))[0];
  expect(saved).toMatchObject({
    id: row['id'],
    user_id: row['user_id'],
    year: YEAR,
    income_type: 'SERVICE_FEE',
    identity_hmac: row['identity_hmac'],
    cum_income_fen: 0n,
    cum_withheld_fen: 0n,
    continuous_months: 0,
  });
  expect(saved?.['created_at']).toBeInstanceOf(Date);
  expect(saved?.['updated_at']).toBeInstanceOf(Date);
  const pk = await sql<{ keys: string[] }>`SELECT
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS keys
    FROM pg_constraint c WHERE c.conrelid = to_regclass('app.tax_ytd') AND c.contype = 'p'`.execute(
    h.app,
  );
  expect(pk.rows).toEqual([{ keys: ['id'] }]);
});

it('[BR-WDR-20] tax_ytd 累计金额超出 2^53 原样往返，不丢精度', async () => {
  await ready(h.app);
  const big = 9_007_199_254_740_993n;
  const row = await fresh(h.app, { cum_income_fen: big, cum_withheld_fen: big + 2n });
  await insert(h.app, row);
  expect((await stored(h.app, row['id']))[0]).toMatchObject({
    cum_income_fen: big,
    cum_withheld_fen: big + 2n,
  });
});

it('[BR-WDR-20] tax_ytd 三个累计（收入、已扣税、连续月数）不为负，0 可写入', async () => {
  await ready(h.app);
  const app = appId();
  const user = await member(h.app, app);
  for (const [column, negative] of [
    ['cum_income_fen', -1n],
    ['cum_withheld_fen', -1n],
    ['continuous_months', -1],
  ] as const) {
    expect(await sqlState(insert(h.app, ledger(app, user, { [column]: negative }))), column).toBe(
      '23514',
    );
  }
  // method=none (税率表生效前)：tax_fen 记 0，收入照常累加。
  expect(
    await sqlState(
      insert(h.app, ledger(app, user, { cum_withheld_fen: 0n, continuous_months: 0 })),
    ),
  ).toBe('ok');
});

it('[BR-WDR-20] tax_ytd.income_type 现在只接受 SERVICE_FEE（自购也属于推广，SELF_REBATE 不再使用）', async () => {
  await ready(h.app);
  const app = appId();
  const user = await member(h.app, app);
  for (const income_type of INCOME_TYPES) {
    expect(await sqlState(insert(h.app, ledger(app, user, { income_type }))), income_type).toBe(
      'ok',
    );
  }
  for (const income_type of REJECTED_INCOME_TYPES) {
    expect(await sqlState(insert(h.app, ledger(app, user, { income_type }))), income_type).toBe(
      '23514',
    );
  }
});

it('[BR-WDR-20] tax_ytd.year 为计税年度，只接受 2026–2100', async () => {
  await ready(h.app);
  const app = appId();
  const user = await member(h.app, app);
  for (const year of [YEAR_MIN, YEAR, YEAR_MAX]) {
    expect(await sqlState(insert(h.app, ledger(app, user, { year }))), String(year)).toBe('ok');
  }
  for (const year of [0, 1970, YEAR_MIN - 1, YEAR_MAX + 1, 20320]) {
    expect(await sqlState(insert(h.app, ledger(app, user, { year }))), String(year)).toBe('23514');
  }
});

it('[BR-ID-25] tax_ytd.identity_hmac 与 realname_prior_identities.id_no_hmac 同形状：64 位小写十六进制，不存明文', async () => {
  await ready(h.app);
  const app = appId();
  const user = await member(h.app, app);
  const good = hmac();
  expect(await sqlState(insert(h.app, ledger(app, user, { identity_hmac: good })))).toBe('ok');
  for (const identity_hmac of [
    '',
    good.toUpperCase(),
    good.slice(1),
    `${good}0`,
    `g${good.slice(1)}`,
    '110101199003077777',
    `${good.slice(0, 32)}-${good.slice(33)}`,
  ]) {
    expect(await sqlState(insert(h.app, ledger(app, user, { identity_hmac }))), identity_hmac).toBe(
      '23514',
    );
  }
});

it('[BR-WDR-20] tax_ytd 同一会员同一年度同类所得同一身份只有一行，次年另起一行', async () => {
  await ready(h.app);
  const app = appId();
  const user = await member(h.app, app);
  const first = ledger(app, user);
  await insert(h.app, first);
  const same = { identity_hmac: first['identity_hmac'] };
  expect(
    await sqlState(insert(h.app, ledger(app, user, { ...same, cum_income_fen: 20000n }))),
  ).toBe('23505');
  expect(await sqlState(insert(h.app, ledger(app, user, { ...same, year: YEAR + 1 })))).toBe('ok');
  const other = await member(h.app, app);
  expect(await sqlState(insert(h.app, ledger(app, other, same))), 'another member').toBe('ok');
});

it('[BR-ID-25] tax_ytd 实名更正后新身份另起一行，更正前的累计留在旧身份行、不并入', async () => {
  await ready(h.app);
  const app = appId();
  const user = await member(h.app, app);
  const before = ledger(app, user, { cum_income_fen: 30000n, cum_withheld_fen: 1200n });
  await insert(h.app, before);
  const after = ledger(app, user, { cum_income_fen: 5000n, cum_withheld_fen: 0n });
  expect(await sqlState(insert(h.app, after))).toBe('ok');
  const rows = (
    await sql<{ identity_hmac: string; cum_income_fen: bigint; cum_withheld_fen: bigint }>`
      SELECT identity_hmac, cum_income_fen, cum_withheld_fen FROM app.tax_ytd
      WHERE app_id = ${app} AND user_id = ${user} AND year = ${YEAR}
      ORDER BY cum_income_fen DESC`.execute(h.app)
  ).rows;
  expect(rows).toEqual([
    { identity_hmac: before['identity_hmac'], cum_income_fen: 30000n, cum_withheld_fen: 1200n },
    { identity_hmac: after['identity_hmac'], cum_income_fen: 5000n, cum_withheld_fen: 0n },
  ]);
});

it('[BR-WDR-20] tax_ytd 唯一键 tax_ytd_identity_key 为 (app_id, user_id, year, income_type, identity_hmac)，索引 tax_ytd_user_year_idx 为 (app_id, user_id, year)', async () => {
  await ready(h.app);
  // Named (lint-migrations CT-06f) and whole-table: an accumulation upserts on this key.
  const indexes = await sql<{
    name: string;
    keys: string[];
    unique: boolean;
    valid: boolean;
    predicate: string | null;
  }>`SELECT c.relname::text AS name,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
        WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS keys,
      i.indisunique AS unique, i.indisvalid AS valid, pg_get_expr(i.indpred, i.indrelid) AS predicate
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = to_regclass('app.tax_ytd')`.execute(h.app);
  expect(indexes.rows).toContainEqual({
    name: UNIQUE_KEY,
    keys: UNIQUE_COLUMNS,
    unique: true,
    valid: true,
    predicate: null,
  });
  expect(indexes.rows).toContainEqual({
    name: INDEX,
    keys: INDEX_COLUMNS,
    unique: false,
    valid: true,
    predicate: null,
  });
});

it('[BR-WDR-20] tax_ytd (app_id, user_id) 外键指向 users (app_id, id)，不级联；不存在的会员与别的 App 的会员被拒绝', async () => {
  await ready(h.app);
  const fk = await sql<{
    keys: string[];
    target: string;
    target_keys: string[];
    on_delete: string;
    on_update: string;
  }>`SELECT
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS keys,
      c.confrelid::regclass::text AS target,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.ord)
        AS target_keys,
      c.confdeltype::text AS on_delete, c.confupdtype::text AS on_update
    FROM pg_constraint c WHERE c.conrelid = to_regclass('app.tax_ytd') AND c.contype = 'f'`.execute(
    h.app,
  );
  expect(fk.rows).toHaveLength(1);
  expect(fk.rows[0]).toMatchObject({
    keys: ['app_id', 'user_id'],
    target: 'app.users',
    target_keys: ['app_id', 'id'],
  });
  // a = NO ACTION, r = RESTRICT; c / n / d (CASCADE, SET NULL, SET DEFAULT) are refused.
  expect(['a', 'r']).toContain(fk.rows[0]?.on_delete);
  expect(['a', 'r']).toContain(fk.rows[0]?.on_update);
  const app = appId();
  const elsewhere = await member(h.app, appId());
  expect(await sqlState(insert(h.app, ledger(app, randomUUID())))).toBe('23503');
  expect(await sqlState(insert(h.app, ledger(app, elsewhere))), 'member of another App').toBe(
    '23503',
  );
});
