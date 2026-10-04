// Rule tests for the retention of idempotency records against a real PostgreSQL (08 BR-ID-30 ⑤:
// idempotency_keys 30 天（按 expire_at）, POST /v1/withdrawals 与 PUT /v1/me/payout-account 的记录
// 不按 30 天清理; BR-WDR-07; BR-ID-10 细则「作废记录的保留期与该操作的幂等记录相同」; 规划/04 §3.2;
// contract section 7 of apps/api/src/modules/platform/idempotency/index.ts). Connected as
// couli_app. Top-level it() only (规划/11 §4.3).
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createIdempotency } from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import {
  ACTIONS,
  RETENTION_MS,
  SENSITIVE,
  TRACE,
  USER_A,
  freshKey,
  isoPlus,
  outcome,
  recordingLogger,
  request,
  result,
  rowsOf,
  sensitiveRequest,
} from './kit.ts';

const T0 = '2031-05-06T07:08:09.123Z';

let database: TestDatabase;
let db: Kysely<DB>;
let observer: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 6 });
  observer = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
});

afterAll(async () => {
  await destroyDb(db);
  await destroyDb(observer);
  await database.drop();
});

function setup(start: string = T0) {
  const clock = new FixedClock(start);
  const { logger } = recordingLogger();
  const idem = () => createIdempotency({ db, clock, logger });
  return { clock, idem };
}

async function insertRow(row: {
  appId?: string;
  key: string;
  status: 'processing' | 'completed' | 'abandoned';
  expire: string;
  path?: string;
}): Promise<void> {
  const abandoned = row.status === 'abandoned';
  await sql`
    INSERT INTO app.idempotency_keys
      (app_id, subject, user_id, method, path, key, request_hash, status, response, expire_at, created_at)
    VALUES (${row.appId ?? 'couli'}, ${`u:${USER_A}`}, ${USER_A}::uuid, 'POST',
      ${row.path ?? '/v1/links/x/open'}, ${row.key}, ${abandoned ? null : 'd'.repeat(64)}, ${row.status},
      ${row.status === 'completed' ? JSON.stringify({ status: 200, body: '{}' }) : null}::jsonb,
      ${row.expire}::timestamptz, ${T0}::timestamptz)
  `.execute(observer);
}

it('[BR-ID-30 ⑤; BR-WDR-07「保留期 ≥ 提现单保留期」（提现单保留期待定，待编排会话确认）] 到期时刻：普通操作与换手机号、注销为写入时刻 + 30 天；提现与收款账号变更（含作废记录）为 infinity', async () => {
  const start = '2030-12-31T23:59:59.999Z';
  const { idem } = setup(start);
  const standardKey = freshKey();
  await outcome(() =>
    idem().execute(request({ key: standardKey }), () => Promise.resolve(result(0, 200))),
  );
  expect((await rowsOf(observer, standardKey)).map((row) => [row.created, row.expire])).toEqual([
    [start, '2031-01-30T23:59:59.999Z'],
  ]);
  expect(isoPlus(start, RETENTION_MS)).toBe('2031-01-30T23:59:59.999Z');
  for (const action of ACTIONS) {
    const done = freshKey();
    await outcome(() =>
      idem().executeInTransaction(sensitiveRequest(action, { key: done }), () =>
        Promise.resolve(result(30001, 422)),
      ),
    );
    const dropped = freshKey();
    await outcome(() =>
      idem().abandon({ appId: 'couli', userId: USER_A, action, key: dropped, traceId: TRACE }),
    );
    const expected = SENSITIVE[action].unlimited ? 'infinity' : '2031-01-30T23:59:59.999Z';
    expect(
      (await rowsOf(observer, done)).map((row) => [row.status, row.created, row.expire]),
    ).toEqual([['completed', start, expected]]);
    expect(
      (await rowsOf(observer, dropped)).map((row) => [row.status, row.created, row.expire]),
    ).toEqual([['abandoned', start, expected]]);
  }
});

it('[BR-ID-30 ⑤「按 expire_at」] purgeExpired 删掉 expire_at 早于时钟当前时刻的行（任何状态、任何 app），恰好到期的与 infinity 的保留；返回删除行数；之后被删的键可以重新使用', async () => {
  const now = '2030-06-01T00:00:00.000Z';
  const { idem } = setup(now);
  const keys = {
    pastCompleted: freshKey(),
    pastProcessing: freshKey(),
    pastAbandoned: freshKey(),
    pastOtherApp: freshKey(),
    exactlyNow: freshKey(),
    future: freshKey(),
    forever: freshKey(),
  };
  await insertRow({ key: keys.pastCompleted, status: 'completed', expire: isoPlus(now, -1) });
  await insertRow({
    key: keys.pastProcessing,
    status: 'processing',
    expire: isoPlus(now, -86_400_000),
  });
  await insertRow({
    key: keys.pastAbandoned,
    status: 'abandoned',
    expire: isoPlus(now, -1),
    path: '/v1/me/deletion',
  });
  await insertRow({
    key: keys.pastOtherApp,
    status: 'completed',
    expire: isoPlus(now, -1),
    appId: 'couli2',
  });
  await insertRow({ key: keys.exactlyNow, status: 'completed', expire: now });
  await insertRow({ key: keys.future, status: 'completed', expire: isoPlus(now, 1) });
  await insertRow({
    key: keys.forever,
    status: 'abandoned',
    expire: 'infinity',
    path: '/v1/withdrawals',
  });
  expect(await outcome(() => idem().purgeExpired())).toBe(4);
  const left = await sql<{ key: string }>`
    SELECT key FROM app.idempotency_keys WHERE key = ANY(${Object.values(keys)}::text[]) ORDER BY id
  `.execute(observer);
  expect(left.rows.map((row) => row.key)).toEqual([keys.exactlyNow, keys.future, keys.forever]);
  expect(await outcome(() => idem().purgeExpired())).toBe(0);
  let handled = 0;
  expect(
    await outcome(() =>
      idem().execute(request({ key: keys.pastCompleted, path: '/v1/links/x/open' }), () => {
        handled += 1;
        return Promise.resolve(result(0, 200));
      }),
    ),
  ).toStrictEqual({
    status: 200,
    body: `{"code":0,"msg":"","trace_id":"${TRACE}"}`,
    source: 'handler',
  });
  expect(handled).toBe(1);
});
