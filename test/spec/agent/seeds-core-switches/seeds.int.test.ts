// B3-08j · BR-AI-02 细则「开关」(MVP 工具默认 on; 04 §10.2): after every seed file of db/seeds/**
// has run (file-name order, each in its own transaction, as packages/db/scripts/seed.ts runs them)
// app couli has agent.tools.search_products.enabled and agent.tools.get_rebate_quote.enabled as
// JSON boolean true, written by 'seed'. The seed only inserts missing rows (ON CONFLICT DO NOTHING):
// re-running is harmless and an existing row (an operator's false) keeps its value and revision.
// Runs as couli_app, which holds SELECT / INSERT / UPDATE on config_items; fixtures only insert
// and update rows.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { setConfig, usePgEach } from '../stream-mount/kit.ts';

const pg = usePgEach(createTestDatabase);

const SEEDS = fileURLToPath(new URL('../../../../db/seeds/', import.meta.url));

/** The two MVP tool switches this task seeds. */
const CORE_KEYS = [
  'agent.tools.search_products.enabled',
  'agent.tools.get_rebate_quote.enabled',
] as const;

/** The switches B3-08g seeds (db/seeds/0003_agent-tool-switches.sql). */
const B3_08G_KEYS = [
  'agent.tools.handoff_to_human.enabled',
  'agent.tools.prefill_claim.enabled',
  'agent.tools.list_my_orders.enabled',
  'agent.tools.explain_order.enabled',
] as const;

const ALL_KEYS: readonly string[] = [...CORE_KEYS, ...B3_08G_KEYS];

/** Code defaults cover these (BR-AI-07); no seed writes them. */
const UNSEEDED = ['agent.explain_order.order_no_daily_max', 'agent.orders.max_span_days'] as const;

interface SwitchRow {
  readonly value: unknown;
  readonly type: string;
  readonly version: unknown;
  readonly updated_by: string;
}

async function runSeeds(db: Kysely<DB>): Promise<void> {
  const files = readdirSync(SEEDS)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  expect(files.length).toBeGreaterThan(0);
  for (const name of files) {
    const text = readFileSync(`${SEEDS}${name}`, 'utf8');
    await db.transaction().execute(async (trx) => {
      await sql.raw(text).execute(trx);
    });
  }
}

/** The config_items rows of app couli for `keys`, by key (missing keys are absent). */
async function rowsOf(db: Kysely<DB>, keys: readonly string[]): Promise<Record<string, SwitchRow>> {
  const result = await sql<SwitchRow & { key: string }>`
    SELECT key, value, jsonb_typeof(value) AS type, version, updated_by FROM app.config_items
    WHERE app_id = 'couli' AND key IN (${sql.join([...keys])})`.execute(db);
  return Object.fromEntries(
    result.rows.map((row) => [
      row.key,
      { value: row.value, type: row.type, version: row.version, updated_by: row.updated_by },
    ]),
  );
}

/** key → value for the rows of app couli among `keys` (missing keys are absent). */
async function valuesOf(db: Kysely<DB>, keys: readonly string[]): Promise<Record<string, unknown>> {
  const rows = await rowsOf(db, keys);
  return Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, row.value]));
}

function allTrue(keys: readonly string[]): Record<string, boolean> {
  return Object.fromEntries(keys.map((key) => [key, true]));
}

it('[AC-B3-08j#1][BR-AI-02] 新建库跑完全部种子后 couli 的 agent.tools.{search_products,get_rebate_quote}.enabled 两行都在，值为 jsonb 布尔 true，updated_by = seed', async () => {
  await runSeeds(pg.db);
  const rows = await rowsOf(pg.db, CORE_KEYS);
  expect(Object.keys(rows).sort()).toEqual([...CORE_KEYS].sort());
  for (const key of CORE_KEYS) {
    expect(rows[key], key).toMatchObject({ value: true, type: 'boolean', updated_by: 'seed' });
  }
}, 120_000);

it.each(CORE_KEYS)(
  '[AC-B3-08j#2][BR-AI-02] 重复执行全部种子不报错；先把 %s 改成 false 再跑两遍仍 false，两行 version / updated_by 不变',
  async (changed) => {
    await runSeeds(pg.db);
    expect(await valuesOf(pg.db, ALL_KEYS)).toEqual(allTrue(ALL_KEYS));
    await setConfig(pg.db, 'couli', changed, false);
    const before = await rowsOf(pg.db, ALL_KEYS);
    expect(before[changed]?.value).toBe(false);
    await runSeeds(pg.db);
    await runSeeds(pg.db);
    expect(await valuesOf(pg.db, ALL_KEYS)).toEqual({ ...allTrue(ALL_KEYS), [changed]: false });
    expect(await rowsOf(pg.db, ALL_KEYS)).toEqual(before);
  },
  120_000,
);

it.each(CORE_KEYS)(
  '[AC-B3-08j#3] 跑种子前库里已有 %s（人工写的 false）→ 种子不改它，另一行照常补上',
  async (existing) => {
    await pg.db
      .insertInto('config_items')
      .values({
        app_id: 'couli',
        key: existing,
        value: sql`'false'::jsonb`,
        updated_by: 'b3-08j-rule-test',
      })
      .execute();
    const before = await rowsOf(pg.db, [existing]);
    expect(before[existing]).toMatchObject({ value: false, updated_by: 'b3-08j-rule-test' });
    await runSeeds(pg.db);
    const after = await rowsOf(pg.db, CORE_KEYS);
    expect(after[existing]).toEqual(before[existing]);
    expect(Object.keys(after).sort()).toEqual([...CORE_KEYS].sort());
    const other = CORE_KEYS.find((key) => key !== existing);
    expect(other).toBeDefined();
    expect(after[other ?? ''], other).toMatchObject({
      value: true,
      type: 'boolean',
      updated_by: 'seed',
    });
  },
  120_000,
);

it('[AC-B3-08j#4][BR-AI-02] 回归：跑完全部种子后 B3-08g 的四个开关与本段两个开关都是 true；不种 agent.explain_order.order_no_daily_max、agent.orders.max_span_days', async () => {
  await runSeeds(pg.db);
  const rows = await rowsOf(pg.db, ALL_KEYS);
  expect(await valuesOf(pg.db, ALL_KEYS)).toEqual(allTrue(ALL_KEYS));
  expect(Object.values(rows).map((row) => row.type)).toEqual(ALL_KEYS.map(() => 'boolean'));
  expect(await rowsOf(pg.db, UNSEEDED)).toEqual({});
}, 120_000);
