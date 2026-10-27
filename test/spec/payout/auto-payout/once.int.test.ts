// BR-WDR-30 判定时点与并发: each withdrawal is judged once (review_mode already set → nothing),
// at-least-once delivery deduplicated by processed_events in the same transaction as the effects,
// a human W2 / W3 first makes the CAS (status = PENDING_REVIEW) match nothing and only
// auto_decision is written, and ⑦ / ⑨ are read under one serialising lock (two members at once
// cannot both pass a limit that only one fits).
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  CONSUMER,
  TIMEOUT,
  close,
  decision,
  executions,
  expectOneExecute,
  fenced,
  key,
  open,
  setup,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

/** The row without the columns a consumer that only writes auto_decision may touch. */
function rest(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).filter(([column]) => column !== 'auto_decision' && column !== 'updated_at'),
  );
}

it('[AC-B2-11c#50] W1 时总开关关、建单即 review_mode=manual 的单：之后开关打开，消费者也直接结束，不判定、不写任何字段', async () => {
  const f = await setup(h);
  await f.set(key('enabled'), false);
  const id = await f.start(100n);
  const before = await f.row(id);
  expect(before).toMatchObject({ review_mode: 'manual', auto_decision: null });
  await f.set(key('enabled'), true);
  const events = await f.events();
  await f.consumer().consume(await f.event(id));
  expect(await f.row(id)).toEqual(before);
  expect(await f.events()).toEqual(events);
  expect(f.execute).not.toHaveBeenCalled();
});

it('[AC-B2-11c#51] 已判定 auto 的单再收到另一条 withdrawal.created（新 event_id）：review_mode 已非空，直接结束，不再 W2、不再执行', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  const consumer = f.consumer();
  await consumer.consume(await f.event(id));
  const once = await f.row(id);
  expect(once.review_mode).toBe('auto');
  await consumer.consume(await f.event(id, randomUUID()));
  expect(await f.row(id)).toEqual(once);
  expectOneExecute(f, id);
  expect(await f.approvals(id)).toHaveLength(1);
});

it('[AC-B2-11c#52] 同一 event_id 并发两次与再次投递：processed_events 一条，系统 W2 与 executeBatch 各一次', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  const event = await f.event(id);
  await Promise.all([f.consumer().consume(event), f.consumer().consume(event)]);
  const once = await f.row(id);
  await f.consumer().consume({ ...event, attempt: 2 });
  expect(await f.row(id)).toEqual(once);
  expect(once).toMatchObject({ status: 'APPROVED', review_mode: 'auto' });
  expect(await f.claims(event.eventId)).toHaveLength(1);
  expect(executions(f, id)).toHaveLength(1);
  expect(await f.approvals(id)).toHaveLength(1);
});

it('[AC-B2-11c#53] 认领与效果同一事务：executeBatch 抛错时整笔回滚（无认领、未 W2、未写判定），重投可完成且只 W2 一次', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  const before = await f.row(id);
  const event = await f.event(id);
  const failure = new Error('synthetic execute failure');
  const broken = f.consumer({
    execute: {
      executeBatch: async () => {
        throw failure;
      },
    },
  });
  await expect(broken.consume(event)).rejects.toBe(failure);
  expect(await f.row(id)).toEqual(before);
  expect(await f.claims(event.eventId)).toHaveLength(0);
  expect(await f.approvals(id)).toEqual([]);
  await f.consumer().consume({ ...event, attempt: 2 });
  expect(await f.row(id)).toMatchObject({ status: 'APPROVED', review_mode: 'auto' });
  expect(await f.approvals(id)).toHaveLength(1);
  expect(await f.claims(event.eventId)).toHaveLength(1);
});

it('[AC-B2-11c#54] 人工先 W2：消费者的 CAS(status=PENDING_REVIEW) 影响 0 行即结束，只写 auto_decision，状态与审核人不变、不执行', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  const reviewerId = randomUUID();
  await h.db.transaction().execute((trx) =>
    f.commands().approve(trx, {
      appId: f.appId,
      withdrawalId: id,
      expectedStatus: 'PENDING_REVIEW',
      expectedRowVersion: 0,
      reviewerId,
    }),
  );
  const before = await f.row(id);
  expect(before).toMatchObject({ status: 'APPROVED', reviewer_id: reviewerId });
  await f.consumer().consume(await f.event(id));
  const after = await f.row(id);
  expect(rest(after)).toEqual(rest(before));
  expect(after.auto_decision).toEqual(decision('auto', []));
  expect(f.execute).not.toHaveBeenCalled();
  expect(await f.approvals(id)).toHaveLength(1);
});

it('[AC-B2-11c#55] 人工先 W3：单据保持 REJECTED，消费者只写 auto_decision，不 W2、不执行、不动余额', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  await h.db.transaction().execute((trx) =>
    f.commands().reject(trx, {
      appId: f.appId,
      withdrawalId: id,
      expectedStatus: 'PENDING_REVIEW',
      expectedRowVersion: 0,
      reviewerId: randomUUID(),
      reasonCode: 'OTHER',
      note: null,
    }),
  );
  const before = await f.row(id);
  const balances = await f.ledger.getBalances(h.db, {
    appId: f.appId,
    userIds: [f.actor.userId],
  });
  await f.consumer().consume(await f.event(id));
  const after = await f.row(id);
  expect(after.status).toBe('REJECTED');
  expect(rest(after)).toEqual(rest(before));
  expect(after.auto_decision).toEqual(decision('auto', []));
  expect(f.execute).not.toHaveBeenCalled();
  expect(await f.approvals(id)).toEqual([]);
  expect(await f.ledger.getBalances(h.db, { appId: f.appId, userIds: [f.actor.userId] })).toEqual(
    balances,
  );
});

it('[AC-B2-11c#56] 人工 W2 持有 users 行锁时消费者到达：消费者在 users 行锁上等待，人工提交后 CAS 落空，只写 auto_decision', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  const event = await f.event(id);
  const reviewerId = randomUUID();
  const consumer = f.consumer();
  const outcome = await fenced(
    h,
    (trx) =>
      f.commands().approve(trx, {
        appId: f.appId,
        withdrawalId: id,
        expectedStatus: 'PENDING_REVIEW',
        expectedRowVersion: 0,
        reviewerId,
      }),
    () => consumer.consume(event),
  );
  expect(outcome.first).toEqual({ kind: 'changed', status: 'APPROVED' });
  expect(outcome.waited).toBe(true);
  expect(await f.row(id)).toMatchObject({
    status: 'APPROVED',
    reviewer_id: reviewerId,
    review_mode: null,
    auto_decision: decision('auto', []),
  });
  expect(f.execute).not.toHaveBeenCalled();
  expect(await f.approvals(id)).toHaveLength(1);
  expect(await f.claims(event.eventId)).toHaveLength(1);
});

it('[AC-B2-11c#57] ⑨ 在串行锁内计算：两个会员同时到达、上限只容一笔（150 分，各 100 分）→ 恰一笔 auto、另一笔 platform_daily_max', async () => {
  const f = await setup(h);
  await f.set(key('platform_daily_max_fen'), 150);
  const other = await f.member();
  const a = await f.start(100n);
  const b = await f.start(100n, other);
  const events = [await f.event(a), await f.event(b)];
  await Promise.all(events.map((event) => f.consumer().consume(event)));
  const decisions = [(await f.row(a)).auto_decision, (await f.row(b)).auto_decision];
  expect(decisions).toEqual(
    expect.arrayContaining([decision('auto', []), decision('manual', ['platform_daily_max'])]),
  );
  expect([(await f.row(a)).status, (await f.row(b)).status].sort()).toEqual([
    'APPROVED',
    'PENDING_REVIEW',
  ]);
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it('[AC-B2-11c#58] ⑦ 收款账号次数在串行锁内计算：两个会员同一收款账号同时到达（当日上限 1）→ 恰一笔 auto、另一笔 payee_daily_count', async () => {
  const f = await setup(h);
  const other = await f.member();
  const a = await f.start(100n);
  // Seed only: the second member's W1 snapshot carries the same payee HMAC (W1's payee rules are
  // B2-05c's). couli_app may not update withdrawals.payee_hmac and payout_accounts' account columns
  // change only when anonymizing, so the first member's account is retired after its W1 and the
  // second member's current account is retired and re-inserted with that HMAC before its W1.
  await sql`UPDATE app.payout_accounts SET is_current = false
    WHERE app_id = ${f.actor.appId} AND user_id = ${f.actor.userId} AND is_current`.execute(h.db);
  await h.db.transaction().execute(async (trx) => {
    const current = await sql<{ id: string }>`UPDATE app.payout_accounts SET is_current = false
      WHERE app_id = ${other.actor.appId} AND user_id = ${other.actor.userId} AND is_current
      RETURNING id`.execute(trx);
    const id = current.rows[0]?.id;
    if (id === undefined) throw new Error('seed: the second member has no current payout account');
    await sql`INSERT INTO app.payout_accounts
      (id, app_id, user_id, payout_method, payee_name, is_current, alipay_hmac, alipay_logon_id_cipher,
       bank_card_hmac, bank_card_no_cipher, bank_name, card_bin)
      SELECT ${randomUUID()}, app_id, user_id, payout_method, payee_name, true, ${f.hmac},
        alipay_logon_id_cipher, bank_card_hmac, bank_card_no_cipher, bank_name, card_bin
      FROM app.payout_accounts WHERE id = ${id}`.execute(trx);
  });
  const b = await f.start(100n, other);
  const events = [await f.event(a), await f.event(b)];
  await Promise.all(events.map((event) => f.consumer().consume(event)));
  const decisions = [(await f.row(a)).auto_decision, (await f.row(b)).auto_decision];
  expect(decisions).toEqual(
    expect.arrayContaining([decision('auto', []), decision('manual', ['payee_daily_count'])]),
  );
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(
    await h.db
      .withSchema('app')
      .selectFrom('processed_events')
      .select('event_id')
      .where('consumer', '=', CONSUMER)
      .where(
        'event_id',
        'in',
        events.map((event) => event.eventId),
      )
      .execute(),
  ).toHaveLength(2);
});
