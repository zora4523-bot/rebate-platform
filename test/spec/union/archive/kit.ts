// B1-04p D10 task-local AC labels; synthetic data only, no private recordings.
// DB provisioning stays in *.int.test.ts (TEST_PG_ADMIN_URL via the shared global setup).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';
import type { ArchiveContext } from '../../../../apps/api/src/modules/union/infra/archive.ts';
import type {
  UnionTransportRequest,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';

export const START = '2026-10-15T00:00:00.000Z';

export function harness(db: Kysely<DB>) {
  const clock = new FixedClock(START);
  const logger = { warn: vi.fn(), error: vi.fn() };
  const appId = `archive-${randomUUID()}`;
  return { db, clock, logger, appId };
}

// Structural extension keeps the test phase from modifying the existing replay.ts interface.
export function request(
  appId: string,
  overrides: Partial<UnionTransportRequest & { archive: ArchiveContext }> = {},
): UnionTransportRequest & { archive: ArchiveContext } {
  return {
    platform: 'pdd',
    method: 'POST',
    url: 'https://synthetic.invalid/router',
    headers: { 'content-type': 'application/json' },
    body: '{"type":"synthetic.query"}',
    archive: { appId, kind: 'query' },
    ...overrides,
  };
}

export function response(body = '原始响应\n { "session": "fake-value" }'): UnionTransportResponse {
  return { status: 200, headers: { 'x-synthetic': 'reply' }, body };
}

export function rows(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('union_raw_payloads')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}

/** Business failures become values; programming/import/assertion failures remain invalid red. */
export async function outcome(run: () => unknown): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof Error &&
      (['TypeError', 'SyntaxError', 'ReferenceError', 'RangeError', 'AssertionError'].includes(
        error.name,
      ) ||
        ('code' in error && error.code === 'ERR_MODULE_NOT_FOUND'))
    )
      throw error;
    return error;
  }
}
