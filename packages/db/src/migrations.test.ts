// Static checks on db/migrations and db/bootstrap. Reads files only; no database.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { MONTH_PARTITIONED_TABLES } from './partitions.ts';

const DB_DIR = fileURLToPath(new URL('../../../db/', import.meta.url));
const MIGRATIONS_DIR = path.join(DB_DIR, 'migrations');

const files = readdirSync(MIGRATIONS_DIR).sort();
const migrations = files.map((name) => ({
  name,
  text: readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
}));

/** Names of the migrations whose text matches `pattern`. */
function matching(pattern: RegExp): string[] {
  return migrations.filter((migration) => pattern.test(migration.text)).map((m) => m.name);
}

it('migration files are named NNNN_kebab-name.sql and numbered without gaps', () => {
  expect(files.length).toBeGreaterThan(0);
  expect(files.filter((name) => !/^\d{4}_[a-z0-9]+(-[a-z0-9]+)*\.sql$/.test(name))).toEqual([]);
  expect(files.map((name) => Number(name.slice(0, 4)))).toEqual(files.map((_, i) => i + 1));
});

it('every migration starts with the Up marker and has no Down section', () => {
  expect(
    migrations.filter((m) => !m.text.startsWith('-- Up Migration\n')).map((m) => m.name),
  ).toEqual([]);
  expect(matching(/^--\s*Down Migration/im)).toEqual([]);
});

it('no migration controls the transaction itself', () => {
  // node-pg-migrate wraps all pending migrations in one transaction; a BEGIN or COMMIT inside
  // a file would end it early (ADR-0001 §4.2 #14).
  expect(matching(/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\s*;/im)).toEqual([]);
});

it('no migration uses uuidv7() or creates extensions', () => {
  // PostgreSQL 17 has no uuidv7(); extensions need a superuser (db/bootstrap/extensions.sql).
  expect(matching(/uuidv7\s*\(/i)).toEqual([]);
  expect(matching(/CREATE\s+EXTENSION/i)).toEqual([]);
});

it('no migration creates a date-dependent partition', () => {
  // Only DEFAULT partitions are allowed in migrations; month partitions are created at
  // runtime by app.ensure_month_partition. The pg-boss file creates partitions by list inside
  // its own functions (dynamic SQL), which this pattern does not match.
  expect(matching(/^\s*CREATE TABLE\b[^;]*\bPARTITION OF\b[^;]*\bFOR VALUES\b/im)).toEqual([]);
});

it('the pg-boss migration drops its day partitions and grants its tables to both app roles', () => {
  const pgboss = migrations.filter((m) => /pgboss/.test(m.name));
  expect(pgboss.map((m) => m.name)).toEqual(['0002_pgboss-schema-v42.sql']);
  const text = pgboss[0]?.text ?? '';
  // The plan's day partitions of queue_stats are dropped again (date-independent schema).
  expect(text).toContain("EXECUTE format('DROP TABLE pgboss.%I', v_partition);");
  expect(text).toContain('GRANT USAGE ON SCHEMA pgboss TO couli_app, couli_payout;');
  expect(text).toContain(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO couli_app, couli_payout;',
  );
});

it('the SQL allow-list of month-partitioned tables matches MONTH_PARTITIONED_TABLES', () => {
  const all = migrations.map((m) => m.text).join('\n');
  const lists = [...all.matchAll(/IF p_table NOT IN \(([^)]*)\) THEN/g)];
  // The newest definition of the function wins.
  const latest = lists.at(-1)?.[1] ?? '';
  const tables = [...latest.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  expect(tables).toEqual([...MONTH_PARTITIONED_TABLES]);
});

it('roles.sql creates the five roles and contains no password', () => {
  const roles = readFileSync(path.join(DB_DIR, 'bootstrap', 'roles.sql'), 'utf8');
  for (const role of [
    'couli_migrator',
    'couli_app',
    'couli_payout',
    'couli_readonly',
    'couli_maint',
  ]) {
    expect(roles).toContain(`'${role}'`);
  }
  // Comments may mention the word; statements must not set one.
  const statements = roles
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  expect(statements).not.toMatch(/PASSWORD/i);
});
