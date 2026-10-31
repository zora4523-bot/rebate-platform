// B1-15i on the scheduled expiry (the worker's IdentityDeletionExpiryModule as app.module assembles
// it, over real ledger rows): cooling ends with available_fen < 0 → the system cancels the request
// and, in that same transaction, writes one DELETION_PROGRESS cancelled_negative inbox message with
// {amount} = formatYuan(−available_fen) as read in that transaction (08 BR-TEXT-23 细则模板表,
// BR-ID-27, BR-TEXT-10; brief §9.2 #3, #4, §9.3). A request that goes on to processing writes no
// DELETION_PROGRESS (BR-TEXT-23 细则: none after processing). Inbox only; deduplicated by request +
// variant; rolled back with the cancellation.
import { createDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  NOW,
  owner,
  request,
  seedLedgerBalance,
  seedRequest,
  type Owner,
} from '../deletion-expiry/kit.ts';
import {
  AMOUNTS,
  TITLE,
  armableFailure,
  assembledExpiry,
  expectInboxOnly,
  expectedLog,
  expectedMessage,
  inbox,
  logs,
  negativeBody,
  seedLog,
  template,
  type FailTable,
} from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
const failure = armableFailure();
let expiry: Awaited<ReturnType<typeof assembledExpiry>>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  expiry = await assembledExpiry(db.withPlugin(failure.plugin));
}, 180_000);
afterAll(async () => {
  try {
    await expiry?.close();
  } finally {
    try {
      await db?.destroy();
    } finally {
      await database?.drop();
    }
  }
});
beforeEach(() => {
  failure.disarm();
  expiry.p.clock.set(NOW);
});

/** A due cooling request of a fresh user (of `appId` when given) with this ledger balance. */
async function due(availableFen: bigint | null, appId?: string) {
  const o: Owner = await owner(db, appId === undefined ? {} : { appId });
  if (availableFen !== null) await seedLedgerBalance(db, o, availableFen);
  const row = await seedRequest(db, o);
  return { o, row };
}

it('[AC-B1-15i#30] 冷静期满余额 −1234 分 → 系统撤销并写一条 cancelled_negative（待扣回 ¥12.34），一条 inbox 日志；0、正数、无账户 → processing，不写 DELETION_PROGRESS', async () => {
  const negative = await due(-1234n);
  const app = negative.o.appId;
  const zero = await due(0n, app);
  const positive = await due(5_000n, app);
  const none = await due(null, app);
  await expiry.runner.runOnce();
  const at = expiry.p.clock.now();
  expect(await request(db, negative.row.id)).toMatchObject({
    status: 'cancelled',
    cancel_reason: 'negative_balance',
  });
  for (const other of [zero, positive, none]) {
    expect((await request(db, other.row.id)).status).toBe('processing');
  }
  expect(await inbox(db, app)).toEqual([
    expect.objectContaining(
      expectedMessage({ appId: app, userId: negative.o.uid, body: negativeBody('¥12.34'), at }),
    ),
  ]);
  expect(await logs(db, app)).toEqual([
    expect.objectContaining(
      expectedLog({
        appId: app,
        userId: negative.o.uid,
        requestId: negative.row.id,
        variant: 'cancelled_negative',
        at,
      }),
    ),
  ]);
  await expectInboxOnly(db, app);
});

it('[AC-B1-15i#31] {amount} = 当时 −available_fen 的 formatYuan（BR-TEXT-10），每人各一条', async () => {
  const app = (await owner(db)).appId;
  const cases: (Awaited<ReturnType<typeof due>> & { readonly text: string })[] = [];
  for (const [fen, text] of AMOUNTS) cases.push({ ...(await due(-fen, app)), text });
  await expiry.runner.runOnce();
  for (const c of cases) {
    expect((await inbox(db, app, c.o.uid)).map((row) => row.body)).toEqual([negativeBody(c.text)]);
    expect((await logs(db, app, c.o.uid)).map((row) => row.dedupe_key)).toEqual([
      `${c.row.id}:DELETION_PROGRESS:cancelled_negative`,
    ]);
  }
});

it('[AC-B1-15i#32] 金额只取撤销那一刻本事务读到的余额：之后余额再变，信里的金额不变、不补写', async () => {
  const d = await due(-300n);
  await expiry.runner.runOnce();
  await db
    .withSchema('app')
    .updateTable('account_balances')
    .set({ available_fen: -900n })
    .where('app_id', '=', d.o.appId)
    .execute();
  expiry.p.clock.set(new Date(Date.parse(NOW) + 60_000));
  await expiry.runner.runOnce();
  expect((await inbox(db, d.o.appId)).map((row) => row.body)).toEqual([negativeBody('¥3')]);
  expect(await logs(db, d.o.appId)).toHaveLength(1);
});

it.each(['inbox_messages', 'notify_logs'] as const)(
  '[AC-B1-15i#33] 写 %s 失败 → 撤销回滚：单仍是 cooling、无站内信无日志；下一轮撤销成功只一条',
  async (table: FailTable) => {
    const d = await due(-1234n);
    const before = failure.fired();
    failure.arm(table);
    try {
      await expiry.runner.runOnce();
    } finally {
      failure.disarm();
    }
    // The injected failure fired inside the cancellation's transaction.
    expect(failure.fired()).toBeGreaterThan(before);
    expect(await request(db, d.row.id)).toEqual(d.row);
    expect(await inbox(db, d.o.appId)).toEqual([]);
    expect(await logs(db, d.o.appId)).toEqual([]);
    expiry.p.clock.set(new Date(Date.parse(NOW) + 60_000));
    const at = expiry.p.clock.now();
    await expiry.runner.runOnce();
    expect(await request(db, d.row.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'negative_balance',
      cancelled_at: at,
    });
    expect(await inbox(db, d.o.appId)).toEqual([
      expect.objectContaining(
        expectedMessage({ appId: d.o.appId, userId: d.o.uid, body: negativeBody('¥12.34'), at }),
      ),
    ]);
    expect(await logs(db, d.o.appId)).toEqual([
      expect.objectContaining(
        expectedLog({
          appId: d.o.appId,
          userId: d.o.uid,
          requestId: d.row.id,
          variant: 'cancelled_negative',
          at,
        }),
      ),
    ]);
  },
);

it('[AC-B1-15i#34] 重复执行只一条；去重键 {申请编号}:DELETION_PROGRESS:cancelled_negative 已在日志里 → 照样撤销但不再写信', async () => {
  const repeated = await due(-50n);
  const app = repeated.o.appId;
  const logged = await due(-70n, app);
  const earlier = new Date(Date.parse(NOW) - 3_600_000);
  await seedLog(db, {
    appId: app,
    userId: logged.o.uid,
    requestId: logged.row.id,
    variant: 'cancelled_negative',
    at: earlier,
  });
  await expiry.runner.runOnce();
  expiry.p.clock.set(new Date(Date.parse(NOW) + 60_000));
  await expiry.runner.runOnce();
  expect((await request(db, repeated.row.id)).status).toBe('cancelled');
  expect((await request(db, logged.row.id)).status).toBe('cancelled');
  expect((await inbox(db, app, repeated.o.uid)).map((row) => row.body)).toEqual([
    negativeBody('¥0.5'),
  ]);
  expect(await logs(db, app, repeated.o.uid)).toHaveLength(1);
  expect(await inbox(db, app, logged.o.uid)).toEqual([]);
  expect(await logs(db, app, logged.o.uid)).toEqual([
    expect.objectContaining({
      dedupe_key: `${logged.row.id}:DELETION_PROGRESS:cancelled_negative`,
      created_at: earlier,
    }),
  ]);
});

it('[AC-B1-15i#35] notify_templates 覆盖 cancelled_negative 生效（{amount} 照填）；别的 app、只覆盖别的变体照默认', async () => {
  const a = await due(-1234n);
  const b = await due(-1234n);
  await template(db, a.o.appId, 'cancelled_negative', {
    title_override: '注销已撤销',
    body_override: '还有 {amount} 待扣回，注销申请已撤销。',
  });
  await template(db, b.o.appId, 'requested', { title_override: '注销提醒', body_override: null });
  await expiry.runner.runOnce();
  expect(await inbox(db, a.o.appId)).toEqual([
    expect.objectContaining({
      user_id: a.o.uid,
      title: '注销已撤销',
      body: '还有 ¥12.34 待扣回，注销申请已撤销。',
    }),
  ]);
  expect(await inbox(db, b.o.appId)).toEqual([
    expect.objectContaining({ user_id: b.o.uid, title: TITLE, body: negativeBody('¥12.34') }),
  ]);
});
