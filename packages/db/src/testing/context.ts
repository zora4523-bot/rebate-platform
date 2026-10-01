// Shape of the data handed from the globalSetup to test workers through vitest `provide`.
// It deliberately contains no superuser credentials (ADR-0001 §4.2 #9).

/** Roles a test may connect as. couli_migrator is not offered: tests never run DDL. */
export const TEST_DB_ROLES = [
  'couli_app',
  'couli_payout',
  'couli_readonly',
  'couli_maint',
] as const;

export type TestDbRole = (typeof TEST_DB_ROLES)[number];

export type TestDbContext = {
  /** Identifies this test run; part of every database and role name it creates. */
  runId: string;
  /** Connection URL of the per-run CREATEDB role that clones databases from the template. */
  factoryUrl: string;
  /** Template database: bootstrap + every migration, marked is_template. */
  template: string;
  host: string;
  port: number;
  rolePasswords: Record<TestDbRole, string>;
};

export const TEST_DB_CONTEXT_KEY = 'couliTestDb';

declare module 'vitest' {
  export interface ProvidedContext {
    couliTestDb: TestDbContext;
  }
}
