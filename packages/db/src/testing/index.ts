// Test database helper (`@couli/db/testing`), ADR-0001 §4.2 #9.
// Requires the globalSetup `@couli/db/testing/global-setup` in the vitest config.
import pg from 'pg';
import { inject } from 'vitest';

import { pgUrl } from '../pg-url.ts';
import { TEST_DB_CONTEXT_KEY, type TestDbContext, type TestDbRole } from './context.ts';
import { PG_TEST_IMAGE, quoteIdent, randomHex } from './provision.ts';

export { PG_TEST_IMAGE };
export { TEST_DB_ROLES } from './context.ts';
export type { TestDbContext, TestDbRole } from './context.ts';

export type TestDatabase = {
  /** Database name, unique within the cluster. */
  name: string;
  /** Connection URL for one of the business roles. Tests never connect as superuser. */
  urlFor(role: TestDbRole): string;
  /** Drops the database, terminating connections that are still open. */
  drop(): Promise<void>;
};

function context(): TestDbContext {
  const value = inject(TEST_DB_CONTEXT_KEY);
  // `inject` returns undefined at runtime when the globalSetup did not run.
  if ((value as TestDbContext | undefined) === undefined) {
    throw new Error(
      'No test database context: add "@couli/db/testing/global-setup" to globalSetup ' +
        '(integrationConfig in vitest.shared.ts).',
    );
  }
  return value;
}

async function asFactory(ctx: TestDbContext, statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: ctx.factoryUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

/**
 * Clones a fresh database from the migrated template. Call it once per test file (in
 * `beforeAll`) and `drop()` it in `afterAll`; leftovers are removed by the global teardown.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const ctx = context();
  const name = `couli_t_${ctx.runId}_${randomHex(6)}`;
  await asFactory(ctx, `CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(ctx.template)}`);
  return {
    name,
    urlFor(role: TestDbRole): string {
      return pgUrl(ctx.factoryUrl, {
        user: role,
        password: ctx.rolePasswords[role],
        database: name,
      });
    },
    async drop(): Promise<void> {
      await asFactory(ctx, `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    },
  };
}
