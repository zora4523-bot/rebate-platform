import { accountingDate } from '@couli/domain';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AT,
  NEXT,
  appId,
  close,
  insert,
  open,
  ready,
  reward,
  type Connection,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open();
});
afterAll(async () => {
  await close(h);
});

it('[AC-CT-25b#12] 预算默认计数为零、金额是 bigint，日期行与总量按 app/period 唯一', async () => {
  await ready(h.app);
  const app = appId();
  await h.app.transaction().execute(async (trx) => {
    const now = (await sql<{ at: Date }>`SELECT transaction_timestamp() AS at`.execute(trx))
      .rows[0]!.at;
    expect(
      await insert(trx, 'invite_reward_budgets', { app_id: app, period: 'total' }),
    ).toMatchObject({ reserved_fen: 0n, granted_fen: 0n, row_version: 0, updated_at: now });
  });
  await expect(
    insert(h.app, 'invite_reward_budgets', { app_id: app, period: 'total' }),
  ).rejects.toMatchObject({ code: '23505' });
  for (const [app_id, period] of [
    [app, '2026-10-19'],
    [app, '2026-10-20'],
    [appId(), 'total'],
  ]) {
    expect(
      await insert(h.app, 'invite_reward_budgets', {
        app_id,
        period,
        granted_fen: 9007199254740993n,
      }),
    ).toMatchObject({ app_id, period, reserved_fen: 0n, granted_fen: 9007199254740993n });
    await expect(insert(h.app, 'invite_reward_budgets', { app_id, period })).rejects.toMatchObject({
      code: '23505',
    });
  }
  expect(
    await insert(h.app, 'invite_reward_budgets', {
      app_id: appId(),
      period: 'total',
      reserved_fen: 9007199254740993n,
    }),
  ).toMatchObject({ reserved_fen: 9007199254740993n });
});

it('[AC-CT-25b#13] 非法 period、负计数和日期行占用在 INSERT/UPDATE 均被 CHECK 拒绝', async () => {
  await ready(h.app);
  for (const changes of [
    ...[
      'Total',
      '',
      '2026-1-01',
      '2026-01-1',
      '20260101',
      '2026-10-19T00:00:00+08:00',
      ' 2026-10-19',
    ].map((period) => ({ period })),
    { reserved_fen: -1n },
    { granted_fen: -1n },
    { period: '2026-10-19', reserved_fen: 1n },
  ]) {
    await expect(
      insert(h.app, 'invite_reward_budgets', {
        app_id: appId(),
        period: 'total',
        ...changes,
      }),
    ).rejects.toMatchObject({ code: '23514' });
  }
  // The ruling specifies the YYYY-MM-DD shape, not calendar-date validation in SQL.
  const app = appId();
  for (const period of ['total', '2026-10-19']) {
    await insert(h.app, 'invite_reward_budgets', { app_id: app, period });
    for (const column of ['reserved_fen', 'granted_fen']) {
      await expect(
        sql`UPDATE app.invite_reward_budgets SET ${sql.ref(column)} = -1
        WHERE app_id = ${app} AND period = ${period}`.execute(h.app),
      ).rejects.toMatchObject({ code: '23514' });
    }
  }
  await expect(
    sql`UPDATE app.invite_reward_budgets SET reserved_fen = 1
    WHERE app_id = ${app} AND period = '2026-10-19'`.execute(h.app),
  ).rejects.toMatchObject({ code: '23514' });
});

it('[AC-CT-25b#14] 两个真实并发事务争总量或日预算时只允许一次扣减', async () => {
  await ready(h.app);
  for (const period of ['total', '2026-10-20']) {
    const app = appId();
    await insert(h.app, 'invite_reward_budgets', {
      app_id: app,
      period,
      reserved_fen: period === 'total' ? 20n : 0n,
      granted_fen: 30n,
    });
    const gate = Promise.withResolvers<void>();
    let arrived = 0;
    const compete = () =>
      h.app
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx) => {
          // Both transactions acquire separate pool connections before either UPDATE is issued.
          arrived += 1;
          if (arrived === 2) gate.resolve();
          await gate.promise;
          await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
          const changed =
            period === 'total'
              ? await sql`UPDATE app.invite_reward_budgets
            SET reserved_fen = reserved_fen + ${40n}, row_version = row_version + 1, updated_at = ${AT}
            WHERE app_id = ${app} AND period = 'total'
              AND reserved_fen + granted_fen + ${40n} <= ${100n} RETURNING app_id`.execute(trx)
              : await sql`UPDATE app.invite_reward_budgets
            SET granted_fen = granted_fen + ${40n}, row_version = row_version + 1, updated_at = ${AT}
            WHERE app_id = ${app} AND period = ${period}
              AND granted_fen + ${40n} <= ${100n} RETURNING app_id`.execute(trx);
          return changed.rows.length;
        })
        .catch((error: unknown) => {
          gate.resolve();
          throw error;
        });
    const results = await Promise.allSettled([compete(), compete()]);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])).sort()).toEqual([
      0, 1,
    ]);
    const saved = await sql`SELECT reserved_fen, granted_fen, row_version, updated_at
      FROM app.invite_reward_budgets WHERE app_id = ${app} AND period = ${period}`.execute(h.app);
    expect(saved.rows).toEqual([
      {
        reserved_fen: period === 'total' ? 60n : 0n,
        granted_fen: period === 'total' ? 30n : 70n,
        row_version: 1,
        updated_at: AT,
      },
    ]);
  }
}, 20_000);

it('[AC-CT-25b#15] 总预算把占用与已发放都算入，恰好用满可成功，超一分保持原值', async () => {
  await ready(h.app);
  const app = appId();
  await insert(h.app, 'invite_reward_budgets', {
    app_id: app,
    period: 'total',
    reserved_fen: 20n,
    granted_fen: 30n,
  });
  for (const [need, count] of [
    [50n, 1],
    [1n, 0],
  ] as const) {
    const result = await sql`UPDATE app.invite_reward_budgets
      SET reserved_fen = reserved_fen + ${need}, row_version = row_version + 1
      WHERE app_id = ${app} AND period = 'total'
        AND reserved_fen + granted_fen + ${need} <= ${100n} RETURNING app_id`.execute(h.app);
    expect(result.rows).toHaveLength(count);
  }
  const saved = await sql`SELECT reserved_fen, granted_fen, row_version
    FROM app.invite_reward_budgets WHERE app_id = ${app}`.execute(h.app);
  expect(saved.rows).toEqual([{ reserved_fen: 70n, granted_fen: 30n, row_version: 1 }]);
});

it('[AC-CT-25b#16] +08:00 午夜前后使用独立日计数，不受数据库会话时区影响', async () => {
  await ready(h.app);
  const app = appId();
  const days = [accountingDate(AT), accountingDate(NEXT)];
  expect(days).toEqual(['2026-10-19', '2026-10-20']);
  for (const period of days) await insert(h.app, 'invite_reward_budgets', { app_id: app, period });
  await h.app.transaction().execute(async (trx) => {
    await sql`SET LOCAL TIME ZONE 'UTC'`.execute(trx);
    for (const [period, need, count] of [
      [days[0], 100n, 1],
      [days[0], 1n, 0],
      [days[1], 100n, 1],
    ] as const) {
      const result =
        await sql`UPDATE app.invite_reward_budgets SET granted_fen = granted_fen + ${need}
        WHERE app_id = ${app} AND period = ${period}
          AND granted_fen + ${need} <= ${100n} RETURNING app_id`.execute(trx);
      expect(result.rows).toHaveLength(count);
    }
  });
  const saved = await sql`SELECT period, reserved_fen, granted_fen
    FROM app.invite_reward_budgets WHERE app_id = ${app} ORDER BY period`.execute(h.app);
  expect(saved.rows).toEqual(
    days.map((period) => ({ period, reserved_fen: 0n, granted_fen: 100n })),
  );
});

it('[AC-CT-25b#17] 资格写入失败回滚总量占用，发放失败回滚两表，成功支持占用转发放及释放', async () => {
  await ready(h.app);
  const row = await reward(h.app);
  const app = row['app_id'];
  await insert(h.app, 'invite_rewards', row);
  for (const period of ['total', '2026-10-20']) {
    await insert(h.app, 'invite_reward_budgets', {
      app_id: app,
      period,
      reserved_fen: period === 'total' ? 200n : 0n,
      updated_at: AT,
    });
  }
  await expect(
    h.app.transaction().execute(async (trx) => {
      const reserved =
        await sql`UPDATE app.invite_reward_budgets SET reserved_fen = reserved_fen + ${200n}
      WHERE app_id = ${app} AND period = 'total'
        AND reserved_fen + granted_fen + ${200n} <= ${500n} RETURNING app_id`.execute(trx);
      expect(reserved.rows).toHaveLength(1);
      await insert(trx, 'invite_rewards', row);
    }),
  ).rejects.toMatchObject({ code: '23505' });
  const snapshot = async () =>
    (
      await sql`SELECT period, reserved_fen, granted_fen
    FROM app.invite_reward_budgets WHERE app_id = ${app} ORDER BY period`.execute(h.app)
    ).rows;
  const before = [
    { period: '2026-10-20', reserved_fen: 0n, granted_fen: 0n },
    { period: 'total', reserved_fen: 200n, granted_fen: 0n },
  ];
  expect(await snapshot()).toEqual(before);
  // Test transaction compatibility, not an implementation of the B1-35 award decision.
  const transfer = async (trx: Connection) => {
    const daily = await sql`UPDATE app.invite_reward_budgets SET granted_fen = granted_fen + ${100n}
      WHERE app_id = ${app} AND period = '2026-10-20'
        AND granted_fen + ${100n} <= ${100n} RETURNING app_id`.execute(trx);
    expect(daily.rows).toHaveLength(1);
    const total = await sql`UPDATE app.invite_reward_budgets
      SET reserved_fen = reserved_fen - ${100n}, granted_fen = granted_fen + ${100n}
      WHERE app_id = ${app} AND period = 'total' AND reserved_fen >= ${100n}
      RETURNING app_id`.execute(trx);
    expect(total.rows).toHaveLength(1);
  };
  await expect(
    h.app.transaction().execute(async (trx) => {
      await transfer(trx);
      await sql`UPDATE app.invite_rewards SET status = 'processed'
      WHERE app_id = ${app}`.execute(trx); // Missing both results: reject and roll back the budget writes.
    }),
  ).rejects.toMatchObject({ code: '23514' });
  expect(await snapshot()).toEqual(before);
  await h.app.transaction().execute(async (trx) => {
    await transfer(trx);
    const released =
      await sql`UPDATE app.invite_reward_budgets SET reserved_fen = reserved_fen - ${100n}
      WHERE app_id = ${app} AND period = 'total' AND reserved_fen >= ${100n} RETURNING app_id`.execute(
        trx,
      );
    expect(released.rows).toHaveLength(1);
    const processed = await sql`UPDATE app.invite_rewards SET status = 'processed',
      inviter_result = 'granted', invitee_result = 'skipped', invitee_skip_reason = 'same_ip',
      granted_at = ${NEXT}, row_version = row_version + 1 WHERE app_id = ${app} RETURNING status`.execute(
      trx,
    );
    expect(processed.rows).toEqual([{ status: 'processed' }]);
  });
  expect(await snapshot()).toEqual([
    { period: '2026-10-20', reserved_fen: 0n, granted_fen: 100n },
    { period: 'total', reserved_fen: 0n, granted_fen: 100n },
  ]);
});
