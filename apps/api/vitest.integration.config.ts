import { integrationConfig } from '../../vitest.shared.ts';

// Needs PostgreSQL: TEST_PG_ADMIN_URL if set, otherwise Testcontainers (ADR-0001 §4.2 #9).
// The test-database base lives in packages/db (`@couli/db/testing`).
export default integrationConfig({ globalSetup: ['@couli/db/testing/global-setup'] });
