import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { createUpdateNicknameService, type UpdateNicknameOptions } from './update-nickname.ts';

it('[AC-B1-20d#15] constructing the service does not require a database with withSchema', () => {
  // HTTP unit tests assemble identity with a database stub that has no Kysely methods.
  const db = {} as UpdateNicknameOptions['db'];
  expect(() =>
    createUpdateNicknameService({
      db,
      clock: new FixedClock('2026-10-17T00:00:00.000Z'),
      logger: { info: vi.fn(), warn: vi.fn() },
      review: { review: vi.fn(async () => 'pass' as const) },
    }),
  ).not.toThrow();
});
