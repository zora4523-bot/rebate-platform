import { integrationConfig } from '../../vitest.shared.ts';

// Needs PostgreSQL: TEST_PG_ADMIN_URL if set, otherwise Testcontainers (ADR-0001 §4.2 #9).
// The global setup is the source file of the test-database base in packages/db: Vitest resolves
// globalSetup without the `couli-src` condition, so the package specifier would load
// packages/db/dist, which a fresh checkout does not have and an edit of the source leaves stale.
export default integrationConfig({
  globalSetup: ['../../packages/db/src/testing/global-setup.ts'],
});
