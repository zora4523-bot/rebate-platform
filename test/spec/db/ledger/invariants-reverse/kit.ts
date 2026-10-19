// B2-02l / BR-FUND-16, BR-FUND-19: execute the registered SQL, never emulate it.
// SQL is append-only: no placeholder SQL/manifest is written during the test phase.
import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { DAY, type Result } from '../invariants/kit.ts';

const DIRECTORY = new URL('../../../../../db/invariants/ledger/', import.meta.url);
const ORIGINALS = { '03': '03_credit-unique.sql', '04': '04_beneficiary-net.sql' };
type Code = keyof typeof ORIGINALS;
interface Replacement {
  file: string;
  replaced_by: string;
  reason: string;
}
interface Database {
  urlFor(role: 'couli_app' | 'couli_readonly'): string;
  drop(): Promise<void>;
}
interface Fixture {
  db: Kysely<DB>;
  check(code: Code, legacy?: boolean, date?: string): Promise<Result[]>;
}

export function replacements(): Replacement[] {
  const path = new URL('superseded.json', DIRECTORY);
  expect(existsSync(path), 'B2-02l: superseded.json must register the replacement').toBe(true);
  const raw = readFileSync(path, 'utf8');
  expect(() => JSON.parse(raw) as unknown, 'replacement registry must be valid JSON').not.toThrow();
  const parsed: unknown = JSON.parse(raw);
  expect(Array.isArray(parsed)).toBe(true);
  const rows = parsed as Replacement[];
  for (const row of rows) {
    expect(row).toEqual({
      file: expect.any(String),
      replaced_by: expect.any(String),
      reason: expect.any(String),
    });
    expect(row.reason.trim().length).toBeGreaterThan(0);
    expect(row.file).toMatch(/^\d+_[\w-]+\.sql$/);
    expect(row.replaced_by).toMatch(/^\d+_[\w-]+\.sql$/);
    expect(row.replaced_by).not.toBe(row.file);
    expect(existsSync(new URL(row.file, DIRECTORY))).toBe(true);
    expect(existsSync(new URL(row.replaced_by, DIRECTORY))).toBe(true);
  }
  expect(new Set(rows.map((row) => row.file)).size).toBe(rows.length);
  expect(rows.filter((row) => row.file === ORIGINALS['03'])).toHaveLength(1);
  for (const code of ['03', '04'] as const) {
    const replacement = rows.find((row) => row.file === ORIGINALS[code]);
    if (replacement) expect(replacement.replaced_by).not.toMatch(/^0[3-8]_/);
    expect(readdirSync(DIRECTORY).filter((name) => name.startsWith(`${code}_`))).toEqual([
      ORIGINALS[code],
    ]);
  }
  return rows;
}

function source(file: string): string {
  expect(existsSync(new URL(file, DIRECTORY)), `invariant SQL exists: ${file}`).toBe(true);
  const raw = readFileSync(new URL(file, DIRECTORY), 'utf8');
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

// Only the *.int.test.ts caller imports the public database factory.
// Each scenario checks the deployed combination (replacement 03 + active 04).
export async function scenario(
  create: () => Promise<Database>,
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const registry = replacements();
  const active = (code: Code) =>
    registry.find((row) => row.file === ORIGINALS[code])?.replaced_by ?? ORIGINALS[code];
  const queries = {
    '03': source(active('03')),
    '04': source(active('04')),
  };
  const database = await create();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  const reader = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
  try {
    await run({
      db,
      async check(code, legacy = false, date = DAY) {
        const query = legacy ? source(ORIGINALS[code]) : queries[code];
        const filename = legacy ? ORIGINALS[code] : active(code);
        return reader
          .transaction()
          .setIsolationLevel('repeatable read')
          .execute(async (trx) => {
            await sql`SET TRANSACTION READ ONLY`.execute(trx);
            await sql`SELECT set_config('couli.check_date', ${date}, true)`.execute(trx);
            const { rows } = await sql.raw<Result>(query).execute(trx);
            expect(rows.length, 'must return differences or exactly one none row').toBeGreaterThan(
              0,
            );
            for (const row of rows) {
              expect(Object.keys(row).sort()).toEqual([
                'account_id',
                'app_id',
                'checked_rows',
                'detail',
                'invariant',
                'scope',
              ]);
              if (code === '03') expect(row.invariant).toBe('03');
              else expect([code, filename.split('_')[0]]).toContain(row.invariant);
              expect(row.invariant).toBe(rows[0]!.invariant);
              expect(typeof row.checked_rows).toBe('bigint');
              expect(row.checked_rows, 'D18: zero checked rows is not success').toBeGreaterThan(0n);
              expect(row.checked_rows).toBe(rows[0]!.checked_rows);
              expect(['none', 'global']).toContain(row.scope);
            }
            const types = await sql
              .raw<Record<string, string>>(
                `SELECT
            pg_typeof(invariant)::text AS invariant, pg_typeof(checked_rows)::text AS checked_rows,
            pg_typeof(scope)::text AS scope, pg_typeof(app_id)::text AS app_id,
            pg_typeof(account_id)::text AS account_id, pg_typeof(detail)::text AS detail
            FROM (${query}\n) AS result LIMIT 1`,
              )
              .execute(trx);
            expect(types.rows).toEqual([
              {
                invariant: 'text',
                checked_rows: 'bigint',
                scope: 'text',
                app_id: 'text',
                account_id: 'uuid',
                detail: 'jsonb',
              },
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
