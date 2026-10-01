// Database provisioning shared by the test globalSetup and the scripts in `packages/db/scripts`
// (bootstrap, migrate, snapshot). Tooling only: never imported by application code, and it
// uses devDependencies (node-pg-migrate, testcontainers) on purpose.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { pgUrl } from '../pg-url.ts';

/** PostgreSQL image for one-shot test databases; the local stack pins the same image. */
export const PG_TEST_IMAGE = 'pgvector/pgvector:0.8.6-pg18-trixie';

/** Cluster-wide roles created by db/bootstrap/roles.sql (ADR-0001 §4.2 #8). */
export const DB_ROLES = [
  'couli_migrator',
  'couli_app',
  'couli_payout',
  'couli_readonly',
  'couli_maint',
] as const;

export type DbRole = (typeof DB_ROLES)[number];

// packages/db/src/testing and packages/db/dist/testing are both four levels below the root.
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const DB_DIR = path.join(REPO_ROOT, 'db');
export const MIGRATIONS_DIR = path.join(DB_DIR, 'migrations');

// Advisory lock key that serialises cluster-level bootstrap between parallel runs.
const BOOTSTRAP_LOCK_KEY = 'couli:cluster-bootstrap';

export function quoteIdent(name: string): string {
  return pg.escapeIdentifier(name);
}

export function quoteLiteral(value: string): string {
  return pg.escapeLiteral(value);
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** Runs `fn` with a connected client and always closes it. */
export async function withClient<T>(
  connectionString: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Waits until the server accepts connections on `connectionString`. */
export async function waitForPg(connectionString: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await withClient(connectionString, async (client) => {
        await client.query('SELECT 1');
      });
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(`PostgreSQL did not become ready within ${String(timeoutMs)} ms`, {
          cause: error,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/** Runs db/bootstrap/roles.sql (idempotent). Needs a superuser connection. */
export async function applyRoles(adminUrl: string): Promise<void> {
  const sql = readFileSync(path.join(DB_DIR, 'bootstrap', 'roles.sql'), 'utf8');
  await withClient(adminUrl, async (client) => {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [BOOTSTRAP_LOCK_KEY]);
    await client.query(sql);
  });
}

/** Sets login passwords. Passwords never live in the repository (db/bootstrap/roles.sql). */
export async function setRolePasswords(
  adminUrl: string,
  passwords: Partial<Record<DbRole, string>>,
): Promise<void> {
  await withClient(adminUrl, async (client) => {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [BOOTSTRAP_LOCK_KEY]);
    for (const role of DB_ROLES) {
      const password = passwords[role];
      if (password !== undefined) {
        await client.query(`ALTER ROLE ${quoteIdent(role)} PASSWORD ${quoteLiteral(password)}`);
      }
    }
  });
}

export async function databaseExists(adminUrl: string, name: string): Promise<boolean> {
  return withClient(adminUrl, async (client) => {
    const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    return result.rowCount === 1;
  });
}

/** Creates database `name` owned by `owner`. Returns false when it already exists. */
export async function createDatabaseIfMissing(
  adminUrl: string,
  name: string,
  owner: DbRole,
): Promise<boolean> {
  if (await databaseExists(adminUrl, name)) {
    return false;
  }
  await withClient(adminUrl, async (client) => {
    await client.query(`CREATE DATABASE ${quoteIdent(name)} OWNER ${quoteIdent(owner)}`);
  });
  return true;
}

/** Runs db/bootstrap/extensions.sql in `database` as the superuser behind `adminUrl`. */
export async function applyExtensions(adminUrl: string, database: string): Promise<void> {
  const sql = readFileSync(path.join(DB_DIR, 'bootstrap', 'extensions.sql'), 'utf8');
  await withClient(pgUrl(adminUrl, { database }), async (client) => {
    await client.query(sql);
  });
}

/**
 * Applies every pending migration in db/migrations in one transaction and returns the names
 * that were run. `migratorUrl` must connect as couli_migrator (C8).
 */
export async function runMigrations(
  migratorUrl: string,
  log: (message: string) => void = () => {},
): Promise<string[]> {
  const { runner } = await import('node-pg-migrate');
  const applied = await runner({
    databaseUrl: migratorUrl,
    dir: MIGRATIONS_DIR,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    migrationsSchema: 'public',
    checkOrder: true,
    singleTransaction: true,
    logger: { info: log, warn: log, error: log },
  });
  return applied.map((migration) => migration.name);
}

/**
 * Passwords for the five roles of a one-shot test cluster, derived from its admin URL.
 * They are random per cluster (the admin password is), unknown to test code (it never sees
 * the admin URL), and identical for every package that shares the cluster through
 * TEST_PG_ADMIN_URL, so parallel runs do not invalidate each other's connections.
 */
export function derivedRolePasswords(adminUrl: string): Record<DbRole, string> {
  const derive = (role: DbRole): string =>
    createHash('sha256').update(`couli-test-role\n${adminUrl}\n${role}`).digest('hex').slice(0, 32);
  return {
    couli_migrator: derive('couli_migrator'),
    couli_app: derive('couli_app'),
    couli_payout: derive('couli_payout'),
    couli_readonly: derive('couli_readonly'),
    couli_maint: derive('couli_maint'),
  };
}

/**
 * Builds database `name` exactly like a real environment: bootstrap (roles, extensions) as
 * superuser, then every migration as couli_migrator. Used for the test template and for the
 * schema snapshot.
 */
export async function buildMigratedDatabase(adminUrl: string, name: string): Promise<void> {
  const passwords = derivedRolePasswords(adminUrl);
  await applyRoles(adminUrl);
  await setRolePasswords(adminUrl, passwords);
  await withClient(adminUrl, async (client) => {
    await client.query(`CREATE DATABASE ${quoteIdent(name)} OWNER couli_migrator`);
  });
  await applyExtensions(adminUrl, name);
  await runMigrations(
    pgUrl(adminUrl, {
      user: 'couli_migrator',
      password: passwords.couli_migrator,
      database: name,
    }),
  );
}

/**
 * One-shot clusters only: refuse a cluster that holds the `couli` database (the local dev
 * stack or a real environment), because provisioning resets the role passwords.
 */
export async function assertOneShotCluster(adminUrl: string): Promise<void> {
  if (await databaseExists(adminUrl, 'couli')) {
    throw new Error(
      'TEST_PG_ADMIN_URL points at a cluster that contains the "couli" database. ' +
        'Tests and snapshots need a one-shot PostgreSQL, never the dev stack (ADR-0001 §4.2 #9).',
    );
  }
}

export type ExecResult = { stdout: string; stderr: string; exitCode: number };

export type AdminPg = {
  /** Superuser connection URL. Never hand this to test code. */
  adminUrl: string;
  source: 'env' | 'testcontainers';
  /** Milliseconds spent starting the container (0 when TEST_PG_ADMIN_URL was used). */
  startMs: number;
  /** Runs a command inside the PostgreSQL container; null when the server is external. */
  exec: ((command: string[]) => Promise<ExecResult>) | null;
  stop(): Promise<void>;
};

async function startContainer<T>(start: () => Promise<T>): Promise<T> {
  try {
    return await start();
  } catch (error) {
    throw new Error(
      'Could not start a PostgreSQL container. Integration tests and snapshots need either ' +
        'Docker (Testcontainers) or TEST_PG_ADMIN_URL pointing at a one-shot PostgreSQL ' +
        '(ADR-0001 §4.2 #9); neither works inside the Codex sandbox.',
      { cause: error },
    );
  }
}

/**
 * Single entry point to the one-shot test PostgreSQL (ADR-0001 §4.2 #9): TEST_PG_ADMIN_URL
 * when set (verify container, CI service), otherwise a Testcontainers container on the host.
 */
export async function acquireAdminPg(): Promise<AdminPg> {
  const fromEnv = process.env['TEST_PG_ADMIN_URL'];
  if (fromEnv !== undefined && fromEnv !== '') {
    await waitForPg(fromEnv);
    await assertOneShotCluster(fromEnv);
    return { adminUrl: fromEnv, source: 'env', startMs: 0, exec: null, stop: async () => {} };
  }

  const startedAt = Date.now();
  const { GenericContainer, Wait } = await import('testcontainers');
  const password = randomHex(16);
  const container = await startContainer(() =>
    new GenericContainer(PG_TEST_IMAGE)
      .withEnvironment({ POSTGRES_PASSWORD: password })
      .withExposedPorts(5432)
      // Throwaway data: keep it in memory and skip durability work.
      .withTmpFs({ '/var/lib/postgresql': 'rw' })
      .withCommand([
        'postgres',
        '-c',
        'fsync=off',
        '-c',
        'synchronous_commit=off',
        '-c',
        'full_page_writes=off',
      ])
      .withLabels({ 'couli.purpose': 'one-shot-test-pg' })
      // The image starts a temporary server for initdb first; the second message is the real one.
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .withStartupTimeout(120_000)
      .start(),
  );
  // `password` is hex, so it needs no escaping.
  const hostPort = `${container.getHost()}:${String(container.getMappedPort(5432))}`;
  const adminUrl = `postgres://postgres:${password}@${hostPort}/postgres`;
  try {
    await waitForPg(adminUrl);
  } catch (error) {
    await container.stop();
    throw error;
  }
  return {
    adminUrl,
    source: 'testcontainers',
    startMs: Date.now() - startedAt,
    exec: async (command) => {
      const result = await container.exec(command);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
    stop: async () => {
      await container.stop();
    },
  };
}
