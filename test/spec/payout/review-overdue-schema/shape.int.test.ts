// B2-05m rule tests (规划/08 BR-WDR-26「每单只判定一次」; D10-467 ④、D10-475 ②(c)): the column
// app.withdrawals.review_overdue_at on a migrated test database — type, nullability, no default,
// inserts that omit it, round trip of any instant — and every existing column, constraint, index and
// trigger of app.withdrawals kept as main's db/schema.sql has it.
import { createTestDatabase } from '@couli/db/testing';
import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  ADDED,
  COLUMN,
  CONSTRAINTS,
  EXISTING,
  INDEXES,
  JUDGED_AT,
  TIMEOUT,
  TRIGGERS,
  appId,
  close,
  columns,
  insert,
  member,
  normalisePredicate,
  open,
  ready,
  seed,
  sqlState,
  stored,
  update,
  withdrawal,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

// One UPDATE and one SELECT per run: PROP_RUNS (10 000 by default) is capped for a database case.
const ROUND_TRIP_RUNS = Math.min(propRuns(), 200);

async function attnum(): Promise<number | undefined> {
  const found = await sql<{ num: number }>`SELECT attnum::int AS num FROM pg_attribute
    WHERE attrelid = to_regclass('app.withdrawals') AND attname = ${COLUMN}
      AND NOT attisdropped`.execute(h.app);
  return found.rows[0]?.num;
}

it('[BR-WDR-26] withdrawals.review_overdue_at 为 timestamptz、可空、无缺省（NULL = 未判定，不用 SQL 时钟）', async () => {
  await ready(h.app);
  const [type, nullable, default_expr] = ADDED;
  expect(await columns(h.app)).toContainEqual({ name: COLUMN, type, nullable, default_expr });
});

it('[BR-WDR-26] withdrawals 既有列逐一保留：名字、类型、可空性与缺省同主干 schema.sql，一个不少', async () => {
  await ready(h.app);
  const found = await columns(h.app);
  for (const [name, [type, nullable, default_expr]] of Object.entries(EXISTING)) {
    expect(found, name).toContainEqual({ name, type, nullable, default_expr });
  }
});

it('[BR-WDR-26] 不带 review_overdue_at 的插入照常成功，新行读到 NULL（未判定）；只加列、不回填', async () => {
  await ready(h.app);
  const row = await seed(h.app);
  expect(Object.keys(row)).not.toContain(COLUMN);
  const saved = await stored(h.app, row['id']);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ id: row['id'], status: 'PENDING_REVIEW', [COLUMN]: null });
  // APPROVED（已通过、未进入 PAYING）同样仍可能超时：插入也不要求该列。
  const approved = await seed(h.app, { status: 'APPROVED', reviewed_at: JUDGED_AT });
  expect((await stored(h.app, approved['id']))[0]).toMatchObject({ [COLUMN]: null });
});

it('[BR-WDR-26] review_overdue_at 写入判定时刻后原样读回：周四 10:00 到期、10:05 判定，+08:00 输入与 UTC 同一时刻，微秒不丢', async () => {
  await ready(h.app);
  const row = await seed(h.app);
  expect(await sqlState(update(h.app, row['id'], { [COLUMN]: JUDGED_AT }))).toBe('ok');
  const saved = (await stored(h.app, row['id']))[0];
  expect(saved?.[COLUMN]).toBeInstanceOf(Date);
  expect((saved?.[COLUMN] as Date).getTime()).toBe(JUDGED_AT.getTime());
  const text = '2032-10-21 10:05:00.123456+08:00';
  await sql`UPDATE app.withdrawals SET review_overdue_at = ${text}::timestamptz
    WHERE id = ${row['id']}`.execute(h.app);
  const exact = await sql<{ same: boolean; utc: string }>`SELECT
      review_overdue_at = ${text}::timestamptz AS same,
      to_char(review_overdue_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS utc
    FROM app.withdrawals WHERE id = ${row['id']}`.execute(h.app);
  expect(exact.rows).toEqual([{ same: true, utc: '2032-10-21T02:05:00.123456' }]);
});

it('[BR-WDR-26] review_overdue_at 写入任意时刻原样往返（fast-check，毫秒精度，2000–2199 年）', async () => {
  await ready(h.app);
  const row = await seed(h.app);
  const details = await fc.check(
    fc.asyncProperty(
      fc.date({
        min: new Date('2000-01-01T00:00:00.000Z'),
        max: new Date('2199-12-31T23:59:59.999Z'),
        noInvalidDate: true,
      }),
      async (at) => {
        await update(h.app, row['id'], { [COLUMN]: at });
        const back = (await stored(h.roles.couli_readonly, row['id']))[0]?.[COLUMN];
        return back instanceof Date && back.getTime() === at.getTime();
      },
    ),
    { numRuns: ROUND_TRIP_RUNS, seed: propSeed() },
  );
  expect(details.failed ? String(details.counterexample?.[0]?.toISOString()) : null).toBeNull();
});

it('[BR-WDR-26] 插入时也可直接带 review_overdue_at；NULL 可写（列无 NOT NULL）', async () => {
  await ready(h.app);
  const app = appId();
  const user = await member(h.app, app);
  const judged = withdrawal(app, user, { [COLUMN]: JUDGED_AT });
  expect(await sqlState(insert(h.app, judged))).toBe('ok');
  expect(((await stored(h.app, judged['id']))[0]?.[COLUMN] as Date).getTime()).toBe(
    JUDGED_AT.getTime(),
  );
  const unjudged = withdrawal(app, user, { [COLUMN]: null });
  expect(await sqlState(insert(h.app, unjudged))).toBe('ok');
  expect((await stored(h.app, unjudged['id']))[0]).toMatchObject({ [COLUMN]: null });
});

it('[BR-WDR-26] withdrawals 既有约束（主键、唯一、外键、CHECK）一个不少且都已生效，没有约束引用 review_overdue_at', async () => {
  await ready(h.app);
  const num = await attnum();
  expect(num).toBeTypeOf('number');
  const found = await sql<{
    name: string;
    type: string;
    validated: boolean;
    keys: number[] | null;
    definition: string;
  }>`SELECT conname::text AS name, contype::text AS type, convalidated AS validated,
      conkey::int[] AS keys, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid = to_regclass('app.withdrawals')`.execute(h.app);
  for (const [name, type] of Object.entries(CONSTRAINTS)) {
    expect(found.rows, name).toContainEqual(
      expect.objectContaining({ name, type, validated: true }),
    );
  }
  for (const c of found.rows) {
    expect(c.keys ?? [], c.name).not.toContain(num);
    expect(c.definition, c.name).not.toContain(COLUMN);
  }
});

it('[BR-WDR-26] withdrawals 既有索引一个不少、键与谓词不变，新列不进任何索引', async () => {
  await ready(h.app);
  const num = await attnum();
  expect(num).toBeTypeOf('number');
  const found = await sql<{
    name: string;
    keys: string[];
    attnums: number[];
    unique: boolean;
    valid: boolean;
    predicate: string | null;
    definition: string;
  }>`SELECT c.relname::text AS name,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
        WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS keys,
      i.indkey::int2[]::int[] AS attnums,
      i.indisunique AS unique, i.indisvalid AS valid,
      pg_get_expr(i.indpred, i.indrelid) AS predicate, pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = to_regclass('app.withdrawals')`.execute(h.app);
  const rows = found.rows.map((r) => ({
    name: r.name,
    keys: r.keys,
    unique: r.unique,
    valid: r.valid,
    predicate: normalisePredicate(r.predicate),
  }));
  for (const [name, index] of Object.entries(INDEXES)) {
    expect(rows, name).toContainEqual({ name, ...index, valid: true });
  }
  for (const r of found.rows) {
    expect(r.attnums, r.name).not.toContain(num);
    expect(r.definition, r.name).not.toContain(COLUMN);
  }
});

it('[BR-WDR-26] withdrawals 既有触发器保留（out_biz_no 不可改），没有触发器跟着 review_overdue_at 触发', async () => {
  await ready(h.app);
  const num = await attnum();
  expect(num).toBeTypeOf('number');
  const found = await sql<{ name: string; enabled: string; columns: number[] }>`SELECT
      tgname::text AS name, tgenabled::text AS enabled, tgattr::int2[]::int[] AS columns
    FROM pg_trigger WHERE tgrelid = to_regclass('app.withdrawals') AND NOT tgisinternal`.execute(
    h.app,
  );
  for (const name of TRIGGERS) {
    expect(found.rows.map((t) => t.name)).toContain(name);
    expect(found.rows.find((t) => t.name === name)?.enabled, name).toBe('O');
  }
  for (const t of found.rows) expect(t.columns, t.name).not.toContain(num);
});
