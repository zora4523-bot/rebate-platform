// B2-05n: the review overdue judgement on a real PostgreSQL (规划/08 BR-WDR-26 超时判定: 判定时状态仍
// ∈ {PENDING_REVIEW, APPROVED} 即为审核超时，每单只判定一次; BR-WDR-24 审核超时告警; 02 §11
// withdrawal.review_overdue; D10-475 ②(a)(b)(c)): the candidates are every app's withdrawals with
// review_deadline <= now, review_overdue_at IS NULL and status ∈ {PENDING_REVIEW, APPROVED}; each is
// judged on its own transaction under identity's users lock (review_overdue_at = now, updated_at =
// now, the event with its four fields on that transaction) and logged by one warn line after the
// commit — never for a rolled-back judgement. A failure of one withdrawal does not stop the others.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { createReviewOverdueCheck } from '../../../../apps/api/src/modules/payout/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  CREATED_AT,
  DEADLINE,
  FAILED_WARN,
  HOUR,
  MINUTE,
  NOW,
  SyntheticCommitFault,
  TIMEOUT,
  appId,
  buildCheck,
  eventBus,
  eventsOf,
  expectNoPersonalData,
  expectedEvent,
  expectedWarn,
  faultyCommits,
  member,
  memoryLogger,
  overdueEvents,
  overdueWarns,
  recordingLock,
  rejection,
  seed,
  seedWithdrawal,
  stored,
  withHarness,
  type Harness,
  type Seeded,
  type Status,
} from './kit.ts';

const at = (ms: number): Date => new Date(ms);

/** Status, judgement instant and updated_at of a withdrawal. */
async function judgement(h: Harness, w: Seeded) {
  const row = await stored(h.observer, w);
  return { status: row.status, overdueAt: row.reviewOverdueAt, updatedAt: row.updatedAt };
}

it(
  '[BR-WDR-26 超时判定] deadline 已到（含恰好等于 now）且仍为 PENDING_REVIEW / APPROVED：review_overdue_at = now、updated_at = now、状态不变；每单一条 withdrawal.review_overdue（载荷只含 withdrawal_id、user_id、review_deadline、overdue_at，app_id 在信封）；提交后每单一条 warn withdrawal_review_overdue（只带 app_id、withdrawal_id 与两个时刻）；在 users 行锁下判定；返回 { scanned, judged }',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const f = buildCheck(h);
      const app = appId();
      const pending = await seed(h.db, app);
      const approved = await seed(h.db, app, {
        status: 'APPROVED',
        reviewDeadline: at(DEADLINE.getTime() - HOUR),
      });
      const exact = await seed(h.db, app, { reviewDeadline: NOW });
      const judged = [pending, approved, exact];

      const result = await f.check.run(NOW);

      expect(result).toStrictEqual({ scanned: 3, judged: 3 });
      for (const w of judged) {
        expect(await judgement(h, w), w.status).toStrictEqual({
          status: w.status,
          overdueAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        });
        expect(await eventsOf(h.observer, w)).toStrictEqual([expectedEvent(w)]);
      }
      expect(await overdueEvents(h.observer)).toHaveLength(3);
      expect(overdueWarns(f.lines)).toHaveLength(3);
      expect(overdueWarns(f.lines)).toEqual(
        expect.arrayContaining(judged.map((w) => expectedWarn(w))),
      );
      // identity's users lock, on the judging transaction, for exactly the withdrawal's member.
      for (const w of judged) {
        expect(f.locks).toContainEqual({
          appId: w.appId,
          userIds: [w.userId],
          inTransaction: true,
        });
      }
      expectNoPersonalData(f.lines, judged);
    });
  },
  TIMEOUT,
);

it(
  '[BR-WDR-26 超时判定] 不判的单：deadline 未到（晚 1 毫秒）、deadline 为空（PENDING_REVIEW / APPROVED）、PAYING、PAID_API、PAID_MANUAL、REJECTED、FAILED（deadline 已过）——列仍 NULL、updated_at 不变，无事件、无告警、不加锁，返回 { scanned: 0, judged: 0 }',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const f = buildCheck(h);
      const app = appId();
      const untouched: Seeded[] = [
        await seed(h.db, app, { reviewDeadline: at(NOW.getTime() + 1) }),
        await seed(h.db, app, { reviewDeadline: null }),
        await seed(h.db, app, { status: 'APPROVED', reviewDeadline: null }),
      ];
      const ended: Status[] = ['PAYING', 'PAID_API', 'PAID_MANUAL', 'REJECTED', 'FAILED'];
      for (const status of ended) untouched.push(await seed(h.db, app, { status }));

      const result = await f.check.run(NOW);

      expect(result).toStrictEqual({ scanned: 0, judged: 0 });
      for (const w of untouched) {
        expect(await judgement(h, w), w.status).toStrictEqual({
          status: w.status,
          overdueAt: null,
          updatedAt: CREATED_AT.toISOString(),
        });
      }
      expect(await overdueEvents(h.observer)).toStrictEqual([]);
      expect(overdueWarns(f.lines)).toStrictEqual([]);
      expect(f.locks).toStrictEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[BR-WDR-26 每单只判定一次] 已判过（review_overdue_at 非空）的单不再判、不再发事件与告警、原判定时刻不变；本次判定的单在下一槽、再下一槽的检查里也不再判',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const app = appId();
      const earlier = at(DEADLINE.getTime() + MINUTE);
      const before = await seed(h.db, app, { reviewOverdueAt: earlier });
      const fresh = await seed(h.db, app);

      const first = buildCheck(h);
      expect(await first.check.run(NOW)).toStrictEqual({ scanned: 1, judged: 1 });
      expect(overdueWarns(first.lines)).toStrictEqual([expectedWarn(fresh)]);

      for (const later of [NOW.getTime() + 5 * MINUTE, NOW.getTime() + 10 * MINUTE]) {
        const again = buildCheck(h);
        again.clock.set(at(later));
        expect(await again.check.run(at(later))).toStrictEqual({ scanned: 0, judged: 0 });
        expect(overdueWarns(again.lines)).toStrictEqual([]);
        expect(again.locks).toStrictEqual([]);
      }

      expect(await judgement(h, before)).toStrictEqual({
        status: 'PENDING_REVIEW',
        overdueAt: earlier.toISOString(),
        updatedAt: CREATED_AT.toISOString(),
      });
      expect((await stored(h.observer, fresh)).reviewOverdueAt).toBe(NOW.toISOString());
      expect(await eventsOf(h.observer, before)).toStrictEqual([]);
      expect(await eventsOf(h.observer, fresh)).toStrictEqual([expectedEvent(fresh)]);
      expect(await overdueEvents(h.observer)).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[BR-WDR-26 超时判定] 多 app 各判各的：一次运行判定所有 app 的到期单，事件信封与告警各带自己的 app_id，行锁按各自 app 加；未到期的单留到到期后的那次运行',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const a = appId();
      const b = appId();
      const userA = await member(h.db, a);
      const inA = [
        await seedWithdrawal(h.db, a, userA),
        await seedWithdrawal(h.db, a, userA, { status: 'APPROVED' }),
      ];
      const inB = [await seed(h.db, b), await seed(h.db, b, { status: 'APPROVED' })];
      const laterB = await seed(h.db, b, { reviewDeadline: at(NOW.getTime() + 3 * MINUTE) });

      const f = buildCheck(h);
      expect(await f.check.run(NOW)).toStrictEqual({ scanned: 4, judged: 4 });
      for (const w of [...inA, ...inB]) {
        expect(await eventsOf(h.observer, w)).toStrictEqual([expectedEvent(w)]);
        expect(f.locks).toContainEqual({
          appId: w.appId,
          userIds: [w.userId],
          inTransaction: true,
        });
      }
      expect(overdueWarns(f.lines)).toHaveLength(4);
      expect(overdueWarns(f.lines)).toEqual(
        expect.arrayContaining([...inA, ...inB].map((w) => expectedWarn(w))),
      );
      expect((await stored(h.observer, laterB)).reviewOverdueAt).toBeNull();

      // The next slot's run (10:12:30 +08:00) judges the one that came due meanwhile, and only it.
      const next = at(NOW.getTime() + 5 * MINUTE);
      const g = buildCheck(h);
      g.clock.set(next);
      expect(await g.check.run(next)).toStrictEqual({ scanned: 1, judged: 1 });
      expect(await eventsOf(h.observer, laterB)).toStrictEqual([expectedEvent(laterB, next)]);
      expect(overdueWarns(g.lines)).toStrictEqual([expectedWarn(laterB, next)]);
      expect(await overdueEvents(h.observer)).toHaveLength(5);
    });
  },
  TIMEOUT,
);

it(
  '[D10-475 ②(b) 提交后告警] 一单的事务提交失败（回滚）：该单列仍 NULL、无事件、无 withdrawal_review_overdue 告警，只有一条 withdrawal_review_overdue_failed（error_name）；其他单照常判定并告警；运行在全部单试完后以首个错误拒绝；下次运行补判该单',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const app = appId();
      // The earliest deadline: the first candidate (ORDER BY review_deadline, id).
      const failing = await seed(h.db, app, { reviewDeadline: at(DEADLINE.getTime() - HOUR) });
      const others = [await seed(h.db, app), await seed(h.db, app, { status: 'APPROVED' })];
      // The commit of the transaction that judged `failing` fails; every other commit goes through.
      const db = faultyCommits(h.db, async (trx) => {
        const row = await sql<{ judged: boolean }>`
          SELECT review_overdue_at IS NOT NULL AS judged FROM app.withdrawals
          WHERE id = ${failing.id}`.execute(trx);
        return row.rows[0]?.judged === true;
      });
      const f = buildCheck(h, { db });

      const error = await rejection(f.check.run(NOW));

      expect(error).toBeInstanceOf(SyntheticCommitFault);
      expect((await stored(h.observer, failing)).reviewOverdueAt).toBeNull();
      expect(await eventsOf(h.observer, failing)).toStrictEqual([]);
      expect(overdueWarns(f.lines).map((line) => line['withdrawal_id'])).not.toContain(failing.id);
      for (const w of others) {
        expect((await stored(h.observer, w)).reviewOverdueAt).toBe(NOW.toISOString());
        expect(await eventsOf(h.observer, w)).toStrictEqual([expectedEvent(w)]);
      }
      expect(overdueWarns(f.lines)).toHaveLength(2);
      expect(overdueWarns(f.lines)).toEqual(
        expect.arrayContaining(others.map((w) => expectedWarn(w))),
      );
      const failed = f.lines.filter(
        (line) => line.level === 'warn' && line.message === FAILED_WARN,
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]?.fields).toEqual(
        expect.objectContaining({ error_name: 'SyntheticCommitFault' }),
      );
      expectNoPersonalData(f.lines, [failing, ...others]);

      // The queue's retry (a plain handle now) judges it, once.
      const retry = buildCheck(h);
      expect(await retry.check.run(NOW)).toStrictEqual({ scanned: 1, judged: 1 });
      expect((await stored(h.observer, failing)).reviewOverdueAt).toBe(NOW.toISOString());
      expect(await eventsOf(h.observer, failing)).toStrictEqual([expectedEvent(failing)]);
      expect(overdueWarns(retry.lines)).toStrictEqual([expectedWarn(failing)]);
    });
  },
  TIMEOUT,
);

it(
  '[D10-475 ②(b) 提交后告警] 事件发布失败（该单事务回滚）：该单列仍 NULL、无事件、无告警，一条 withdrawal_review_overdue_failed；同批其他单不受影响；运行以该错误拒绝',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const app = appId();
      const failing = await seed(h.db, app, { reviewDeadline: at(DEADLINE.getTime() - HOUR) });
      const other = await seed(h.db, app);
      const clock = new FixedClock(NOW);
      const real = eventBus(clock).bus;
      const { logger, lines } = memoryLogger();
      const failure = new Error('synthetic publish failure');
      // The bus rejects the event of `failing` after its own writes (a queue or database error).
      const check = createReviewOverdueCheck({
        db: h.db,
        lockUsersForUpdate: recordingLock().lock,
        eventBus: {
          async publish(trx, event) {
            const published = await real.publish(trx, event);
            if ((event.payload as { withdrawal_id?: unknown }).withdrawal_id === failing.id) {
              throw failure;
            }
            return published;
          },
        },
        clock,
        logger,
      });

      const error = await rejection(check.run(NOW));

      expect(error).toBe(failure);
      expect((await stored(h.observer, failing)).reviewOverdueAt).toBeNull();
      expect(await eventsOf(h.observer, failing)).toStrictEqual([]);
      expect((await stored(h.observer, other)).reviewOverdueAt).toBe(NOW.toISOString());
      expect(await eventsOf(h.observer, other)).toStrictEqual([expectedEvent(other)]);
      expect(overdueWarns(lines)).toStrictEqual([expectedWarn(other)]);
      expect(
        lines.filter((line) => line.level === 'warn' && line.message === FAILED_WARN),
      ).toHaveLength(1);
    });
  },
  TIMEOUT,
);
