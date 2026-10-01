import { integrationConfig } from '../../vitest.shared.ts';

// Needs PostgreSQL: TEST_PG_ADMIN_URL if set, otherwise Testcontainers (ADR-0001 §4.2 #9).
export default integrationConfig({ globalSetup: ['./src/testing/global-setup.ts'] });
