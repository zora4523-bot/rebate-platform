import { integrationConfig } from '../vitest.shared.ts';

// Rule tests and acceptance tests that need PostgreSQL (ADR-0001 §4.2 #9; 规划/11 §4.1):
// TEST_PG_ADMIN_URL if set, otherwise Testcontainers. Run only by `test:int`, never in the
// Codex sandbox. The global setup is the source file of the test-database base in packages/db
// (Vitest resolves globalSetup without the `couli-src` condition, so the package specifier would
// load packages/db/dist, missing in a fresh checkout and stale after an edit of the source).
export default integrationConfig({
  include: ['spec/**/*.int.test.ts', 'acceptance/**/*.test.ts', 'smoke/**/*.int.test.ts'],
  globalSetup: ['../packages/db/src/testing/global-setup.ts'],
});
