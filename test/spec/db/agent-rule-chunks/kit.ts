import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import type { TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export type Row = Record<string, unknown>;
export const APP_ID = 'synthetic-rule-chunks';
export const AT = new Date('2026-10-23T08:00:00Z');
export const LATER = new Date('2026-10-23T09:00:00Z');

// Only the integration entry imports the database factory as a value.
export async function createKit(factory: () => Promise<TestDatabase>) {
  const database = await factory();
  const app = createDb({ connectionString: database.urlFor('couli_app') });
  const readonly = createDb({ connectionString: database.urlFor('couli_readonly') });

  async function requireTable() {
    const result = await sql<{ kind: string }>`
      SELECT c.relkind::text AS kind FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relname = 'rule_chunks'
    `.execute(app);
    expect(result.rows, 'B3-08e must create app.rule_chunks before DML').toEqual([{ kind: 'r' }]);
  }

  async function article(
    category: 'help' | 'rule' = 'help',
    id: string = randomUUID(),
    version = 1,
  ) {
    await sql`INSERT INTO app.articles
      (id, app_id, category, title, body, version, status, published_at, notice_closable)
      VALUES (${id}, ${APP_ID}, ${category}, '规则标题', '规则正文', ${version},
        'published', ${AT}, false)`.execute(app);
    return id;
  }

  async function fixture(category: 'help' | 'rule' = 'help'): Promise<Row> {
    await requireTable();
    return {
      chunk_id: randomUUID(),
      app_id: APP_ID,
      article_id: await article(category),
      published_version: 1,
      seq: 0,
      title: '规则标题',
      text: '规则正文',
    };
  }

  async function insert(row: Row, db: Kysely<DB> = app) {
    const names = Object.keys(row);
    return sql`INSERT INTO app.rule_chunks (${sql.join(names.map((name) => sql.ref(name)))})
      VALUES (${sql.join(names.map((name) => row[name]))})`.execute(db);
  }

  async function update(id: unknown, patch: Row, db: Kysely<DB> = app) {
    return sql`UPDATE app.rule_chunks SET
      ${sql.join(Object.entries(patch).map(([name, value]) => sql`${sql.ref(name)} = ${value}`))}
      WHERE chunk_id = ${id}`.execute(db);
  }

  async function stored(id: unknown) {
    const result = await sql<Row>`SELECT * FROM app.rule_chunks WHERE chunk_id = ${id}`.execute(
      app,
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0]!;
  }

  return {
    app,
    readonly,
    requireTable,
    article,
    fixture,
    insert,
    update,
    stored,
    async close() {
      await Promise.all([destroyDb(app), destroyDb(readonly)]);
      await database.drop();
    },
  };
}

// Re-throw non-PG failures: a broken fixture cannot masquerade as an expected SQLSTATE.
export async function sqlState(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
    return 'OK';
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
    ) {
      return error.code;
    }
    throw error;
  }
}
