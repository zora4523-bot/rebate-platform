// Vitest globalSetup for integration tests (ADR-0001 §4.2 #9).
//
// One PostgreSQL per run: TEST_PG_ADMIN_URL when set, otherwise a Testcontainers container.
// Migrations run once into a template database; every test file clones its own database from
// it (see `createTestDatabase`). Test workers only receive a CREATEDB role and the passwords
// of the business roles, never the superuser URL.
import type { TestProject } from 'vitest/node';

import { parsePgUrl, pgUrl } from '../pg-url.ts';
import { TEST_DB_CONTEXT_KEY, type TestDbContext } from './context.ts';
import {
  acquireAdminPg,
  buildMigratedDatabase,
  derivedRolePasswords,
  quoteIdent,
  quoteLiteral,
  randomHex,
  withClient,
} from './provision.ts';

function note(message: string): void {
  process.stderr.write(`[couli-db] ${message}\n`);
}

async function dropRunObjects(adminUrl: string, context: TestDbContext): Promise<void> {
  const factoryRole = parsePgUrl(context.factoryUrl).user;
  await withClient(adminUrl, async (client) => {
    const clones = await client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname LIKE $1',
      [`couli\\_t\\_${context.runId}\\_%`],
    );
    for (const row of clones.rows) {
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(row.datname)} WITH (FORCE)`);
    }
    const template = quoteIdent(context.template);
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      context.template,
    ]);
    if (exists.rowCount === 1) {
      await client.query(`ALTER DATABASE ${template} WITH is_template false`);
      await client.query(`DROP DATABASE ${template} WITH (FORCE)`);
    }
    await client.query(`DROP ROLE IF EXISTS ${quoteIdent(factoryRole)}`);
  });
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const admin = await acquireAdminPg();
  // Workers are forked after this point and must not inherit the superuser URL.
  delete process.env['TEST_PG_ADMIN_URL'];

  const runId = randomHex(4);
  const template = `couli_tpl_${runId}`;
  const factoryRole = `couli_factory_${runId}`;
  const factoryPassword = randomHex(16);
  const passwords = derivedRolePasswords(admin.adminUrl);
  const { host, port } = parsePgUrl(admin.adminUrl);
  const context: TestDbContext = {
    runId,
    factoryUrl: pgUrl(admin.adminUrl, { user: factoryRole, password: factoryPassword }),
    template,
    host,
    port,
    rolePasswords: {
      couli_app: passwords.couli_app,
      couli_payout: passwords.couli_payout,
      couli_readonly: passwords.couli_readonly,
      couli_maint: passwords.couli_maint,
    },
  };

  try {
    const templateStartedAt = Date.now();
    await buildMigratedDatabase(admin.adminUrl, template);
    await withClient(admin.adminUrl, async (client) => {
      // A template that accepts no connections can be cloned by any CREATEDB role at any time.
      await client.query(
        `ALTER DATABASE ${quoteIdent(template)} WITH is_template true allow_connections false`,
      );
      // The factory role may create (and force-drop) databases and nothing else.
      await client.query(
        `CREATE ROLE ${quoteIdent(factoryRole)} LOGIN CREATEDB NOSUPERUSER NOCREATEROLE ` +
          `PASSWORD ${quoteLiteral(factoryPassword)}`,
      );
      await client.query(`GRANT pg_signal_backend TO ${quoteIdent(factoryRole)}`);
    });
    note(
      `test PostgreSQL ready (${admin.source}): container start ${String(admin.startMs)} ms, ` +
        `template ${template} built in ${String(Date.now() - templateStartedAt)} ms`,
    );
  } catch (error) {
    await dropRunObjects(admin.adminUrl, context).catch(() => {});
    await admin.stop();
    throw error;
  }

  project.provide(TEST_DB_CONTEXT_KEY, context);

  return async () => {
    try {
      await dropRunObjects(admin.adminUrl, context);
    } finally {
      await admin.stop();
    }
  };
}
