import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture, expected, store } from './db-kit.ts';
import { at } from './kit.ts';
import { randomUUID } from 'node:crypto';

// Global setup injects the template factory connection; each file clones it.
// All fixture writes and application queries use the ordinary application role.
let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-B1-08m#26] 同一次成功 open 日志决定 no_rebate 与 pid_scene，不能用 link 最新日志', async () => {
  const f = await fixture(db);
  const link = await f.link({ pid_scene: 'share' });
  const a1 = await f.open(
    0,
    { link_id: link },
    { no_rebate: true, no_rebate_reason: 'auth_failed' },
  );
  const a2 = await f.open(10, { link_id: link }, { event: 'convert', no_rebate: false });
  const otherUser = await f.user();
  const foreign = await fixture(db);
  const raw = {
    app_id: f.subject.app_id,
    user_id: f.subject.user_id,
    link_id: link,
    created_at: at(10),
    event: 'open',
    result_code: 0,
    no_rebate: true,
    no_rebate_reason: 'auth_declined',
    pid_scene: 'share',
  };
  for (const patch of [
    { event: 'precompute' },
    { event: 'register' },
    { result_code: 30101 },
    { user_id: otherUser },
    { app_id: foreign.subject.app_id, user_id: foreign.subject.user_id },
    { created_at: at(11) },
  ])
    await db
      .insertInto('link_logs')
      .values({ ...raw, ...patch })
      .execute();
  const port = await store(db);
  const rows = await port.listForUser({ ...f.subject, since: at(-72 * 60) });
  expect(rows).toHaveLength(2);
  expect(rows.find((r) => r.attempt_id === a1.attempt_id)).toMatchObject({
    no_rebate: true,
    no_rebate_reason: 'auth_failed',
    pid_scene: 'self_buy',
    opened_at: at(0),
  });
  expect(rows.find((r) => r.attempt_id === a2.attempt_id)).toMatchObject({
    no_rebate: false,
    no_rebate_reason: null,
    pid_scene: 'self_buy',
    opened_at: at(10),
  });
  f.clock.set(at(40));
  const { q } = await f.service();
  expect(await q.list(f.subject)).toEqual({ items: [expected(a2, 'jd', true)] });
});

it('[AC-B1-08m#27] 缺对应日志按无 no_rebate 处理，pid_scene 回退 links；日志 share 优先排除', async () => {
  const f = await fixture(db);
  const self = await f.link();
  const share = await f.link({ platform: 'taobao', pid_scene: 'share' });
  const a = await f.open(1, { link_id: self }, false);
  await f.open(2, { link_id: share }, false);
  const logShare = await f.link({ platform: 'pdd' });
  await f.open(3, { link_id: logShare }, { pid_scene: 'share' });
  f.clock.set(at(40));
  const { q, attempts } = await f.service();
  const rows = await attempts.listForUser({ ...f.subject, since: at(-72 * 60) });
  expect(rows.find((r) => r.attempt_id === a.attempt_id)).toMatchObject({
    no_rebate: false,
    pid_scene: 'self_buy',
    authorized_after: false,
  });
  expect(await q.list(f.subject)).toEqual({ items: [expected(a, 'jd', true)] });
});

it('[AC-B1-08m#28] listForUser 依据 opened_at 包含 since 等号，不按补报时间延长寿命', async () => {
  const f = await fixture(db);
  const old = await f.open(0);
  await f.report(old.attempt_id, 20);
  const edge = await f.open(1);
  await f.open(2, {}, { pid_scene: 'self_buy' });
  const port = await store(db);
  const rows = await port.listForUser({ ...f.subject, since: at(1) });
  expect(rows.map((r) => r.attempt_id)).toContain(edge.attempt_id);
  expect(rows.map((r) => r.attempt_id)).not.toContain(old.attempt_id);
  expect(rows).toHaveLength(2);
});

it.each([
  { platform: 'taobao', status: 'active', bound: 10, material: true, expected: true },
  { platform: 'taobao', status: 'active', bound: 15, material: true, expected: true },
  { platform: 'taobao', status: 'active', bound: 9, material: true, expected: false },
  { platform: 'taobao', status: 'invalid', bound: 15, material: true, expected: false },
  { platform: 'taobao', status: 'active', bound: 15, material: false, expected: false },
  { platform: 'pdd', status: 'active', bound: 15, material: true, expected: true },
  { platform: 'pdd', status: 'pending_auth', bound: 15, material: true, expected: false },
])(
  '[AC-B1-08m#29] $platform 授权 status=$status bound=$bound material=$material → $expected',
  async (scenario) => {
    const f = await fixture(db);
    const link = await f.link({ platform: scenario.platform });
    const a = await f.open(
      10,
      { link_id: link },
      { no_rebate: true, no_rebate_reason: 'auth_declined' },
    );
    const account = randomUUID();
    await db
      .insertInto('union_accounts')
      .values({
        id: account,
        app_id: f.subject.app_id,
        platform: scenario.platform,
        account_name: 'synthetic pending authorization',
        status: 'active',
        auth_status: 'active',
      })
      .execute();
    await db
      .insertInto('union_bindings')
      .values({
        id: randomUUID(),
        ...f.subject,
        platform: scenario.platform,
        union_account_id: account,
        status: scenario.status,
        bound_at: at(scenario.bound),
        relation_id:
          scenario.platform === 'taobao' && scenario.material ? 'synthetic-relation' : null,
        pdd_custom:
          scenario.platform === 'pdd' ? '{"app":"n","uid":"synthetic","sc":"self_buy"}' : null,
      })
      .execute();
    f.clock.set(at(40));
    const { q, attempts } = await f.service();
    const rows = await attempts.listForUser({ ...f.subject, since: at(-72 * 60) });
    expect(rows.find((r) => r.attempt_id === a.attempt_id)?.authorized_after).toBe(
      scenario.expected,
    );
    expect(await q.list(f.subject)).toEqual({
      items: [expected(a, scenario.platform, scenario.expected)],
    });
  },
);

it('[AC-B1-08m#30] 他人或别平台的后续授权不解锁本人的无返利卡', async () => {
  const f = await fixture(db);
  const otherUser = await f.user();
  const link = await f.link({ platform: 'taobao' });
  const a = await f.open(
    10,
    { link_id: link },
    { no_rebate: true, no_rebate_reason: 'auth_failed' },
  );
  for (const [platform, userId] of [
    ['taobao', otherUser],
    ['pdd', f.subject.user_id],
  ]) {
    const account = randomUUID();
    await db
      .insertInto('union_accounts')
      .values({
        id: account,
        app_id: f.subject.app_id,
        platform: platform!,
        account_name: 'synthetic decoy authorization',
        status: 'active',
        auth_status: 'active',
      })
      .execute();
    await db
      .insertInto('union_bindings')
      .values({
        id: randomUUID(),
        app_id: f.subject.app_id,
        user_id: userId!,
        platform: platform!,
        union_account_id: account,
        status: 'active',
        bound_at: at(15),
        relation_id: platform === 'taobao' ? 'synthetic-other-relation' : null,
        pdd_custom: platform === 'pdd' ? '{"app":"n","uid":"synthetic","sc":"self_buy"}' : null,
      })
      .execute();
  }
  f.clock.set(at(40));
  const { q } = await f.service();
  expect(await q.list(f.subject)).toEqual({ items: [expected(a, 'taobao')] });
});
