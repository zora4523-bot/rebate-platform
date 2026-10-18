import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { expect, it } from 'vitest';
import { createInviteBackfillActivityReader } from './me-reads.ts';

const SUBJECT = { appId: 'couli', userId: '019a0000-0000-7000-8000-000000000010' };

/** A Kysely whose driver records each compiled statement and answers no rows. */
function recordingDb(): { db: Kysely<DB>; queries: CompiledQuery[] } {
  const queries: CompiledQuery[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') queries.push(event.query);
    },
  });
  return { db, queries };
}

it('[AC-B1-11p] hasClaims reads app.claims of any status, scoped by app and user, on the given handle', async () => {
  const { db, queries } = recordingDb();
  await expect(createInviteBackfillActivityReader(db).hasClaims(SUBJECT)).resolves.toBe(false);
  expect(queries).toHaveLength(1);
  expect(queries[0]!.sql).toBe(
    'select "id" from "app"."claims" where "app_id" = $1 and "user_id" = $2 limit $3',
  );
  expect(queries[0]!.parameters).toEqual([SUBJECT.appId, SUBJECT.userId, 1]);
});
