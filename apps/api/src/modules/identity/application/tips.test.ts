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
import { FixedClock } from '../../platform/index.ts';
import { createTipsService } from './tips.ts';

const NOW = '2031-05-06T07:08:09.123Z';
const SUBJECT = { app_id: 'couli', user_id: '019a0000-0000-7000-8000-000000000010' };

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

it('[AC-B1-02s] jump_tip inserts the platform at the Clock instant and keeps an existing row', async () => {
  const { db, queries } = recordingDb();
  const service = createTipsService({ db, clock: new FixedClock(NOW) });
  await expect(service.markRead(SUBJECT, 'jump_tip', { platform: 'taobao' })).resolves.toEqual({
    code: 0,
  });
  expect(queries).toHaveLength(1);
  expect(queries[0]!.sql).toBe(
    'insert into "app"."user_tip_reads" ("app_id", "user_id", "tip_key", "platform", "read_at", "created_at") values ($1, $2, $3, $4, $5, $6) on conflict ("app_id", "user_id", "tip_key", "platform") do nothing',
  );
  expect(queries[0]!.parameters).toEqual([
    SUBJECT.app_id,
    SUBJECT.user_id,
    'jump_tip',
    'taobao',
    new Date(NOW),
    new Date(NOW),
  ]);
});

it('[AC-B1-02s] inviter_before_buy ignores any body and stores the empty platform', async () => {
  for (const body of [undefined, { platform: 'jd' }, { platform: 'nope', extra: true }]) {
    const { db, queries } = recordingDb();
    const service = createTipsService({ db, clock: new FixedClock(NOW) });
    await expect(service.markRead(SUBJECT, 'inviter_before_buy', body)).resolves.toEqual({
      code: 0,
    });
    expect(queries[0]!.parameters.slice(2, 4)).toEqual(['inviter_before_buy', '']);
  }
});

it('[AC-B1-02s] a refused jump_tip body writes nothing', async () => {
  const { db, queries } = recordingDb();
  const service = createTipsService({ db, clock: new FixedClock(NOW) });
  await expect(service.markRead(SUBJECT, 'jump_tip', {})).resolves.toEqual({
    code: 20001,
    data: { fields: ['platform'] },
  });
  expect(queries).toEqual([]);
});

it('[AC-B1-02s] reading and resetting are scoped to the subject; reset only touches jump_tip', async () => {
  const { db, queries } = recordingDb();
  const service = createTipsService({ db, clock: new FixedClock(NOW) });
  await expect(service.read(SUBJECT)).resolves.toEqual({ jump_tip: {}, inviter_before_buy: null });
  await service.resetJumpTip(SUBJECT);
  expect(queries.map(({ sql, parameters }) => ({ sql, parameters }))).toEqual([
    {
      sql: 'select "tip_key", "platform", "read_at" from "app"."user_tip_reads" where "app_id" = $1 and "user_id" = $2',
      parameters: [SUBJECT.app_id, SUBJECT.user_id],
    },
    {
      sql: 'delete from "app"."user_tip_reads" where "app_id" = $1 and "user_id" = $2 and "tip_key" = $3',
      parameters: [SUBJECT.app_id, SUBJECT.user_id, 'jump_tip'],
    },
  ]);
});
