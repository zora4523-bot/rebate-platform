// The existing harness migrates before cloning and supplies business roles only.
// Replay the migration's actual INSERT ... SELECT as couli_app, after fixture INSERTs;
// do not recreate its mapping in test SQL, run DDL, or acquire migrator credentials.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { unique } from '../kit.ts';
import { ready } from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
});

afterAll(async () => {
  if (app) await destroyDb(app);
  await database?.drop();
});

// Split plain SQL migrations at statement boundaries, retaining quoted contents
// (including semicolons) and discarding comments. Dollar-quoted function bodies
// remain one token, so an INSERT inside a function is not mistaken for backfill.
function statements(source: string): string[] {
  const tokens = source.matchAll(
    /--[^\n]*|\/\*[\s\S]*?\*\/|(?:E)?'(?:''|\\.|[^'\\])*'|"(?:""|[^"])*"|(\$[A-Za-z_0-9]*\$)[\s\S]*?\1|[^;'"$/-]+|./gs,
  );
  const result: string[] = [];
  let current = '';
  for (const [token] of tokens) {
    if (token.startsWith('--') || token.startsWith('/*')) {
      current += ' ';
    } else if (token === ';') {
      if (current.trim()) result.push(current.trim());
      current = '';
    } else {
      current += token;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function migration(): { statements: string[]; backfill: string[] } {
  const directory = fileURLToPath(new URL('../../../../../db/migrations/', import.meta.url));
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => statements(readFileSync(`${directory}${name}`, 'utf8')));
  // Discover by the object being created, never a migration filename/number.
  const creators = files.filter((list) =>
    list.some((s) =>
      /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?app\s*\.\s*config_item_versions\s*\(/i.test(
        s.replaceAll('"', ''),
      ),
    ),
  );
  expect(creators, 'one additive migration creates the history table').toHaveLength(1);
  const list = creators[0]!;
  const backfill = list.filter((s) =>
    /^INSERT\s+INTO\s+app\s*\.\s*config_item_versions\b/i.test(s.replaceAll('"', '')),
  );
  expect(backfill.length, 'backfill belongs to the table-creation migration').toBeGreaterThan(0);
  expect(
    backfill.some((s) => /\bFROM\s+app\s*\.\s*config_items\b/i.test(s.replaceAll('"', ''))),
  ).toBe(true);
  return { statements: list, backfill };
}

it('[AC-F1-10a#10] table creation, backfill and grants to all three roles share one migration', async () => {
  await ready(app);
  const source = migration();
  for (const role of ['couli_app', 'couli_readonly', 'couli_payout']) {
    const grants = source.statements.filter((s) => /^GRANT\s/i.test(s));
    expect(
      grants.some((s) => {
        const normalized = s.replaceAll('"', '');
        const parts = normalized.split(/\bTO\b/i);
        return (
          /\bapp\s*\.\s*config_item_versions\b/i.test(parts[0] ?? '') &&
          new RegExp(`\\b${role}\\b`).test(parts[1] ?? '')
        );
      }),
      `creation migration grants ${role}`,
    ).toBe(true);
  }
});

it('[AC-F1-10a#11] backfill copies every current version once, with original JSON, actor and updated_at', async () => {
  await ready(app);
  const source = migration();
  const firstApp = unique('backfill_a_');
  const secondApp = unique('backfill_b_');
  const fixtures = [
    {
      app_id: firstApp,
      key: 'payout.enabled',
      version: 1,
      value: false,
      updated_by: 'system:seed',
    },
    { app_id: secondApp, key: 'payout.enabled', version: 9, value: true, updated_by: '旧管理员' },
    {
      app_id: firstApp,
      key: 'limits.custom',
      version: 17,
      value: { nested: [0, null, '中文'], enabled: false },
      updated_by: 'deleted-admin',
    },
    { app_id: secondApp, key: '', version: 3, value: null, updated_by: 'system:migration' },
  ].map((row, index) => ({
    ...row,
    created_at: new Date('2025-01-01T00:00:00.000Z'),
    updated_at: new Date(`2026-09-0${String(index + 1)}T04:05:06.789Z`),
    row_version: 40 + index,
  }));
  for (const row of fixtures) {
    await sql`
      INSERT INTO app.config_items
        (app_id, key, version, value, updated_by, created_at, updated_at, row_version)
      VALUES (${row.app_id}, ${row.key}, ${row.version}, ${JSON.stringify(row.value)}::jsonb,
              ${row.updated_by}, ${row.created_at}, ${row.updated_at}, ${row.row_version})
    `.execute(app);
  }
  const query = sql<Record<string, unknown>>`
    SELECT app_id, key, version, value, updated_by, updated_by_admin_id, reason, created_at
    FROM app.config_item_versions WHERE app_id IN (${firstApp}, ${secondApp})
  `;
  expect((await query.execute(app)).rows, 'fixtures precede the backfill').toEqual([]);
  await app.transaction().execute(async (trx) => {
    for (const statement of source.backfill) await sql.raw(statement).execute(trx);
  });
  const actual = (await query.execute(app)).rows;
  expect(actual).toHaveLength(fixtures.length);
  for (const row of fixtures) {
    expect(actual).toContainEqual({
      app_id: row.app_id,
      key: row.key,
      version: row.version,
      value: row.value,
      updated_by: row.updated_by,
      updated_by_admin_id: null,
      reason: null,
      created_at: row.updated_at,
    });
  }
  const current = await sql<Record<string, unknown>>`
    SELECT app_id, key, version, value, updated_by, created_at, updated_at, row_version
    FROM app.config_items WHERE app_id IN (${firstApp}, ${secondApp})
  `.execute(app);
  expect(current.rows).toHaveLength(fixtures.length);
  for (const row of fixtures) expect(current.rows).toContainEqual(row);
});
