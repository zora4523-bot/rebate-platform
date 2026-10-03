import { integrationConfig } from '../vitest.shared.ts';

// Rule tests and acceptance tests that need PostgreSQL (ADR-0001 §4.2 #9; 规划/11 §4.1):
// TEST_PG_ADMIN_URL if set, otherwise Testcontainers. Run only by `test:int`, never in the
// Codex sandbox. The test-database base lives in packages/db (`@couli/db/testing`).
export default integrationConfig({
  include: ['spec/**/*.int.test.ts', 'acceptance/**/*.test.ts', 'smoke/**/*.int.test.ts'],
  globalSetup: ['@couli/db/testing/global-setup'],
});
