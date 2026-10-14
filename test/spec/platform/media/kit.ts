import { createHash } from 'node:crypto';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import type { AppEnv } from '../../../../apps/api/src/modules/platform/config/index.ts';

export const BASE_URL = 'https://cdn.example.invalid/media';
export const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><text>media-private-marker</text></svg>',
);
export const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  ),
);

export function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function configEnv(appEnv: AppEnv): Record<string, string> {
  // Configuration parsing only: these keyring paths are never opened.
  return appEnv === 'local' || appEnv === 'test'
    ? { APP_ENV: appEnv }
    : {
        APP_ENV: appEnv,
        FIELD_KEY_PROVIDER: 'kms',
        FIELD_KEYRING_FILE: '/not-opened/media-rule-keyring.json',
      };
}

export function memoryLogger(appEnv: AppEnv) {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'admin', appEnv },
    {
      write: (line: string) => {
        lines.push(line);
      },
    },
  );
  return { logger, lines };
}
