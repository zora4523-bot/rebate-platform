// B3-08g · BR-AI-02 细则「开关」(MVP 工具默认 on): the seeds of db/seeds/** (every file in file-name
// order, each in its own transaction, as packages/db/scripts/seed.ts runs them; couli_app holds
// INSERT on config_items, all an INSERT … ON CONFLICT DO NOTHING needs) switch the four tools of this
// segment on for app couli as JSON booleans. Re-running is harmless and keeps operator changes.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { setConfig, usePgEach } from '../stream-mount/kit.ts';
import { NEW_TOOLS, switchKey } from './scan.ts';

const pg = usePgEach(createTestDatabase);

const SEEDS = fileURLToPath(new URL('../../../../db/seeds/', import.meta.url));
const KEYS = NEW_TOOLS.map(switchKey);

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

/** The keys among `keys` that app couli has a config_items row for. */
async function presentKeys(db: Kysely<DB>, keys: readonly string[]): Promise<string[]> {
  const rows = await db
    .selectFrom('config_items')
    .select('key')
    .where('app_id', '=', 'couli')
    .where('key', 'in', [...keys])
    .execute();
  return rows.map((row) => row.key);
}

async function switches(db: Kysely<DB>): Promise<Record<string, unknown>> {
  const rows = await db
    .selectFrom('config_items')
    .select(['key', 'value'])
    .where('app_id', '=', 'couli')
    .where('key', 'in', KEYS)
    .execute();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

it('[AC-B3-08g#10][BR-AI-02] 执行 seeds 后 couli 的 agent.tools.{handoff_to_human,prefill_claim,list_my_orders,explain_order}.enabled = true（jsonb 布尔）；不种计数上限与跨度', async () => {
  await runSeeds(pg.db);
  expect(await switches(pg.db)).toEqual(Object.fromEntries(KEYS.map((key) => [key, true])));
  const types = await sql<{ key: string; type: string }>`
    SELECT key, jsonb_typeof(value) AS type FROM app.config_items
    WHERE app_id = 'couli' AND key IN (${sql.join(KEYS)}) ORDER BY key`.execute(pg.db);
  expect(types.rows.map((row) => row.type)).toEqual(KEYS.map(() => 'boolean'));
  // Code defaults cover these (BR-AI-07); they are not seeded.
  const unseeded = await presentKeys(pg.db, [
    'agent.explain_order.order_no_daily_max',
    'agent.orders.max_span_days',
  ]);
  expect(unseeded).toEqual([]);
}, 120_000);

it('[AC-B3-08g#10][BR-AI-02] 重复执行 seeds 不报错、不覆盖人工改过的值（先改 false 再跑仍 false）', async () => {
  await runSeeds(pg.db);
  expect(await switches(pg.db)).toEqual(Object.fromEntries(KEYS.map((key) => [key, true])));
  const [changed, ...rest] = KEYS;
  await setConfig(pg.db, 'couli', changed!, false);
  const before = await sql<{ key: string; version: number; updated_by: string }>`
    SELECT key, version, updated_by FROM app.config_items
    WHERE app_id = 'couli' AND key IN (${sql.join(KEYS)}) ORDER BY key`.execute(pg.db);
  await runSeeds(pg.db);
  await runSeeds(pg.db);
  expect(await switches(pg.db)).toEqual({
    [changed!]: false,
    ...Object.fromEntries(rest.map((key) => [key, true])),
  });
  const after = await sql<{ key: string; version: number; updated_by: string }>`
    SELECT key, version, updated_by FROM app.config_items
    WHERE app_id = 'couli' AND key IN (${sql.join(KEYS)}) ORDER BY key`.execute(pg.db);
  expect(after.rows).toEqual(before.rows);
}, 120_000);
