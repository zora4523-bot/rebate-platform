// B2-05n: the judgement under the users lock and against a second worker (规划/02 §18 一致性做法;
// payout AGENTS.md rule 3 加锁顺序 users 行锁在先; task brief §9.2 1 / §9.3 并发: 逐单在 users 行锁下
// 重读，CAS 置 review_overdue_at（0 行跳过、不发事件）; 两个 worker 同槽同单只一个判定). The competing
// transactions run on the observer pool (couli_app) and take identity's lock statement as the
// member's other writers do (SELECT … FOR NO KEY UPDATE on app.users).
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Transaction } from 'kysely';
import { expect, it } from 'vitest';
import {
  NOW,
  TIMEOUT,
  appId,
  buildCheck,
  eventsOf,
  expectedEvent,
  gate,
  member,
  overdueEvents,
  overdueWarns,
  seed,
  seedWithdrawal,
  sleep,
  stored,
  withHarness,
  type Harness,
  type Seeded,
} from './kit.ts';

/** How long a run must stay blocked to count as waiting on the held lock. */
const BLOCKED_MS = 500;

interface Holder {
  readonly locked: Promise<void>;
  readonly release: () => void;
  readonly done: Promise<void>;
}

/**
 * Holds identity's users lock on `userIds` in an observer transaction until `release` is called,
 * then runs `whileHeld` (still inside it) and commits.
 */
function holdUsers(
  h: Harness,
  app: string,
  userIds: readonly string[],
  whileHeld: (trx: Transaction<DB>) => Promise<void> = async () => undefined,
): Holder {
  const locked = gate();
  const release = gate();
  const done = h.observer.transaction().execute(async (trx) => {
    await sql`SELECT id FROM app.users WHERE app_id = ${app} AND id = ANY(${[...userIds]}::uuid[])
      ORDER BY id FOR NO KEY UPDATE`.execute(trx);
    locked.open();
    await release.promise;
    await whileHeld(trx);
  });
  done.catch(() => undefined);
  return { locked: locked.promise, release: release.open, done };
}

/** True once `reached` resolved, false after 10 s. */
function within(reached: Promise<void>): Promise<boolean> {
  return Promise.race([reached.then(() => true), sleep(10_000).then(() => false)]);
}

it(
  '[payout AGENTS.md 加锁顺序; §9.3 并发] 判定在 users 行锁下：该会员的 users 行被另一事务锁住时，检查在请求锁后等待、不写列不发事件；锁释放后才判定',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const app = appId();
      const w = await seed(h.db, app);
      const reached = gate();
      const f = buildCheck(h, { before: async () => reached.open() });
      const holder = holdUsers(h, app, [w.userId]);
      try {
        await holder.locked;
        let settled = false;
        const run = f.check.run(NOW).finally(() => {
          settled = true;
        });
        run.catch(() => undefined);
        expect(await within(reached.promise), 'the check never asked for the users lock').toBe(
          true,
        );
        await sleep(BLOCKED_MS);
        expect(settled, 'the check went on while the member was locked').toBe(false);
        expect((await stored(h.db, w)).reviewOverdueAt).toBeNull();
        expect(await overdueEvents(h.db)).toStrictEqual([]);
        expect(overdueWarns(f.lines)).toStrictEqual([]);

        holder.release();
        await holder.done;
        expect(await run).toStrictEqual({ scanned: 1, judged: 1 });
        expect((await stored(h.observer, w)).reviewOverdueAt).toBe(NOW.toISOString());
        expect(await eventsOf(h.observer, w)).toStrictEqual([expectedEvent(w)]);
        expect(overdueWarns(f.lines)).toHaveLength(1);
      } finally {
        holder.release();
        await holder.done.catch(() => undefined);
      }
    });
  },
  TIMEOUT,
);

it(
  '[BR-WDR-26 判定时状态仍 ∈ {PENDING_REVIEW, APPROVED}] 选出候选之后、拿到 users 行锁之前单子被驳回或进入 PAYING：锁内重读后跳过（CAS 0 行），列仍 NULL、无事件、无告警，judged 为 0',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const app = appId();
      const rejected = await seed(h.db, app);
      const paying = await seed(h.db, app, { status: 'APPROVED' });
      const reached = gate();
      const f = buildCheck(h, { before: async () => reached.open() });
      const holder = holdUsers(h, app, [rejected.userId, paying.userId], async (trx) => {
        await sql`UPDATE app.withdrawals SET status = 'REJECTED', reject_reason_code = 'OTHER',
          reviewed_at = ${NOW}, updated_at = ${NOW} WHERE id = ${rejected.id}`.execute(trx);
        await sql`UPDATE app.withdrawals SET status = 'PAYING', executed_at = ${NOW},
          execute_seq = 1, updated_at = ${NOW} WHERE id = ${paying.id}`.execute(trx);
      });
      try {
        await holder.locked;
        const run = f.check.run(NOW);
        run.catch(() => undefined);
        expect(await within(reached.promise), 'the check never asked for the users lock').toBe(
          true,
        );
        holder.release();
        await holder.done;

        expect(await run).toStrictEqual({ scanned: 2, judged: 0 });
        for (const [w, status] of [
          [rejected, 'REJECTED'],
          [paying, 'PAYING'],
        ] as const) {
          const row = await stored(h.observer, w);
          expect({ status: row.status, at: row.reviewOverdueAt }).toStrictEqual({
            status,
            at: null,
          });
        }
        expect(await overdueEvents(h.observer)).toStrictEqual([]);
        expect(overdueWarns(f.lines)).toStrictEqual([]);
      } finally {
        holder.release();
        await holder.done.catch(() => undefined);
      }
    });
  },
  TIMEOUT,
);

it(
  '[§9.3 并发：两个 worker 同槽同单只一个判定] 两次检查同时运行、都在对方提交前选出同一批候选：每单只被判定一次（一条事件、一条告警、判定时刻不变），两次的 judged 合计等于单数',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const app = appId();
      const seeded: Seeded[] = [];
      for (let i = 0; i < 3; i += 1) {
        const user = await member(h.db, app);
        seeded.push(await seedWithdrawal(h.db, app, user));
        seeded.push(await seedWithdrawal(h.db, app, user, { status: 'APPROVED' }));
      }
      // Both runs reach their first users lock (their candidates are read) before either goes on.
      let arrivals = 0;
      const both = gate();
      const before = async () => {
        arrivals += 1;
        if (arrivals >= 2) both.open();
        await Promise.race([both.promise, sleep(5_000)]);
      };
      const first = buildCheck(h, { before });
      const second = buildCheck(h, { before });

      const [a, b] = await Promise.all([first.check.run(NOW), second.check.run(NOW)]);

      expect(arrivals).toBeGreaterThanOrEqual(2);
      expect(a.judged + b.judged).toBe(seeded.length);
      for (const w of seeded) {
        expect((await stored(h.observer, w)).reviewOverdueAt).toBe(NOW.toISOString());
        expect(await eventsOf(h.observer, w)).toStrictEqual([expectedEvent(w)]);
      }
      expect(await overdueEvents(h.observer)).toHaveLength(seeded.length);
      const warned = [...overdueWarns(first.lines), ...overdueWarns(second.lines)].map((line) =>
        String(line['withdrawal_id']),
      );
      expect(warned.sort()).toStrictEqual(seeded.map((w) => w.id).sort());
    });
  },
  TIMEOUT,
);
