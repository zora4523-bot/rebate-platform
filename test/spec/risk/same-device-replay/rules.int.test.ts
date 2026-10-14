import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  accounts,
  closeKit,
  DEDUPE,
  fixture,
  H,
  hits,
  J,
  judgements,
  LIMIT,
  openKit,
  RULE,
  seedRule,
  signal,
  type Kit,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
});

it('[AC-B1-03n#1] 首次未命中也完整落库，判定时刻来自 Clock，无 risk_hits', async () => {
  const f = fixture(kit);
  const [, b] = await accounts(f, 2, H);
  const ref = randomUUID();
  const at = f.clock.now();
  const result = await f.judge(b!, ref);
  expect(result).toEqual({ marked: false, devices: [{ device_hash: H, rank: 2 }] });
  const rows = await judgements(kit.db, f.appId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    app_id: f.appId,
    rule_id: RULE,
    ref_type: 'withdrawal',
    ref_id: ref,
    user_id: b,
    marked: false,
    result,
    judged_at: at,
  });
  expect(typeof rows[0]!.id).toBe('bigint');
  expect(rows[0]!.created_at).toBeInstanceOf(Date);
  expect(await hits(kit.db, f.appId)).toEqual([]);
  expect(f.reads.every(({ handle }) => handle.isTransaction)).toBe(true);
  expect(f.loginReads.every((handle) => handle.isTransaction)).toBe(true);
});

it('[AC-B1-03n#2] 未命中重放不读配置或登录，阈值改变和时钟前进不改变结论', async () => {
  const f = fixture(kit);
  const [, b] = await accounts(f, 2, H);
  const ref = randomUUID();
  const first = await f.judge(b!, ref);
  expect(first.marked).toBe(false);
  const before = await judgements(kit.db, f.appId);
  const reads = f.reads.length;
  const loginReads = f.loginReads.length;
  f.values.set(LIMIT, 2);
  f.clock.set('2026-09-26T00:00:00Z');
  expect(await f.judge(b!, ref)).toEqual(first);
  expect(f.reads).toHaveLength(reads);
  expect(f.loginReads).toHaveLength(loginReads);
  expect(await judgements(kit.db, f.appId)).toEqual(before);
  expect(await hits(kit.db, f.appId)).toEqual([]);
});

it('[AC-B1-03n#3] 命中后窗口、阈值、去重开关及并号改变，完整排名仍原样重放', async () => {
  const f = fixture(kit);
  const [a, b, c] = await accounts(f, 3, H);
  const ref = randomUUID();
  const first = await f.judge(c!, ref);
  expect(first).toEqual({ marked: true, devices: [{ device_hash: H, rank: 3 }] });
  const before = await judgements(kit.db, f.appId);
  const beforeHits = await hits(kit.db, f.appId);
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({ marked: true, result: first, judged_at: f.clock.now() });
  expect(beforeHits).toHaveLength(1);
  // Update only the existing identity fixture data; this exposes recomputation at the old instant.
  await sql`UPDATE app.users SET status = 'deleted', deleted_reason = 'merged'
    WHERE app_id = ${f.appId} AND id = ${b}`.execute(kit.db);
  await sql`INSERT INTO app.user_oauth
    (id, app_id, user_id, provider, union_id, merged_from_user_id, created_at, updated_at)
    VALUES (${randomUUID()}, ${f.appId}, ${a}, 'wechat', ${randomUUID()}, ${b},
      ${f.clock.now()}, ${f.clock.now()})`.execute(kit.db);
  const reads = f.reads.length;
  const loginReads = f.loginReads.length;
  // With dedupe still on, replay must not re-rank the newly merged account.
  expect(await f.judge(c!, ref)).toEqual(first);
  f.clock.set('2026-10-02T00:00:00Z');
  f.values.set(LIMIT, 4);
  f.values.set(DEDUPE, false);
  expect(await f.judge(c!, ref)).toEqual(first);
  expect(f.reads).toHaveLength(reads);
  expect(f.loginReads).toHaveLength(loginReads);
  expect(await judgements(kit.db, f.appId)).toEqual(before);
  expect(await hits(kit.db, f.appId)).toEqual(beforeHits);
});

it.each(['port', 'statement'] as const)(
  '[AC-B1-03n#4] 配置读取失败 %s 按默认 3 持久化，恢复后的真实阈值 2 不改结论',
  async (failure) => {
    const f = fixture(kit);
    const [, b, c] = await accounts(f, 3, H);
    const ref = randomUUID();
    f.values.set(LIMIT, 2);
    (failure === 'port' ? f.failures : f.sqlFailures).add(LIMIT);
    const first = await kit.db.transaction().execute(async (trx) => {
      const answer = await f.judge(b!, ref, trx);
      expect(answer).toEqual({ marked: false, devices: [{ device_hash: H, rank: 2 }] });
      expect((await sql<{ ok: number }>`SELECT 1 AS ok`.execute(trx)).rows[0]?.ok).toBe(1);
      expect(await judgements(trx, f.appId)).toEqual([
        expect.objectContaining({ result: answer, marked: false, judged_at: f.clock.now() }),
      ]);
      expect(await hits(trx, f.appId)).toEqual([]);
      return answer;
    });
    // A third account still hits under the fallback: defaulting must not mean always passing.
    expect((await f.judge(c!)).marked).toBe(true);
    expect(
      f.lines.map((line) => JSON.parse(line) as { level: number; key?: string }),
    ).toContainEqual(expect.objectContaining({ level: 40, key: LIMIT }));
    const rows = await judgements(kit.db, f.appId);
    const hitRows = await hits(kit.db, f.appId);
    expect(hitRows).toEqual([expect.objectContaining({ user_id: c, ref_type: 'withdrawal' })]);
    const reads = f.reads.length;
    f.failures.clear();
    f.sqlFailures.clear();
    f.clock.set('2026-09-26T00:00:00Z');
    expect(await f.judge(b!, ref)).toEqual(first);
    expect(f.reads).toHaveLength(reads);
    expect(await judgements(kit.db, f.appId)).toEqual(rows);
    expect(await hits(kit.db, f.appId)).toEqual(hitRows);
  },
);

it.each([
  { ac: 5, pooled: false },
  { ac: 6, pooled: true },
])(
  '[AC-B1-03n#$ac] 并发 pooled=$pooled：等待期间新设备登录，两个调用仍只认首次结果',
  async ({ pooled }) => {
    const f = fixture(kit);
    const [a, b, c] = await accounts(f, 3, H);
    await f.login(a!, J, '2026-09-01T00:00:00Z');
    await f.login(b!, J, '2026-09-10T00:00:00Z');
    const ref = randomUUID();
    const captured = signal();
    const releaseFirst = signal();
    const newLogin = signal();
    let firstPid = 0;
    let secondEntered = false;
    f.hooks.beforeRead = async (_handle, call) => {
      if (call > 1) {
        secondEntered = true;
        await newLogin.promise;
      }
    };
    f.hooks.afterRead = async (handle, call) => {
      if (call === 1) {
        const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(handle);
        firstPid = pid.rows[0]!.pid;
        captured.release();
        await releaseFirst.promise;
      }
    };
    const invoke = () =>
      pooled ? f.judge(c!, ref) : kit.db.transaction().execute((trx) => f.judge(c!, ref, trx));
    const first = invoke();
    // Attach handlers immediately; even an assertion failure must release both pending calls.
    const pending = [first];
    let completion = Promise.allSettled(pending);
    try {
      await Promise.race([captured.promise, first]);
      expect(firstPid).toBeGreaterThan(0);
      f.clock.set('2026-09-26T00:00:00Z');
      const second = invoke();
      pending.push(second);
      completion = Promise.allSettled(pending);
      // Observe a real PostgreSQL waiter, or detect the incorrect unlocked path without a sleep.
      await expect
        .poll(
          async () => {
            const waiting = await sql<{ waiting: boolean }>`SELECT EXISTS (
        SELECT 1 FROM pg_locks l WHERE NOT l.granted AND l.locktype = 'advisory'
          AND ${firstPid} = ANY(pg_blocking_pids(l.pid))
      ) AS waiting`.execute(kit.db);
            return secondEntered || waiting.rows[0]!.waiting;
          },
          { timeout: 5000 },
        )
        .toBe(true);
      // Third connection commits while the first has read H and the second is still in flight.
      await f.login(c!, J, '2026-09-25T12:00:00Z');
      newLogin.release();
      releaseFirst.release();
      const answers = await Promise.all(pending);
      expect(answers).toEqual([
        { marked: true, devices: [{ device_hash: H, rank: 3 }] },
        { marked: true, devices: [{ device_hash: H, rank: 3 }] },
      ]);
      expect(f.loginReads).toHaveLength(1);
      const rows = await judgements(kit.db, f.appId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        result: answers[0],
        judged_at: new Date('2026-09-25T00:00:00Z'),
      });
      expect((await hits(kit.db, f.appId)).map((row) => row.value_hmac)).toEqual([H]);
    } finally {
      newLogin.release();
      releaseFirst.release();
      await completion;
    }
  },
  20_000,
);

it.each(['repeatable read', 'serializable'] as const)(
  '[AC-B1-03n#7] %s 事务已执行查询后拒绝判定，无配置读取、登录读取或落库',
  async (isolation) => {
    const f = fixture(kit);
    const [, , c] = await accounts(f, 3, H);
    await expect(
      kit.db
        .transaction()
        .setIsolationLevel(isolation)
        .execute(async (trx) => {
          await sql`SELECT count(*) FROM app.login_logs WHERE app_id = ${f.appId}`.execute(trx);
          await f.judge(c!, randomUUID(), trx);
        }),
    ).rejects.toThrow(/read committed/i);
    expect(f.reads).toEqual([]);
    expect(f.loginReads).toEqual([]);
    expect(await judgements(kit.db, f.appId)).toEqual([]);
    expect(await hits(kit.db, f.appId)).toEqual([]);
  },
);

it('[AC-B1-03n#5] 唯一冲突兜底重读已提交结果，不残留败方的命中行', async () => {
  const f = fixture(kit);
  const [, , c] = await accounts(f, 3, H);
  const ref = randomUUID();
  expect(await judgements(kit.db, f.appId)).toEqual([]);
  await seedRule(f, kit, RULE);
  const winner = { marked: false, devices: [{ device_hash: H, rank: 2 }] };
  const at = new Date('2026-09-24T00:00:00Z');
  let injected = false;
  f.hooks.afterRead = async () => {
    // Simulate the independently committed winner after judge's empty lookup. Ordinary callers
    // serialize on the advisory lock; this deliberately reaches the required UNIQUE fallback.
    if (injected) return;
    injected = true;
    await sql`INSERT INTO app.risk_judgements
      (app_id, rule_id, ref_type, ref_id, user_id, marked, result, judged_at)
      VALUES (${f.appId}, ${RULE}, 'withdrawal', ${ref}, ${c}, false,
        ${JSON.stringify(winner)}::jsonb, ${at})`.execute(kit.db);
  };
  expect(await f.judge(c!, ref)).toEqual(winner);
  expect(injected).toBe(true);
  expect(await judgements(kit.db, f.appId)).toEqual([
    expect.objectContaining({ ref_id: ref, result: winner, judged_at: at, marked: false }),
  ]);
  expect(await hits(kit.db, f.appId)).toEqual([]);
});

it('[AC-B1-03n#7] read committed 使用同一事务，结果和命中随调用方回滚', async () => {
  const f = fixture(kit);
  const [, , c] = await accounts(f, 3, H);
  const ref = randomUUID();
  const rollback = new Error('fixture rollback');
  await expect(
    kit.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        await sql`SELECT 1`.execute(trx);
        const result = await f.judge(c!, ref, trx);
        expect(result.marked).toBe(true);
        expect(await judgements(trx, f.appId)).toHaveLength(1);
        expect(await hits(trx, f.appId)).toHaveLength(1);
        expect(f.reads.every(({ handle }) => handle === trx)).toBe(true);
        expect(f.loginReads).toEqual([trx]);
        throw rollback;
      }),
  ).rejects.toBe(rollback);
  expect(await judgements(kit.db, f.appId)).toEqual([]);
  expect(await hits(kit.db, f.appId)).toEqual([]);
  expect((await f.judge(c!, ref)).marked).toBe(true);
  expect(await judgements(kit.db, f.appId)).toHaveLength(1);
});

it('[AC-B1-03n#8] 不同单号重新判定；同单号跨 app_id 不串用结论', async () => {
  const f = fixture(kit);
  const [, b] = await accounts(f, 2, H);
  const ref = randomUUID();
  expect((await f.judge(b!, ref)).marked).toBe(false);
  f.values.set(LIMIT, 2);
  expect((await f.judge(b!)).marked).toBe(true);
  const rows = await judgements(kit.db, f.appId);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.marked)).toEqual([false, true]);
  const foreign = fixture(kit);
  const [, , c] = await accounts(foreign, 3, H);
  expect((await foreign.judge(c!, ref)).marked).toBe(true);
  expect(await judgements(kit.db, foreign.appId)).toEqual([
    expect.objectContaining({ app_id: foreign.appId, user_id: c, ref_id: ref, marked: true }),
  ]);
  expect((await f.judge(b!, ref)).marked).toBe(false);
  expect(await judgements(kit.db, f.appId)).toEqual(rows);
  expect(await hits(kit.db, f.appId)).toHaveLength(1);
  expect(await hits(kit.db, foreign.appId)).toHaveLength(1);
});

it('[AC-B1-03n#8] PG 四列唯一约束拒绝绕过 judge 的重复插入，user_id 不是去重键', async () => {
  const f = fixture(kit);
  const [a, b] = await accounts(f, 2, H);
  const ref = randomUUID();
  await f.judge(b!, ref);
  const rows = await judgements(kit.db, f.appId);
  expect(rows).toHaveLength(1);
  const constraints = await sql<{ columns: string[] }>`SELECT ARRAY(
    SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, position)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    ORDER BY k.position
  ) AS columns FROM pg_constraint c
  WHERE c.conrelid = 'app.risk_judgements'::regclass AND c.contype = 'u'`.execute(kit.db);
  expect(constraints.rows.map((row) => row.columns)).toContainEqual([
    'app_id',
    'rule_id',
    'ref_type',
    'ref_id',
  ]);
  await expect(
    sql`INSERT INTO app.risk_judgements
    (app_id, rule_id, ref_type, ref_id, user_id, marked, result, judged_at)
    SELECT app_id, rule_id, ref_type, ref_id, ${a}::uuid, true,
      '{"marked":true,"devices":[]}'::jsonb, judged_at
    FROM app.risk_judgements WHERE app_id = ${f.appId}`.execute(kit.db),
  ).rejects.toMatchObject({ code: '23505' });
  expect(await judgements(kit.db, f.appId)).toEqual(rows);
});

it('[AC-B1-03n#8] 同 app、同 ref_id 的其他规则或引用类型不得被当作本单结果', async () => {
  const f = fixture(kit);
  const [, b] = await accounts(f, 2, H);
  const ref = randomUUID();
  expect(await judgements(kit.db, f.appId)).toEqual([]);
  const otherRule = 'FIXTURE_OTHER_RULE';
  for (const rule of [RULE, otherRule]) await seedRule(f, kit, rule);
  for (const [rule, type] of [
    [otherRule, 'withdrawal'],
    [RULE, 'order'],
  ] as const) {
    await sql`INSERT INTO app.risk_judgements
      (app_id, rule_id, ref_type, ref_id, user_id, marked, result, judged_at)
      VALUES (${f.appId}, ${rule}, ${type}, ${ref}, ${b}, true,
        '{"marked":true,"devices":[]}'::jsonb, ${f.clock.now()})`.execute(kit.db);
  }
  const result = await f.judge(b!, ref);
  expect(result).toEqual({ marked: false, devices: [{ device_hash: H, rank: 2 }] });
  const rows = await judgements(kit.db, f.appId);
  expect(rows).toHaveLength(3);
  expect(rows.filter((row) => row.rule_id === RULE && row.ref_type === 'withdrawal')).toEqual([
    expect.objectContaining({ result, ref_id: ref }),
  ]);
  expect(await hits(kit.db, f.appId)).toEqual([]);
});

it('[AC-B1-03n#3] 旧 risk_hits 没有判定结果时重新判定，不凭旧命中重放或回填', async () => {
  const f = fixture(kit);
  const [, b] = await accounts(f, 2, H);
  const ref = randomUUID();
  await seedRule(f, kit, RULE);
  await sql`INSERT INTO app.risk_hits
    (app_id, user_id, rule_id, risk_action, dimension, value_hmac, ref_type, ref_id, created_at)
    VALUES (${f.appId}, ${b}, ${RULE}, 'manual_review', 'device', ${H}, 'withdrawal', ${ref},
      ${new Date('2026-09-24T00:00:00Z')})`.execute(kit.db);
  const beforeHits = await hits(kit.db, f.appId);
  const result = await f.judge(b!, ref);
  expect(result).toEqual({ marked: false, devices: [{ device_hash: H, rank: 2 }] });
  expect(await judgements(kit.db, f.appId)).toEqual([
    expect.objectContaining({ result, marked: false, judged_at: f.clock.now() }),
  ]);
  expect(await hits(kit.db, f.appId)).toEqual(beforeHits);
});

it('[AC-B1-03n#9] couli_app 只有插入和读取权，UPDATE / DELETE 拒绝；readonly 可读', async () => {
  const f = fixture(kit);
  const [, b] = await accounts(f, 2, H);
  await f.judge(b!);
  const rows = await judgements(kit.db, f.appId);
  expect(rows).toHaveLength(1);
  await expect(
    sql`UPDATE app.risk_judgements SET marked = true
    WHERE app_id = ${f.appId}`.execute(kit.db),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    sql`DELETE FROM app.risk_judgements
    WHERE app_id = ${f.appId}`.execute(kit.db),
  ).rejects.toMatchObject({ code: '42501' });
  const readonly = createDb({ connectionString: kit.database.urlFor('couli_readonly'), max: 1 });
  try {
    expect(await judgements(readonly, f.appId)).toEqual(rows);
  } finally {
    await destroyDb(readonly);
  }
  expect(await judgements(kit.db, f.appId)).toEqual(rows);
});
