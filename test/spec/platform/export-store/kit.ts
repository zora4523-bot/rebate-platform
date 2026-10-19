import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { AppEnv } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import { MemoryExportStore } from '../../../../apps/api/src/modules/platform/export-store/index.ts';

export const BASE_URL = 'https://exports.example.invalid/private';
export const SIGNING_KEY = 'export-store-fixture-only-key-0123456789';
export const KEY = 'brand_a/0199f000-1234-7000-8000-000000000001.csv';
export const OTHER_KEY = 'brand_b/0199f000-1234-7000-8000-000000000001.csv';
export const NOW = '2031-10-19T00:00:00.123Z';
export const EXPIRES = '2031-10-19T00:05:00.123Z';
export const CSV = new TextEncoder().encode('name,value\nprivate-export-marker,123\n');

export function configEnv(appEnv: AppEnv): Record<string, string> {
  return appEnv === 'local' || appEnv === 'test'
    ? { APP_ENV: appEnv }
    : {
        APP_ENV: appEnv,
        FIELD_KEY_PROVIDER: 'kms',
        FIELD_KEYRING_FILE: '/not-opened/export-store-fixture.json',
      };
}

export function fixture(appEnv: AppEnv = 'test') {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'admin', appEnv },
    {
      write: (line: string) => {
        lines.push(line);
      },
    },
  );
  const clock = new FixedClock(NOW);
  return { lines, logger, clock, appEnv, baseUrl: BASE_URL, signingKey: SIGNING_KEY };
}

export function memory() {
  const options = fixture();
  return { ...options, store: new MemoryExportStore(options) };
}
