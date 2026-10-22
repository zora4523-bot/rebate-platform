import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createClaimEntryReader } from '../../../../apps/api/src/modules/linking/index.ts';
import { fixture } from './db-kit.ts';
import { ago, HOUR, value } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-B1-10h#70] AC-S1-25② linking读口按App/COALESCE发起人/闭区间隔离，跨平台保留业务原始值', async () => {
  const f = await fixture(db);
  const other = await f.user();
  const foreign = await fixture(db);
  const scope = { ...f.subject, from: ago(72 * HOUR), to: ago(0) };
  const low = await f.log({ created_at: scope.from, event: 'convert', opener_user_id: null });
  const high = await f.log({ created_at: scope.to, platform: 'pdd' });
  const opened = await f.log({ user_id: other, platform: 'jd' });
  const anonymousLink = await f.log({ user_id: null });
  const raw = await f.log({
    pid_scene: 'share',
    no_rebate: true,
    no_rebate_reason: 'binding_blocked',
  });
  const absent = [
    await f.log({ opener_user_id: other }),
    await f.log({ user_id: other, opener_user_id: null }),
    await foreign.log(),
    await f.log({ created_at: ago(72 * HOUR + 1) }),
    await f.log({ created_at: ago(-1) }),
  ];
  const reader = await value(() => createClaimEntryReader(db));
  const first = await value(() => reader.read(scope));
  expect(first.logs.map((r) => String(r.id)).sort()).toEqual(
    [low, high, opened, anonymousLink, raw].map((r) => String(r.id)).sort(),
  );
  for (const row of absent)
    expect(first.logs.map((r) => String(r.id))).not.toContain(String(row.id));
  expect(first.logs.find((r) => String(r.id) === String(raw.id))).toMatchObject({
    platform: 'taobao',
    event: 'open',
    result_code: 0,
    pid_scene: 'share',
    no_rebate: true,
    no_rebate_reason: 'binding_blocked',
    created_at: raw.created_at,
  });
  const appended = await f.log({ pid_scene: null });
  const next = await value(() => reader.read(scope));
  expect(next.logs.map((r) => String(r.id))).toContain(String(appended.id));
});

it('[AC-B1-10h#71] AC-S1-25② 绑定读口保留状态和时刻，跨平台且隔离App/本人', async () => {
  const f = await fixture(db);
  const foreign = await fixture(db);
  const other = await f.user();
  const a = await f.binding({ bound_at: ago(HOUR + 1), relation_id: '' });
  const b = await f.binding({
    platform: 'pdd',
    status: 'invalid',
    bound_at: null,
    relation_id: null,
  });
  await f.binding({ user_id: other, status: 'active' });
  await foreign.binding();
  const reader = await value(() => createClaimEntryReader(db));
  const facts = await value(() => reader.read({ ...f.subject, from: ago(72 * HOUR), to: ago(0) }));
  expect(facts.bindings).toHaveLength(2);
  for (const row of [a, b])
    expect(facts.bindings).toContainEqual(
      expect.objectContaining({
        ...f.subject,
        platform: row.platform,
        status: row.status,
        bound_at: row.bound_at,
        relation_id: row.relation_id,
      }),
    );
});
