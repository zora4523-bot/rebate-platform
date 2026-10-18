import { readFileSync, readdirSync } from 'node:fs';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { constraints, indexes } from './catalog.ts';
import { TABLES, ready } from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;
let readonly: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
});
afterAll(async () => {
  if (app) await destroyDb(app);
  if (readonly) await destroyDb(readonly);
  if (database) await database.drop();
});
const h = {
  get app() {
    return app;
  },
  get readonly() {
    return readonly;
  },
};

function migrationSource() {
  const directory = new URL('../../../../db/migrations/', import.meta.url);
  const matches = readdirSync(directory).filter((name) => /^\d{4}_order-claims\.sql$/.test(name));
  expect(matches, 'find migration by suffix, never reserve its numeric prefix').toHaveLength(1);
  const text = readFileSync(new URL(matches[0] ?? '', directory), 'utf8');
  expect(text).not.toMatch(/\bsquawk-ignore/i);
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .replace(/"/g, '');
}

it('[AC-B1-10a#32] migration explicitly names constraints/indexes and grants both tables in the same file', async () => {
  await ready(h.app);
  const source = migrationSource();
  for (const table of TABLES) {
    expect(source).toMatch(
      new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?app\\.${table}\\s*\\(`, 'i'),
    );
    for (const c of await constraints(h.app, table)) {
      expect(source, c.name).toMatch(new RegExp(`\\bCONSTRAINT\\s+${c.name}\\s`, 'i'));
    }
    const constraintNames = new Set((await constraints(h.app, table)).map((c) => c.name));
    for (const index of await indexes(h.app, table)) {
      if (!constraintNames.has(index.name)) {
        expect(source, index.name).toMatch(
          new RegExp(
            `CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${index.name}\\s`,
            'i',
          ),
        );
      }
    }
    for (const role of ['couli_app', 'couli_readonly']) {
      expect(source).toMatch(
        new RegExp(
          `GRANT\\s+[^;]+\\bON\\s+(?:TABLE\\s+)?[^;]*\\bapp\\.${table}\\b[^;]*\\bTO\\s+${role}\\b`,
          'i',
        ),
      );
    }
  }
});

it('[AC-B1-10a#33] J-a reference key uses an added unique index followed by UNIQUE USING INDEX', async () => {
  await ready(h.app);
  const source = migrationSource();
  const index =
    /CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(?:ONLY\s+)?app\.order_keys\s*(?:USING\s+btree\s*)?\(([^)]+)\)/i.exec(
      source,
    );
  expect(index).not.toBeNull();
  expect(new Set(index?.[2]?.split(',').map((s) => s.trim()))).toEqual(
    new Set(['app_id', 'platform', 'sub_order_id', 'order_id']),
  );
  const attach = new RegExp(
    `ALTER\\s+TABLE\\s+(?:ONLY\\s+)?app\\.order_keys\\s+ADD\\s+CONSTRAINT\\s+order_keys_claim_ref_key\\s+UNIQUE\\s+USING\\s+INDEX\\s+${index?.[1]}\\b`,
    'i',
  );
  const match = attach.exec(source);
  expect(match).not.toBeNull();
  expect(match?.index).toBeGreaterThan(index?.index ?? -1);
});

it('[AC-B1-10a#34] migration adds no deletion, partition or retention logic and preserves order_keys permissions', async () => {
  await ready(h.app);
  const source = migrationSource();
  expect(source).not.toMatch(
    /\b(?:DELETE\s+FROM|TRUNCATE|DROP|RENAME|PARTITION\s+BY|CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|CREATE\s+TRIGGER)\b/i,
  );
  for (const role of ['couli_app', 'couli_readonly']) {
    for (const privilege of [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER',
    ]) {
      const allowed = privilege === 'SELECT' || (role === 'couli_app' && privilege === 'INSERT');
      const result = await sql<{ allowed: boolean }>`SELECT has_table_privilege(
        ${role}, 'app.order_keys', ${privilege}) AS allowed`.execute(h.app);
      expect(result.rows, `${role}/${privilege}`).toEqual([{ allowed }]);
    }
  }
});
