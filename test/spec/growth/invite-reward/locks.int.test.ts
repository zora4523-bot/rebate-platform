import { PostgresQueryCompiler, type Kysely } from 'kysely';
import type { DB } from '@couli/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture, growth, openDatabase, PAID, type Database } from './kit.ts';

let database: Database;
beforeAll(async () => {
  database = await openDatabase();
}, 180_000);
afterAll(async () => {
  await database?.close();
});

function trace(db: Kysely<DB>) {
  const queries: { sql: string; parameters: readonly unknown[] }[] = [];
  return {
    queries,
    db: db.withPlugin({
      transformQuery({ node, queryId }) {
        queries.push(new PostgresQueryCompiler().compileQuery(node, queryId));
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    }),
  };
}

function lockIndex(
  queries: ReturnType<typeof trace>['queries'],
  table: string,
  parameters: readonly string[],
) {
  const index = queries.findIndex(
    (q) => q.sql.includes(`"${table}"`) && /\bfor (?:no key )?update\b/i.test(q.sql),
  );
  expect(index, `${table} 必须取得行锁`).toBeGreaterThanOrEqual(0);
  expect(queries[index]?.parameters.flat()).toEqual(expect.arrayContaining([...parameters]));
  return index;
}

// Review §11 allows SQL lock assertions instead of timing-sensitive Promise.all races.
// Capture the actual transaction passed to qualification, not only the factory's db handle.
it.each(['original', 'other'] as const)(
  '[AC-B1-35#10] 资格抢最后额度：%s 先到，共享总预算受行锁或条件更新保护',
  async (first) => {
    const f = await fixture(database);
    f.settings.set('total_budget_fen', 2300);
    await f.db
      .insertInto('invite_reward_budgets')
      .values({ app_id: f.appId, period: 'total', granted_fen: 300n })
      .execute();
    const otherInviter = await f.user();
    const otherInvitee = await f.user(otherInviter);
    const original = { ...f.qualifyInput, invitee_id: f.invitee };
    const other = { ...original, inviter_id: otherInviter, invitee_id: otherInvitee };
    const attempts = first === 'original' ? [original, other] : [other, original];
    const traced = trace(f.db);
    const qualifier = (await growth()).createInviteRewardQualifier({ ...f.deps, db: traced.db });
    for (const [attempt, input] of attempts.entries()) {
      traced.queries.length = 0;
      await traced.db.transaction().execute((trx) => qualifier.qualifyInviteReward(trx, input));
      if (attempt === 0) {
        // Both UPDATE and INSERT ... ON CONFLICT DO UPDATE may reserve the budget.
        const protectedReservation = traced.queries.some((q, index) => {
          if (
            !q.sql.includes('"invite_reward_budgets"') ||
            !/\bupdate\b[\s\S]*?\bset\b[\s\S]*?"reserved_fen"\s*=/i.test(q.sql)
          ) {
            return false;
          }
          const lockedTotal = traced.queries
            .slice(0, index)
            .some(
              (prior) =>
                prior.sql.includes('"invite_reward_budgets"') &&
                /\bfor (?:no key )?update\b/i.test(prior.sql) &&
                prior.parameters.includes(f.appId) &&
                prior.parameters.includes('total'),
            );
          const where = q.sql.split(/\bwhere\b/i).at(-1) ?? '';
          const whereParameters = [...where.matchAll(/\$(\d+)\b/g)].map((match) =>
            String(q.parameters[Number(match[1]) - 1]),
          );
          const includesReservation =
            whereParameters.includes('2000') ||
            (/(?:(?:"excluded"|excluded)\.)"reserved_fen"/i.test(where) &&
              q.parameters.some((value) => String(value) === '2000'));
          const conditionalReservation =
            /\bwhere\b/i.test(q.sql) &&
            where.includes('"reserved_fen"') &&
            where.includes('"granted_fen"') &&
            /<=|>=/.test(where) &&
            includesReservation &&
            whereParameters.includes('2300');
          return lockedTotal || conditionalReservation;
        });
        expect(protectedReservation, '占用前锁住共享 total 行，或在占用语句中校验可用额').toBe(
          true,
        );
      } else {
        expect(await f.row(input.invitee_id)).toBeUndefined();
      }
      expect(await f.budget()).toMatchObject({ reserved_fen: 2000n, granted_fen: 300n });
    }
    expect(await f.row(attempts[0]!.invitee_id)).toMatchObject({
      status: 'qualified',
      row_version: 0,
    });
    expect(await f.row(attempts[1]!.invitee_id)).toBeUndefined();
    expect(await f.budget()).toMatchObject({ reserved_fen: 2000n, granted_fen: 300n });
  },
);

it('[AC-B1-35#35] 过期重判前锁账户和资格，预算锁在后；重放只释放一次、版本只增一次', async () => {
  const f = await fixture(database);
  await f.seedReward();
  const other = await f.user(f.inviter);
  await f.seedReward({ invitee_id: other, qualified_at: new Date(PAID) });
  f.clock.set(PAID);
  const traced = trace(f.db);
  const windowReads: number[] = [];
  const expiry = (await growth()).createInviteRewardExpiry({
    ...f.deps,
    db: traced.db,
    orders: {
      ...f.deps.orders,
      listSelfOrdersInWindow: async (trx, input) => {
        windowReads.push(traced.queries.length);
        return f.deps.orders.listSelfOrdersInWindow(trx, input);
      },
    },
  });
  await expiry.expireIfDue(f.appId, f.invitee);
  const users = lockIndex(traced.queries, 'users', [f.appId, f.inviter, f.invitee]);
  const reward = lockIndex(traced.queries, 'invite_rewards', [f.appId, f.invitee]);
  const budget = lockIndex(traced.queries, 'invite_reward_budgets', [f.appId, 'total']);
  const release = traced.queries.findIndex((q) =>
    /update .*"invite_reward_budgets" set/i.test(q.sql),
  );
  expect(reward).toBeGreaterThan(users);
  expect(windowReads).toHaveLength(1);
  expect(windowReads[0]).toBeGreaterThan(reward);
  expect(budget).toBeGreaterThan(reward);
  expect(release).toBeGreaterThan(budget);
  expect(await f.row()).toMatchObject({ status: 'expired', row_version: 1 });
  expect(await f.budget()).toMatchObject({ reserved_fen: 2000n, granted_fen: 0n });
  await expiry.expireIfDue(f.appId, f.invitee);
  expect(await f.row()).toMatchObject({ status: 'expired', row_version: 1 });
  expect(await f.row(other)).toMatchObject({ status: 'qualified', row_version: 0 });
  expect(await f.budget()).toMatchObject({ reserved_fen: 2000n, granted_fen: 0n });
  expect(f.grants).toEqual([]);
});
